/**
 * persona.js —— 人格的规则：纯函数，不碰磁盘、不碰网络。
 *
 * 输入是**信号流**（store.records()），输出是「此刻的她」。没有可变状态，
 * 所以删掉 persona.json 重算一百次，结果都一样 —— 人格是历史算出来的，
 * 不是某次写入覆盖出来的。
 *
 * 三个概念，别混：
 *   signal  一条证据（一句话 + 重量）。写完就不改了。
 *   trait   证据按相似度聚出来的条目。mentions 是它被提过几次。
 *   solid   站住的条目：提过 3 次、或被验证 2 次、或人工钉住。
 *           站住的条目**不随半衰期沉下去**（这正是「反复想起的事不会淡掉」）。
 *
 * 一条硬规矩（学 dsh-fish）：**人格卡里不出现任何数字与分数**。
 * 数字是插件自己的记账工具；让她看见分数，她就会照着分数演。
 */

export const DEFAULTS = Object.freeze({
  solidMentions: 3,
  solidVerified: 2,
  halfLifeDays: 30,
  floor: 0.12,
  maxTraits: 16,
  similarity: 0.62,
  maxFoldedShown: 3,
})

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/** 权重和 → 强度。单次 0.6 ≈ 0.31，三次 0.6 ≈ 0.65，五次 ≈ 0.83。饱和、单调、与顺序无关。 */
export function strengthOf(sumWeight) {
  const w = Math.max(0, Number(sumWeight) || 0)
  return clamp(1 - Math.pow(0.55, w), 0, 0.99)
}

/** 没被固化的条目会淡：按半衰期从 lastSeen 衰减到现在（纯计算，不改数据）。 */
export function decayedScore(trait, now = Date.now(), halfLifeDays = DEFAULTS.halfLifeDays) {
  if (!trait) return 0
  const half = Math.max(1, Number(halfLifeDays) || DEFAULTS.halfLifeDays)
  const since = Number.isFinite(trait.lastSeen) ? trait.lastSeen : now
  const days = Math.max(0, (now - since) / 86400000)
  const base = Number.isFinite(trait.score) ? trait.score : strengthOf(trait.sumWeight)
  return clamp(base * Math.pow(0.5, days / half), 0, 0.99)
}

export function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

function bigrams(s) {
  const out = new Set()
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
  if (s.length === 1) out.add(s)
  return out
}

/** Dice 系数。中文按二字组比，够用且不引依赖。 */
export function similarity(a, b) {
  const x = normalizeText(a)
  const y = normalizeText(b)
  if (!x || !y) return 0
  if (x === y) return 1
  const bx = bigrams(x)
  const by = bigrams(y)
  if (!bx.size || !by.size) return 0
  let hit = 0
  for (const g of bx) if (by.has(g)) hit++
  return (2 * hit) / (bx.size + by.size)
}

function findTrait(traits, text, threshold) {
  let best = null
  let bestScore = 0
  for (const t of traits) {
    const s = similarity(t.text, text)
    if (s > bestScore) {
      bestScore = s
      best = t
    }
  }
  return bestScore >= threshold ? best : null
}

/**
 * 信号流 → 此刻的她。
 *
 * 认三种「改写历史」的记录，都只追加、不回头改旧行：
 *   retract  撤回：按 id 精确撤回，或按文字片段撤回（含在该片段之前的所有证据）
 *   unpin    解除人工钉住（钉住之后自动证据改不动她，所以要显式解除）
 *   name / voice / summary  人工设定优先：一旦由人写下，后面的自动提炼顶不掉它
 */
