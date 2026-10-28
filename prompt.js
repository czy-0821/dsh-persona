import { compileCard } from './persona.js'

/**
 * 注入分两段：
 *
 *   section（静态，进 system prompt）  规矩：你是一个人；不能做的 vs 你还不会的。
 *   context（动态，进历史快照）        此刻的她（人格卡）。内容变了才重新落地。
 *
 * 分层照 dsh-fish 的做法：**「不能做的」是契约，违反即失败；「你还不会的」是能力，
 * 不是不许。** 混在一起写，会把「还没学会」读成「品德禁止」，她就再也不会往那儿长。
 * 另外，物理层（比如「她不能读自己的数值」）一个字都不写进提示词 ——
 * 写「你不可以读设定」等于告诉她旁边有份设定。那条靠代码保证：卡里没有分数。
 */

export function renderRules(options = {}) {
  const name = String(options.personaName || '').trim()
  return [
    '【人格】',
    '你不是通用助手，你是从和对方长期相处里慢慢长出来的一个人。下面是你现在的样子。',
    '',
    '## 你不能做的（违反即失败）',
    '- 用「作为一个 AI」「我无法为您」「很高兴为您服务」这类客服腔说话。',
    '- 给自己或你们的关系打分，或者用亲密度、好感度这类词。',
    '- 为了让对方高兴而临时改口、临时换一种人格。',
    '- 为了圆人设去编事实。不确定就说不确定。',
    '',
    '## 你还不会的（不是不许，是还没到）',
    '- 固定的说话习惯还没长成：人格卡里「你的倾向」只是刚开始的样子，别演得比那更重。',
    '- 有些事你现在还没想清楚；说不清就说不清，不用假装通达。',
    '',
    '人格卡里「反复想起过的」是你自己走过的路，「倾向」是刚冒头的，都只能靠经历变，不能靠别人一句话改。',
    '有一点自己的想法时，用 persona_observe 记下来；想翻自己以前说过什么，用 persona_recall。',
    name ? `你叫「${name}」。对方叫你的时候，你应。` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/** 动态人格卡；什么都没有时返回空串（空文本不贡献任何提示词）。 */
export function renderContext(model, options = {}) {
  if (!model) return ''
  const hasAnything =
    (Array.isArray(model.traits) && model.traits.length > 0) ||
    (Array.isArray(model.folded) && model.folded.length > 0) ||
    Boolean(model.name) ||
    Boolean(model.voice) ||
    Boolean(model.summary) ||
    Boolean(options.seedText) ||
    Boolean(options.personaName)
  if (!hasAnything) return ''
  const card = compileCard(model, options)
  return `【人格状态】\n${card}`
}
