import fs from 'node:fs'
import path from 'node:path'

const LOCK_STALE_MS = 15000
const LOCK_WAIT_MS = 3000
const EPISODE_MAX_CHARS = 800

/**
 * 三层磁盘形态（照 dsh-fish 的分法：可信源 / 派生品 / 原材料）：
 *
 *   episodes.jsonl  原材料：对话片段。可剪枝，丢了不影响人格。
 *   signals.jsonl   唯一可信源：只追加，不删不改。人格从这里重算。
 *   persona.json    派生缓存：随时可删，下次读会由信号流重建，内容一致。
 *
 * 为什么把「信号流」当唯一可信源：人格必须是历史决定的，不能是某次写入的
 * 覆盖结果。想改她的看法只能追加一条新记录（或撤回旧记录），
 * 而不是把 state.traits 里的数字改掉 —— 这样「过去无法更改」才是真的。
 * 没有信号流之前，persona.json 是可变的，一次误写就把历史抹平了。
 */

export const RECORD_OPS = Object.freeze(['signal', 'retract', 'unpin', 'name', 'voice', 'summary'])

export function emptyCache(now = Date.now()) {
  return {
    version: 2,
    derivedAt: now,
    records: 0,
    name: '',
    voice: '',
    summary: '',
    traits: [],
  }
}

/** 把任意来源的缓存补齐；坏条目丢掉不抛错。 */
export function normalizeCache(raw, now = Date.now()) {
  const base = emptyCache(now)
  if (!raw || typeof raw !== 'object') return base
  const traits = Array.isArray(raw.traits) ? raw.traits.filter((t) => t && typeof t.text === 'string') : []
  return {
    ...base,
    version: 2,
    derivedAt: Number(raw.derivedAt) || now,
    records: Number(raw.records) || 0,
    name: typeof raw.name === 'string' ? raw.name : '',
    voice: typeof raw.voice === 'string' ? raw.voice : '',
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    traits,
  }
}

const clean = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

export class PersonaStore {
  constructor(dir) {
    this.dir = dir
    fs.mkdirSync(dir, { recursive: true })
    this.recordsFile = path.join(dir, 'signals.jsonl')
    this.episodeFile = path.join(dir, 'episodes.jsonl')
    this.cacheFile = path.join(dir, 'persona.json')
    this.runtimeFile = path.join(dir, 'runtime.json')
    this.lockFile = path.join(dir, '.lock')
    this._recordsCache = { key: '', records: [] }
    this._lastRecordSeq = 0
    this._lastEpisodeId = this._readLastId(this.episodeFile, 'ep_')
  }

  // ------------------------------------------------------------------ 锁