export function deriveSignals(records, options = {}) {
  const opts = { ...DEFAULTS, ...options }
  const now = opts.now ?? Date.now()
  const rows = Array.isArray(records) ? records : []

  // ---- 撤回与解除 ----
  const retractedIds = new Set()
  const retractMatches = []
  const unpinMatches = []
  for (const r of rows) {
    if (r.op === 'retract') {
      for (const id of r.targets || []) retractedIds.add(id)
      if (r.match) retractMatches.push({ match: normalizeText(r.match), ts: Number(r.ts) || 0 })
    } else if (r.op === 'unpin') {
      if (r.match) unpinMatches.push({ match: normalizeText(r.match), ts: Number(r.ts) || 0 })
    }
  }
  const hitsAny = (list, text, ts) => {
    const n = normalizeText(text)
    return list.some((m) => (Number(ts) || 0) <= m.ts && n.includes(m.match))
  }

  // ---- 名字 / 说话方式 / 自述：人工写下的一直压着自动的 ----
  const setting = { name: '', voice: '', summary: '' }
  const humanLock = { name: false, voice: false, summary: false }
  for (const r of rows) {
    if (r.op !== 'name' && r.op !== 'voice' && r.op !== 'summary') continue
    const key = r.op
    const isHuman = r.source === 'human'
    if (!humanLock[key] || isHuman) setting[key] = String(r.value || '')
    if (isHuman) humanLock[key] = true
  }

  // ---- 证据聚成条目 ----
  const traits = []
  let signalCount = 0
  for (const r of rows) {
    if (r.op !== 'signal') continue
    if (retractedIds.has(r.id)) continue
    if (hitsAny(retractMatches, r.text, r.ts)) continue
    signalCount += 1

    let trait = findTrait(traits, r.text, opts.similarity)
    if (!trait) {
      trait = {
        key: normalizeText(r.text).slice(0, 32),
        text: r.text,
        dimension: r.dimension || '性格',
        members: [],
        sumWeight: 0,
        mentions: 0,
        verified: 0,
        pinned: false,
        human: false,
        firstSeen: r.ts,
        lastSeen: r.ts,
      }
      traits.push(trait)
    }
    trait.members.push(r.id)
    trait.sumWeight += clamp(Number(r.weight) || 0.5, 0.05, 1)
    trait.mentions += Math.max(1, Number(r.carriedMentions) || 1)
    if (r.verdict === 'confirm' || r.source === 'human') trait.verified += 1
    const wantsPin = r.source === 'human' || r.pinned === true
    if (wantsPin && !hitsAny(unpinMatches, r.text, r.ts)) {
      trait.pinned = true
      if (r.source === 'human') trait.human = true
    }
    if (Number(r.ts) > trait.lastSeen) trait.lastSeen = Number(r.ts)
    if (Number(r.ts) < trait.firstSeen) trait.firstSeen = Number(r.ts)
  }

  for (const t of traits) {
    t.score = strengthOf(t.sumWeight)
    t.solid = t.pinned || t.mentions >= opts.solidMentions || t.verified >= opts.solidVerified
    // 站住的不再下沉：这是「反复想起过的事不会淡掉」的实现
    t.liveScore = t.solid ? t.score : decayedScore(t, now, opts.halfLifeDays)
  }

  const byScore = (a, b) => b.liveScore - a.liveScore
  const solidAll = traits.filter((t) => t.solid).sort(byScore)
  const rest = traits.filter((t) => !t.solid).sort(byScore)
  const warm = rest.filter((t) => t.liveScore >= opts.floor)
  const cold = rest.filter((t) => t.liveScore < opts.floor)

  const pinned = solidAll.filter((t) => t.pinned)
  const solidUnpinned = solidAll.filter((t) => !t.pinned)
  const room = Math.max(0, opts.maxTraits - pinned.length)
  const solid = pinned.concat(solidUnpinned.slice(0, room))
  const spilled = solidUnpinned.slice(room)
  const tendencyRoom = Math.max(0, room - solidUnpinned.length)
  const tendencies = warm.slice(0, tendencyRoom)
  const folded = spilled.concat(warm.slice(tendencyRoom), cold)

  return {
    name: setting.name,
    voice: setting.voice,
    summary: setting.summary,
    solid,
    tendencies,
    folded: folded.slice(0, 24),
    traits: solid.concat(tendencies),
    counts: {
      records: rows.length,
      signals: signalCount,
      traits: traits.length,
      solid: solid.length,
      tendencies: tendencies.length,
      folded: folded.length,
    },
    createdFrom: rows.length ? Number(rows[0].ts) || now : now,
    derivedAt: now,
  }
}

