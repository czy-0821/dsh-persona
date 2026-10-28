// 自测：只跑纯逻辑与存储，不碰 DSH、不联网。node smoke.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PersonaStore, normalizeCache } from './store.js'
import {
  DEFAULTS,
  compileCard,
  decayedScore,
  deriveSignals,
  foldedLine,
  personaAgeDays,
  similarity,
  strengthOf,
} from './persona.js'
import { renderContext, renderRules } from './prompt.js'
import {
  buildDistillRequest,
  collectStreamText,
  parseDistillOutput,
  selectEpisodeWindow,
} from './distill.js'

let pass = 0
let fail = 0
const failures = []

function ok(name, cond, detail) {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    failures.push(name)
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const DAY = 86400000
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-persona-smoke-'))
let seq = 0
function rec(op, props = {}, ts = Date.now()) {
  seq += 1
  return { id: `sg_${seq.toString(36)}`, ts, op, ...props }
}
const sig = (text, extra = {}) => rec('signal', { text, dimension: '性格', weight: 0.6, source: 'distill', ...extra })

try {
  // ------------------------------------------------------------------ store
  console.log('store（三层：原材料 / 可信源 / 派生缓存）')
  const store = new PersonaStore(path.join(tmpRoot, 'a'))
  const written = store.appendRecords('signal', [
    { text: '被夸会先否认', weight: 0.6, source: 'distill' },
    { text: '   ' },
  ])
  ok('空白信号被丢弃', written.length === 1, `${written.length}`)
  ok('id 形如 sg_xxx', /^sg_[0-9a-z]+$/.test(written[0].id), written[0].id)
  ok('读回一条', store.countRecords() === 1)
  ok('未知 op 被拒', (() => {
    try {
      store.appendRecords('nope', [{ text: 'x' }])
      return false
    } catch {
      return true
    }
  })())

  store.appendRecords('retract', [{ match: '不存在' }])
  ok('retract 落盘但不删旧行', store.countRecords() === 2 && store.records().some((r) => r.op === 'signal'))

  store.appendRecords('voice', [{ value: '短句，口语', source: 'human' }])
  ok('非 signal 记录带 source', store.records().at(-1).source === 'human')

  const eps = store.appendEpisodes([
    { role: 'user', text: '  今天  好累  ' },
    { role: 'assistant', text: '那就早点睡' },
  ])
  ok('片段被压平成一行', eps[0].text === '今天 好累', eps[0].text)
  ok('片段 id 单调递增', eps[1].id > eps[0].id)

  const runtime = store.runtime()
  ok('运行账本默认值', runtime.distillRuns === 0 && runtime.lastEpisodeId === 0)
  store.saveRuntime({ lastEpisodeId: eps[1].id, distillRuns: 2 })
  ok('运行账本落盘', store.runtime().distillRuns === 2 && store.runtime().lastEpisodeId === eps[1].id)

  store.writeCache({ records: 2, name: '小鲸', voice: '', summary: '', traits: [] })
  ok('缓存可读回', store.readCache().name === '小鲸')
  ok('坏缓存不炸', normalizeCache({ traits: 'nope' }).traits.length === 0)

  const pruned = store.pruneEpisodes({ keepDays: 30, maxRows: 1, now: Date.now() })
  ok('片段剪枝按条数上限', pruned === 1 && store.countEpisodes() === 1, `removed=${pruned}`)

  // ------------------------------------------------------- 强度与衰减数学
  console.log('persona（强度 / 衰减 / 固化）')
  ok('单次证据不满分', strengthOf(0.6) < 0.35, String(strengthOf(0.6)))
  ok('三次证据明显更强', strengthOf(1.8) > strengthOf(0.6) + 0.25, `${strengthOf(0.6)} -> ${strengthOf(1.8)}`)
  ok('强度有上限', strengthOf(50) <= 0.99)
  ok('相似度：同句为 1', similarity('好奇', '好奇') === 1)
  ok('相似度：完全不同很低', similarity('好奇', '暴躁易怒') < 0.2)
  ok('相似度：近似句较高', similarity('被夸会先否认', '被夸的时候会先否认') > 0.5)

  const now = Date.now()
  const faded = { text: 'x', score: 0.8, lastSeen: now }
  ok('半衰期 30 天掉到 1/8', Math.abs(decayedScore(faded, now + 90 * DAY, 30) - 0.1) < 0.01)

  // ---------------------------------------------------------- 从信号流推导
  console.log('deriveSignals（历史算出来的她）')
  const t0 = now - 10 * DAY
  const r1 = [
    sig('被夸会先否认，再小声承认', { ts: t0 }),
    sig('被夸的时候先否认再小声承认', { ts: t0 + 1000 }),
    sig('被夸会先否认，再小声承认', { ts: t0 + 2000 }),
  ]
  const m1 = deriveSignals(r1, { now })
  ok('三次近似说法聚成一条', m1.traits.length === 1, `traits=${m1.traits.length}`)
  ok('提过 3 次就算站住', m1.solid.length === 1 && m1.tendencies.length === 0)
  ok('站住的不随时间下沉', Math.abs(m1.solid[0].liveScore - strengthOf(1.8)) < 1e-9)

  const m1later = deriveSignals(r1, { now: now + 200 * DAY })
  ok('过了 200 天它还在', m1later.solid.length === 1, `solid=${m1later.solid.length}`)

  const m2 = deriveSignals([sig('喜欢在夜里说话', { ts: now })], { now })
  ok('只提过一次的是倾向，不是站住', m2.solid.length === 0 && m2.tendencies.length === 1)
  const m2later = deriveSignals([sig('喜欢在夜里说话', { ts: now - 400 * DAY })], { now })
  ok('淡掉的倾向被折叠，不是删除', m2later.folded.length === 1 && m2later.tendencies.length === 0)
  ok('折叠行能念出来', foldedLine(m2later).includes('喜欢在夜里说话'))

  const m3 = deriveSignals([sig('从不说教', { ts: now, source: 'human', pinned: true, weight: 1 })], { now })
  ok('人工钉住直通站住', m3.solid.length === 1 && m3.solid[0].pinned === true)
  const pinnedAt = (ts) =>
    deriveSignals([sig('从不说教', { ts, source: 'human', pinned: true, weight: 1 })], { now })
  const p1 = pinnedAt(now - 400 * DAY)
  ok('钉住的按证据算强度', Math.abs(p1.solid[0].liveScore - strengthOf(1)) < 1e-9, String(p1.solid[0].liveScore))
  ok('钉住的不随时间衰减', p1.solid[0].liveScore === pinnedAt(now - 10 * DAY).solid[0].liveScore)

  const three = [sig('话少', { ts: t0 }), sig('话少', { ts: t0 + 1 }), sig('话少', { ts: t0 + 2 })]
  const retracted = deriveSignals(three.concat([rec('retract', { match: '话少', ts: now })]), { now })
  ok('retract 之后条目不出现', retracted.traits.length === 0 && retracted.counts.signals === 0)

  const refutedOne = deriveSignals(
    [rec('retract', { targets: [three[0].id, three[1].id, three[2].id], ts: now })],
    { now },
  )
  ok('按 id 精确撤回也生效', refutedOne.traits.length === 0)

  const unpinned = deriveSignals(
    [sig('从不说教', { ts: t0, source: 'human', pinned: true, weight: 1 }), rec('unpin', { match: '从不说教', ts: now })],
    { now },
  )
  ok('unpin 之后不再是钉住的', unpinned.solid.every((t) => t.pinned !== true))

  const named = deriveSignals(
    [
      rec('name', { value: '主人', source: 'human', ts: t0 }),
      rec('name', { value: '老板', source: 'auto', ts: t0 + 1000 }),
    ],
    { now },
  )
  ok('人工设定的名字压住自动的', named.name === '主人', named.name)

  const voices = deriveSignals(
    [
      rec('voice', { value: '短句', source: 'auto', ts: t0 }),
      rec('voice', { value: '爱用语气词', source: 'human', ts: t0 + 1 }),
      rec('voice', { value: '又变回短句', source: 'auto', ts: t0 + 2 }),
    ],
    { now },
  )
  ok('人工改的口吻不会被自动覆盖', voices.voice === '爱用语气词', voices.voice)

  // 20 条互不相似的站住条目：验证「超量只折叠、不删除」
  const POOL = [
    '看到新东西会先问一句',
    '话不多但都是想说的',
    '嘴硬，错了也不马上认',
    '有点懒，也承认自己懒',
    '喜欢抬杠但不是恶意',
    '对时间很敏感',
    '怕麻烦，能拖就拖',
    '心情好话就多',
    '笑点低',
    '记仇，但只在心里',
    '认生，慢热',
    '桌面永远收拾得很整齐',
    '拖延到最后一刻',
    '较真到让人烦',
    '花钱大方',
    '特别怕冷',
    '喜欢热闹',
    '闷，不爱说话',
    '直球，想到什么说什么',
    '慢热但一旦熟了话很多',
  ]
  const many = []
  for (const line of POOL) {
    many.push(sig(line, { ts: t0 }))
    many.push(sig(line, { ts: t0 + 1 }))
    many.push(sig(line, { ts: t0 + 2 }))
  }
  const capped = deriveSignals(many, { now, maxTraits: 5 })
  ok('上限之外的不删除而是折叠', capped.solid.length === 5 && capped.folded.length === 15, `${capped.solid.length}/${capped.folded.length}`)

  // -------------------------------------------------------------- 人格卡
  console.log('compileCard（只有事实，没有分数）')
  const model = deriveSignals(
    [
      rec('signal', { text: '被夸会先否认，再小声承认', weight: 0.8, ts: t0 }),
      rec('signal', { text: '被夸会先否认，再小声承认', weight: 0.8, ts: t0 + 1 }),
      rec('signal', { text: '被夸会先否认，再小声承认', weight: 0.8, ts: t0 + 2 }),
      rec('signal', { text: '喜欢在夜里说话', weight: 0.3, ts: t0 }),
      rec('signal', { text: '很久以前的事', weight: 0.1, ts: now - 400 * DAY }),
      rec('name', { value: '主人', source: 'human', ts: t0 }),
    ],
    { now },
  )
  const card = compileCard(model, { now, maxChars: 900 })
  ok('卡里有「现在」与天数', card.includes('## 现在') && card.includes('你存在了'), card.split('\n')[1])
  ok('卡里列出站住的条目', card.includes('被夸会先否认'))
  ok('卡里列出倾向', card.includes('喜欢在夜里说话'))
  ok('卡里有「更早以前」', card.includes('更早以前'))
  ok('卡里没有任何小数分数', !/\d+\.\d+/.test(card), card.match(/\d+\.\d+/)?.[0] || '')
  ok('卡里不出现「强度」字样', !card.includes('强度'))
  ok('卡里列出对方称呼', card.includes('你管对方叫「主人」'))
  ok('给了名字就写「你叫」', compileCard(model, { now, personaName: '大肥鱼' }).includes('你叫「大肥鱼」'))
  const withSeed = compileCard(model, { now, seedText: '你有点懒，也承认自己懒', maxSeedChars: 300 })
  ok('起步人设单独成段', withSeed.includes('起步人设') && withSeed.includes('有点懒'))
  // 真实场景：第一天还没有任何条目，卡里只有起点人设 —— 这时候它必须活下来（可截短）
  const day1Card = compileCard(deriveSignals([], { now }), {
    now,
    maxChars: 600,
    seedText: '很长的起步人设。'.repeat(200),
    maxSeedChars: 1000,
  })
  ok('第一天起点人设被截短而不是整段丢', day1Card.includes('起步人设') && day1Card.length <= 600, `${day1Card.length} 字`)

  const tight = compileCard(model, { now, maxChars: 220 })
  ok('字符上限被遵守', tight.length <= 220, String(tight.length))
  ok('超预算时先砍可裁的（核心段还在）', tight.includes('## 现在'))

  ok('年龄至少 1 天', personaAgeDays(model, now) >= 1 && personaAgeDays(deriveSignals([], { now }), now) === 1)
  ok('空模型的卡也能编译', compileCard(deriveSignals([], { now }), { now }).includes('起点'))

  // ---------------------------------------------------------------- prompt
  console.log('prompt（分层规则）')
  ok('空人格不注入上下文', renderContext(deriveSignals([], { now }), { now }) === '')
  ok('有人格时上下文带头部', renderContext(model, { now }).startsWith('【人格状态】'))
  const rules = renderRules()
  ok('规则分「不能做的」与「你还不会的」', rules.includes('## 你不能做的') && rules.includes('## 你还不会的'))
  ok('规则里不写分数与「强度」', !rules.includes('强度') && !/\d+\.\d+/.test(rules))
  ok('规则里点名了工具', rules.includes('persona_observe') && rules.includes('persona_recall'))

  // --------------------------------------------------------------- distill
  console.log('distill')
  const parsed = parseDistillOutput(
    '```json\n{"signals":[{"text":"被夸会先否认","dimension":"性格","weight":0.7,"verdict":"confirm"}],"voice":"短句"}\n```',
  )
  ok('能剥掉代码围栏', parsed.signals.length === 1 && parsed.signals[0].weight === 0.7)
  ok('verdict 被解析', parsed.signals[0].verdict === 'confirm')
  ok('非法 verdict 退回 new', parseDistillOutput('{"signals":[{"text":"x y","verdict":"?"}]}').signals[0].verdict === 'new')
  ok('垃圾输入不抛错', parseDistillOutput('模型今天不想说话').signals.length === 0)
  ok('signals 被截到 4 条', parseDistillOutput(JSON.stringify({ signals: Array.from({ length: 10 }, () => ({ text: 'a b' })) })).signals.length === 4)

  const win = selectEpisodeWindow(
    Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: 'x'.repeat(300) })),
    1500,
  )
  ok('片段窗口受预算限制', win.length > 0 && win.join('').length <= 1500 + 400, `${win.length} 行`)
  ok('窗口里她的话标成「她」', win[win.length - 1].startsWith('[她]'))

  const req = buildDistillRequest({ episodes: [{ role: 'user', text: '你好', ts: now }], state: model, options: {} })
  ok('提炼请求带系统提示与片段', req.system.includes('JSON') && req.user.includes('[对方] 你好'))
  ok('提炼请求带「已经站住的条目」', req.user.includes('已经站住的条目'))

  const text = await collectStreamText(
    (async function* () {
      yield { type: 'text-delta', text: '{"signals":' }
      yield { type: 'text-delta', text: '[]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  )
  ok('chunk 流拼成完整文本', text === '{"signals":[]}')

  let threw = false
  try {
    await collectStreamText(
      (async function* () {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'X' } } }
      })(),
    )
  } catch {
    threw = true
  }
  ok('error finish 变成抛错', threw)

  // ------------------------------------------------------------- 整链一次
  console.log('端到端（假模型）')
  const chain = new PersonaStore(path.join(tmpRoot, 'b'))
  chain.appendEpisodes([
    { role: 'user', text: '你昨天说的那个笑话好好笑' },
    { role: 'assistant', text: '那是真的' },
  ])
  const fakeLlm = {
    stream() {
      return (async function* () {
        yield {
          type: 'text-delta',
          text: '{"signals":[{"text":"被夸会先否认再承认","dimension":"性格","weight":0.6,"verdict":"new"}],"voice":"短句，口语"}',
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const { distillOnce } = await import('./distill.js')
  const result = await distillOnce({
    llm: fakeLlm,
    provider: 'p',
    model: 'm',
    episodes: chain.recentEpisodes(10),
    state: deriveSignals(chain.records(), { now }),
    options: {},
  })
  chain.appendRecords('signal', result.signals.map((s) => ({ ...s, source: 'distill' })))
  chain.appendRecords('voice', [{ value: result.voice, source: 'auto' }])
  chain.saveRuntime({ lastEpisodeId: chain.recentEpisodes(1)[0].id, distillRuns: 1 })
  const finalModel = deriveSignals(chain.records(), { now })
  chain.writeCache({ records: chain.countRecords(), name: finalModel.name, voice: finalModel.voice, summary: '', traits: [] })
  ok('假模型跑通整条链路', finalModel.traits.length === 1 && finalModel.voice === '短句，口语')
  ok('提炼计数被记上', chain.runtime().distillRuns === 1)
  ok('人格卡可注入', renderContext(finalModel, { now }).includes('被夸会先否认再承认'))

  // 派生品可丢：删掉缓存，重算结果一致
  const before = JSON.stringify(deriveSignals(chain.records(), { now }))
  fs.rmSync(path.join(tmpRoot, 'b', 'persona.json'), { force: true })
  const after = JSON.stringify(deriveSignals(chain.records(), { now }))
  ok('删掉 persona.json 重算结果一致', before === after)
} finally {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

console.log('')
console.log(`${pass} 通过 / ${fail} 失败`)
if (fail) {
  console.log(`失败项：${failures.join('、')}`)
  process.exitCode = 1
}