  _lock() {
    const deadline = Date.now() + LOCK_WAIT_MS
    for (;;) {
      try {
        const fd = fs.openSync(this.lockFile, 'wx')
        fs.writeSync(fd, String(process.pid))
        fs.closeSync(fd)
        return true
      } catch (e) {
        if (e.code !== 'EEXIST') return false
        try {
          const st = fs.statSync(this.lockFile)
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
            fs.unlinkSync(this.lockFile) // 上个进程崩了，清掉陈旧锁
            continue
          }
        } catch {
          /* 锁刚好被释放，重试 */
        }
        if (Date.now() > deadline) return false
      }
    }
  }

  _unlock() {
    try {
      fs.unlinkSync(this.lockFile)
    } catch {
      /* 已被清理 */
    }
  }

  _atomicWrite(file, text) {
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, text, 'utf8')
    fs.renameSync(tmp, file) // 原子替换：读到一半不会看到半份 JSON
  }

  _readLastId(file, prefix) {
    try {
      const text = fs.readFileSync(file, 'utf8')
      const lines = text.trimEnd().split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].trim()) continue
        const row = JSON.parse(lines[i])
        if (typeof row.id === 'string' && row.id.startsWith(prefix)) {
          const n = Number(row.id.slice(prefix.length))
          if (Number.isFinite(n)) return n
        }
        break
      }
    } catch {
      /* 文件还不存在 */
    }
    return 0
  }

  _nextSeq() {
    const seq = Math.max(Date.now() * 1000, this._lastRecordSeq + 1)
    this._lastRecordSeq = seq
    return seq
  }

  // ------------------------------------------------------------ 信号流

  /**
   * 读全部记录（按写入顺序）。用 size+mtime 做缓存：
   * 提示词每轮组装都会调用，不能每次都重解一遍 JSONL。
   */
  records() {
    let st
    try {
      st = fs.statSync(this.recordsFile)
    } catch {
      return []
    }
    const key = `${st.size}:${st.mtimeMs}`
    if (this._recordsCache.key === key) return this._recordsCache.records

    const rows = []
    try {
      const text = fs.readFileSync(this.recordsFile, 'utf8')
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try {
          const row = JSON.parse(line)
          if (!row || typeof row.op !== 'string' || !RECORD_OPS.includes(row.op)) continue
          if (typeof row.id !== 'string') continue
          rows.push(row)
        } catch {
          /* 跳过损坏行，不阻塞 */
        }
      }
    } catch {
      return []
    }
    // 以 id 里的序号为准恢复自增，避免多进程分配出同一个 id
    for (const row of rows) {
      const n = Number(row.id.slice(3))
      if (Number.isFinite(n) && n > this._lastRecordSeq) this._lastRecordSeq = n
    }
    this._recordsCache = { key, records: rows }
    return rows
  }

  /** 追加一条或多条记录。op 见 RECORD_OPS；返回落盘后的记录（含 id / ts）。 */
  appendRecords(op, rows, now = Date.now()) {
    if (!RECORD_OPS.includes(op)) throw new Error(`未知 op：${op}`)
    const written = []
    for (const row of Array.isArray(rows) ? rows : [rows]) {
      const record = { id: `sg_${this._nextSeq().toString(36)}`, ts: now, op }
      if (op === 'signal') {
        record.text = clean(row.text, 200)
        if (record.text.length < 2) continue
        record.dimension = clean(row.dimension, 16) || '性格'
        record.weight = Math.min(1, Math.max(0.05, Number(row.weight) || 0.5))
        record.source = ['distill', 'tool', 'human', 'migrated'].includes(row.source) ? row.source : 'tool'
        if (row.verdict === 'confirm' || row.verdict === 'refute') record.verdict = row.verdict
        if (row.pinned === true) record.pinned = true
        if (Number.isFinite(Number(row.carriedMentions))) {
          record.carriedMentions = Math.max(1, Math.min(99, Number(row.carriedMentions)))
        }
        if (Array.isArray(row.refs)) record.refs = row.refs.filter((r) => typeof r === 'string').slice(0, 8)
      } else if (op === 'retract') {
        record.targets = (Array.isArray(row.targets) ? row.targets : []).filter((t) => typeof t === 'string').slice(0, 200)
        record.match = clean(row.match, 60)
        record.why = clean(row.why, 120)
        if (!record.targets.length && !record.match) continue
      } else if (op === 'unpin') {
        record.match = clean(row.match, 60)
        if (!record.match) continue
      } else {
        record.value = clean(row.value, op === 'summary' ? 300 : op === 'voice' ? 120 : 40)
        if (!record.value) continue
        // 人工写下的设定会一直压着自动写下的（见 persona.deriveSignals）
        record.source = row.source === 'human' ? 'human' : 'auto'
      }
      written.push(record)
    }
    if (!written.length) return []

    const locked = this._lock()
    try {
      fs.appendFileSync(this.recordsFile, written.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
    } finally {
      if (locked) this._unlock()
    }
    this._recordsCache.key = '' // 让下次读到新内容
    return written
  }

  countRecords() {
    return this.records().length
  }

  hasRecords() {
    return this.countRecords() > 0
  }

  // ---------------------------------------------------------------- 缓存

  readCache(now = Date.now()) {
    try {
      return normalizeCache(JSON.parse(fs.readFileSync(this.cacheFile, 'utf8')), now)
    } catch {
      return null
    }
  }

  writeCache(model, now = Date.now()) {
    const text = JSON.stringify({ version: 2, derivedAt: now, ...model }, null, 2) + '\n'
    try {
      this._atomicWrite(this.cacheFile, text)
    } catch {
      /* 缓存写不进去不是致命的：下次照样能重算 */
    }
  }

  // -------------------------------------------------------------- 运行状态
  // 插件自己的账本（提炼游标、失败次数）。**不是可信源**，也不属于她：
  // 它坏了不影响人格，删了最多让下一次提炼重读一段对话。

  runtime() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.runtimeFile, 'utf8'))
      return {
        lastEpisodeId: Number(raw.lastEpisodeId) || 0,
        lastDistillAt: Number(raw.lastDistillAt) || 0,
        distillRuns: Number(raw.distillRuns) || 0,
        distillFailures: Number(raw.distillFailures) || 0,
        lastError: typeof raw.lastError === 'string' ? raw.lastError.slice(0, 300) : '',
      }
    } catch {
      return { lastEpisodeId: 0, lastDistillAt: 0, distillRuns: 0, distillFailures: 0, lastError: '' }
    }
  }

  saveRuntime(patch) {
    const next = { ...this.runtime(), ...(patch || {}) }
    try {
      this._atomicWrite(this.runtimeFile, JSON.stringify(next, null, 2) + '\n')
    } catch {
      /* ignore */
    }
    return next
  }

  // ---------------------------------------------------------------- 片段

  _readEpisodes() {
    let text
    try {
      text = fs.readFileSync(this.episodeFile, 'utf8')
    } catch {
      return []
    }
    const rows = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line)
        if (!row || typeof row.text !== 'string' || !row.text.trim()) continue
        rows.push(row)
      } catch {
        /* 跳过损坏行 */
      }
    }
    return rows
  }

  _nextEpisodeId() {
    const id = Math.max(Date.now() * 1000, this._lastEpisodeId + 1)
    this._lastEpisodeId = id
    return id
  }

  appendEpisodes(rows) {
    const written = []
    let buf = ''
    for (const row of Array.isArray(rows) ? rows : []) {
      const text = String(row?.text ?? '').replace(/\s+/g, ' ').trim()
      if (!text) continue
      const record = {
        id: this._nextEpisodeId(),
        ts: Number(row.ts) || Date.now(),
        sessionId: String(row.sessionId || ''),
        role: row.role === 'assistant' ? 'assistant' : 'user',
        text: text.slice(0, EPISODE_MAX_CHARS),
      }
      written.push(record)
      buf += JSON.stringify(record) + '\n'
    }
    if (!buf) return written
    try {
      fs.appendFileSync(this.episodeFile, buf, 'utf8')
    } catch {
      return [] // 写不进去不该炸会话：让提炼跳过这一轮
    }
    return written
  }

  recentEpisodes(limit = 40, { sinceId = 0 } = {}) {
    const rows = this._readEpisodes().filter((r) => Number(r.id) > sinceId)
    const n = Math.max(1, Math.min(500, Number(limit) || 40))
    return rows.slice(-n)
  }

  countEpisodes() {
    return this._readEpisodes().length
  }

  pruneEpisodes({ keepDays = 30, maxRows = 5000, now = Date.now() } = {}) {
    const rows = this._readEpisodes()
    const cutoff = now - Math.max(1, keepDays) * 86400000
    let kept = rows.filter((r) => Number(r.ts) >= cutoff)
    if (kept.length > maxRows) kept = kept.slice(-maxRows)
    if (kept.length === rows.length) return 0
    const locked = this._lock()
    try {
      this._atomicWrite(this.episodeFile, kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''))
    } finally {
      if (locked) this._unlock()
    }
    return rows.length - kept.length
  }

  stats(now = Date.now()) {
    const records = this.records()
    return {
      dir: this.dir,
      recordsFile: this.recordsFile,
      cacheFile: this.cacheFile,
      episodeFile: this.episodeFile,
      episodes: this.countEpisodes(),
      records: records.length,
      signals: records.filter((r) => r.op === 'signal').length,
      retracts: records.filter((r) => r.op === 'retract').length,
      oldestRecordAt: records.length ? records[0].ts : 0,
      cacheAge: this.readCache(now)?.derivedAt || 0,
    }
  }
}