export function personaAgeDays(model, now = Date.now()) {
  const created = Number(model?.createdFrom) || now
  return Math.max(1, Math.floor((now - created) / 86400000) + 1)
}

/**
 * 编译人格卡。**只写事实，不写分数**。
 * 顺序即优先级：现在 → 反复想起过的（keep）→ 倾向 → 更早以前（最先被裁）。
 */
export function compileCard(model, options = {}) {
  const now = options.now ?? Date.now()
  const maxChars = Math.max(160, Number(options.maxChars) || 900)
  const maxFolded = Math.max(
    0,
    Math.min(6, options.maxFoldedShown === undefined ? DEFAULTS.maxFoldedShown : Number(options.maxFoldedShown) || 0),
  )


  const sections = []
  const push = (text, keep = false) => {
    if (text) sections.push({ text, keep })
  }

  const selfName = String(options.personaName || '').trim()
  const otherName = String(model?.name || '').trim()

  const nowLines = ['## 现在', `你存在了 ${personaAgeDays(model, now)} 天。`]
  if (selfName) nowLines.push(`你叫「${selfName}」。`)
  if (otherName) nowLines.push(`你管对方叫「${otherName}」。`)
  else nowLines.push('你还没想好怎么称呼对方。')
  if (model?.summary) nowLines.push(String(model.summary).slice(0, 240))
  push(nowLines.join('\n'), true)

  if (model?.solid?.length) {
    push(['## 你反复想起过的（这些已经站住了，不会因为没提就淡掉）', ...model.solid.map((t) => `- ${t.text}`)].join('\n'), true)
  } else {
    push(['## 你反复想起过的', '还没有。你现在还没有站住的想法——这不是空白，这是起点。'].join('\n'), true)
  }

  if (model?.tendencies?.length) {
    push(
      ['## 你的倾向（刚长出来，别演得比这更重）', ...model.tendencies.map((t) => `- ${t.text}`)].join('\n'),
    )
  }

  if (maxFolded > 0 && model?.folded?.length) {
    const list = model.folded.slice(0, maxFolded).map((t) => t.text).join('；')
    push(
      [
        '## 更早以前',
        `你说过：${list}${model.folded.length > maxFolded ? '……' : ''}`,
        '那些话现在不一定还算数，但它们是你说过的。',
      ].join('\n'),
    )
  }

  // 起步人设（可选）：手工给的起点，不算自动长出来的，所以单独一段、最先被裁
  const maxSeed = Math.max(0, Number(options.maxSeedChars) || 0)
  const seedText = String(options.seedText || '').trim()
  if (maxSeed > 0 && seedText) {
    push(['## 起步人设（这是给你的起点，不是你自己长出来的）', seedText.slice(0, maxSeed)].join('\n'))
  }

  // 预算：先按顺序装。装不下时**先试着把最后一节截短**（起步人设这种「有总比没有好」的），
  // 实在装不下才整节丢掉 —— 整节丢会让第一天只剩「你存在了 1 天」。
  const render = (items) => items.map((s) => s.text).join('\n\n')
  let kept = sections.slice()
  while (kept.length && render(kept).length > maxChars) {
    const idx = kept.map((s, i) => (s.keep ? -1 : i)).filter((i) => i >= 0).pop()
    if (idx === undefined) break
    const others = kept.slice(0, idx).concat(kept.slice(idx + 1))
    const room = maxChars - render(others).length - 2
    if (room > 120) {
      const shortened = kept[idx].text.slice(0, room - 1) + '…'
      kept = kept.slice(0, idx).concat([{ ...kept[idx], text: shortened }], kept.slice(idx + 1))
      break
    }
    kept = others
  }
  return render(kept).slice(0, maxChars)
}

/** 折叠成一行的旧条目（给人看的，不进提示词）。 */
export function foldedLine(model, limit = 6) {
  const list = (model?.folded || []).slice(0, limit).map((t) => t.text)
  return list.length ? `更早以前：${list.join('；')}` : ''
}
