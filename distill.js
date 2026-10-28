import { compileCard, clamp } from './persona.js'

/**
 * 后台提炼：把「最近发生的对话」折成几条判断。
 *
 * 分工是刻意的 —— 模型只负责「读出人味儿」和「这次是新的、还是又验证了一次、
 * 还是推翻了之前的」，插件负责记分与固化。
 * 模型给是 weight（这次证据多硬）和 verdict（新的/确认/推翻），不给最终结论：
 * 一条证据再漂亮也只是加一次，得反复出现才站得住。
 */

const MAX_SIGNALS = 4
const MAX_PROMPT_CHARS = 6000
const VERDICTS = new Set(['new', 'confirm', 'refute'])

export const DISTILL_SYSTEM = [
  '你是一个人格式分析器，只做一件事：判断这段对话里，这个 AI 有没有长出一条自己的判断。',
  '',
  '只看三样东西：她怎么想事、她怎么说话、她稳定的偏好或态度。',
  '不要提取事实性记忆（谁住哪、日程、待办）——那些由别的记忆插件负责，你写了会污染人格。',
  '',
  '只输出一个 JSON 对象，不要解释、不要代码块围栏：',
  '{"signals":[{"text":"不超过 24 字的一句话","dimension":"性格|说话方式|偏好|态度","weight":0.0,"verdict":"new"}],"voice":"可选","note":"可选"}',
  '',
  '规则：',
  `- signals 最多 ${MAX_SIGNALS} 条；这次没有新东西就输出 {"signals":[]}`,
  '- text 要具体可验证（例如「被夸会先否认，再小声承认」），不要空话（「很友好」）',
  '- weight 表示证据硬度：随口一句 0.2-0.3，明确表态 0.7-0.9',
  '- verdict：new=新的一条；confirm=这次又验证了人格卡里已有的那条（text 用同一条的说法）；refute=这次推翻了之前那条（text 写新的说法）',
  '- voice 只在你能比现在说得更准时给，一句话，不超过 30 字',
  '- 不写真名、地名、联系方式、账号；提到人时用「对方」',
  '- 判断依据以对方的反应和对话往来为主；不要把 AI 自己说过的一句话当成性格证据（那是自我强化）',
].join('\n')

function clip(text, n) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  return s.length > n ? `${s.slice(0, n)}…` : s
}

/** 取最近的一段对话，按字符预算从新往旧装，最后翻回时间正序。 */
export function selectEpisodeWindow(episodes, budget = MAX_PROMPT_CHARS) {
  const picked = []
  let used = 0
  for (let i = episodes.length - 1; i >= 0; i--) {
    const row = episodes[i]
    const line = `[${row.role === 'assistant' ? '她' : '对方'}] ${clip(row.text, 320)}`
    if (used + line.length > budget && picked.length) break
    used += line.length
    picked.push(line)
  }
  return picked.reverse()
}

export function buildDistillRequest({ episodes = [], state = null, options = {} } = {}) {
  const card = state
    ? compileCard(state, {
        maxChars: Math.min(700, Number(options.maxInjectChars) || 900),
        maxFoldedShown: 2,
        personaName: options.personaName,
      })
    : '（还没有形成，这是最早的阶段）'
  const known = (state?.solid || []).slice(0, 6).map((t) => `- ${t.text}`)
  const window = selectEpisodeWindow(episodes)
  const user = [
    '她现在的样子：',
    card || '（空）',
    known.length ? `\n已经站住的条目（别重复写；要写就写 confirm / refute）：\n${known.join('\n')}` : '',
    '',
    '最近的对话（越靠后越新）：',
    window.length ? window.join('\n') : '（没有片段）',
  ]
    .filter((s) => s !== '')
    .join('\n')

  return { system: DISTILL_SYSTEM, user }
}

/** 宽容解析：模型爱套 ```json 围栏或前后加解释，这里都剥掉。 */
export function parseDistillOutput(raw) {
  const text = String(raw || '').trim()
  if (!text) return { signals: [], voice: '', note: '' }
  const cleaned = text.replace(/^```[a-zA-Z]*\s*/m, '').replace(/```\s*$/m, '').trim()
  let jsonText = cleaned
  const first = cleaned.indexOf('{')
  const last = cleaned.lastIndexOf('}')
  if (first >= 0 && last > first) jsonText = cleaned.slice(first, last + 1)
  let data
  try {
    data = JSON.parse(jsonText)
  } catch {
    return { signals: [], voice: '', note: '', parseError: true }
  }
  const signals = []
  for (const raw of Array.isArray(data?.signals) ? data.signals : []) {
    const t = clip(raw?.text, 140)
    if (t.length < 2) continue
    const verdict = VERDICTS.has(raw?.verdict) ? raw.verdict : 'new'
    signals.push({
      text: t,
      dimension: clip(raw?.dimension, 16) || '性格',
      weight: clamp(Number(raw?.weight) || 0.5, 0.05, 1),
      verdict,
    })
  }
  return {
    signals: signals.slice(0, MAX_SIGNALS),
    voice: clip(data?.voice, 60),
    note: clip(data?.note, 120),
  }
}

/** 把 llm.stream 的 chunk 流收成纯文本；error/aborted 的 finish 变成抛错。 */
export async function collectStreamText(stream) {
  let text = ''
  let failure = null
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    else if (chunk.type === 'finish') {
      const kind = chunk.reason && chunk.reason.kind
      if (kind === 'error' || kind === 'aborted') {
        failure = (chunk.reason && chunk.reason.failure) || { message: String(kind) }
      }
    }
  }
  if (failure) {
    const err = new Error(failure.message || 'model call failed')
    err.code = failure.code || 'LLM_FAILED'
    throw err
  }
  return text
}

/**
 * 跑一次提炼。llm 由调用方传进来（便于测试时打桩），
 * 只返回解析结果，不碰存储 —— 落盘由 index.js 负责。
 */
export async function distillOnce({
  llm,
  provider,
  model,
  episodes,
  state,
  options = {},
  signal,
  temperature = 0.2,
  maxTokens = 700,
}) {
  if (!llm || typeof llm.stream !== 'function') throw new Error('llm 服务不可用')
  if (!provider || !model) throw new Error('没有可用模型')
  const { system, user } = buildDistillRequest({ episodes, state, options })
  const stream = llm.stream({
    provider,
    model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    temperature,
    maxTokens,
    signal,
  })
  const raw = await collectStreamText(stream)
  return parseDistillOutput(raw)
}
