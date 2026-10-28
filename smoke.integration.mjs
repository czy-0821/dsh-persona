// 装配自测：用假的 @deepseek-ai 包在临时目录里真跑 apply()。
// 验证的是「插件装配逻辑」——工具注册、提示词注入、自动抓取、自动提炼、
// 人工钉住/撤回、回顾、没有模型时的降级、旧档迁移。
// 不碰 DSH、不联网。node smoke.integration.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const MODULES = ['index.js', 'store.js', 'persona.js', 'prompt.js', 'distill.js']

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-persona-asm-'))
const cleanup = () => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

function writeStubs(root) {
  const stub = (name, body) => {
    const dir = path.join(root, 'node_modules', '@deepseek-ai', name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: `@deepseek-ai/${name}`, version: '0.0.0', type: 'module', main: 'index.js' }),
      'utf8',
    )
    fs.writeFileSync(path.join(dir, 'index.js'), body, 'utf8')
  }
  stub('dsh-tools', 'export function defineTool(definition) { return definition }\n')
  stub(
    'schemastery',
    [
      'function field(kind) {',
      '  const api = { kind, default(v) { this._default = v; return this }, description(v) { this._description = v; return this } }',
      '  return api',
      '}',
      'const Schema = {',
      '  string: () => field("string"),',
      '  number: () => field("number"),',
      '  boolean: () => field("boolean"),',
      '  object: (spec) => ({ kind: "object", spec }),',
      '}',
      'export default Schema',
      '',
    ].join('\n'),
  )
}

function makeCtx({ llm, selection }) {
  const tools = new Map()
  const sections = []
  const contexts = []
  const listeners = new Map()
  const disposers = []
  const logs = []
  return {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
      context(context) {
        contexts.push(context)
        return () => {}
      },
      // 故意抛错：验证对「拿不到的具名位次」有兜底
      getSectionOrder() {
        throw new Error('unknown section name')
      },
      getContextOrder() {
        throw new Error('unknown context name')
      },
    },
    on(name, handler) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(handler)
      return () => {}
    },
    effect(callback) {
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer)
    },
    get(name) {
      if (name === 'llm') return llm
      if (name === 'agentDefaultModel') return selection ? { currentSelection: () => selection } : undefined
      return undefined
    },
    logger() {
      const sink = (level) => (...args) => logs.push(`${level} ${args.join(' ')}`)
      return { info: sink('info'), warn: sink('warn'), error: sink('error') }
    },
    __emit(name, ...args) {
      for (const handler of listeners.get(name) || []) handler(...args)
    },
    __tools: tools,
    __sections: sections,
    __contexts: contexts,
    __logs: logs,
    __dispose() {
      for (const d of disposers) d()
    },
  }
}

const fakeSession = (id) => ({ id })
const textMessage = (text) => ({ content: [{ type: 'text', text }] })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const readLines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : [])
const TOOL_NAMES = ['persona_read', 'persona_observe', 'persona_recall', 'persona_reflect', 'persona_correct', 'persona_stats']

try {
  for (const file of MODULES) fs.copyFileSync(path.join(here, file), path.join(tmp, file))
  fs.writeFileSync(
    path.join(tmp, 'package.json'),
    JSON.stringify({ name: 'persona-assembly-test', private: true, type: 'module' }),
    'utf8',
  )
  writeStubs(tmp)
  const plugin = await import(`file://${path.join(tmp, 'index.js').replace(/\\/g, '/')}`)

  ok('导出 name', plugin.name === 'dsh-persona')
  ok('inject 含 tools 与 systemPrompt', plugin.inject.includes('tools') && plugin.inject.includes('systemPrompt'))
  const configKeys = Object.keys(plugin.Config.spec || {})
  ok('Config 含固化门槛等关键项', ['solidMentions', 'solidVerified', 'distillEvery', 'injectPersona'].every((k) => configKeys.includes(k)), `${configKeys.length} 项`)
  ok('每个 Config 字段都有 default', configKeys.every((k) => plugin.Config.spec[k]._default !== undefined))

  // ------------------------------------------------------------ 正常装配
  let distillCalls = 0
  const llm = {
    stream() {
      distillCalls++
      return (async function* () {
        yield {
          type: 'text-delta',
          text: '{"signals":[{"text":"被夸会先否认再小声承认","dimension":"性格","weight":0.8,"verdict":"new"}],"voice":"短句，口语"}',
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const dataDir = path.join(tmp, 'data')
  const recordsFile = path.join(dataDir, 'signals.jsonl')
  const ctx = makeCtx({ llm, selection: { provider: 'p', model: 'm' } })
  plugin.apply(ctx, { dataDir, distillEvery: 3, distillMinIntervalMs: 0 })

  ok('注册了 6 个工具', ctx.__tools.size === 6, [...ctx.__tools.keys()].join(','))
  ok('工具名齐全', TOOL_NAMES.every((n) => ctx.__tools.has(n)))
  ok(
    '参数直接是标准 JSON Schema',
    [...ctx.__tools.values()].every((t) => t.parameters && t.parameters.type === 'object' && t.parameters.properties),
  )
  ok(
    '必填走根级 required 数组',
    JSON.stringify(ctx.__tools.get('persona_observe').parameters.required) === '["text"]',
    JSON.stringify(ctx.__tools.get('persona_observe').parameters.required),
  )
  ok('枚举参数是合法 JSON Schema', Array.isArray(ctx.__tools.get('persona_correct').parameters.properties.action.enum))
  ok('output.schema 存在（宿主只校验这个）', [...ctx.__tools.values()].every((t) => t.output && t.output.schema))
  ok('注入了规则段与人格上下文', ctx.__sections.length === 1 && ctx.__contexts.length === 1)
  ok('规则段以【人格】开头', ctx.__sections[0].text.startsWith('【人格】'))
  ok('规则段分层', ctx.__sections[0].text.includes('## 你不能做的') && ctx.__sections[0].text.includes('## 你还不会的'))
  ok('空人格时上下文为空串', ctx.__contexts[0].text() === '')

  // ------------------------------------------------------------ 自动抓取
  const session = fakeSession('s1')
  ctx.__emit('session/event', session, { type: 'user/message', time: 1, data: textMessage('你昨天讲的笑话挺好笑的') })
  ctx.__emit('session/event', session, { type: 'assistant/message', time: 2, data: { message: textMessage('那是真的') } })
  ctx.__emit('session/event', session, { type: 'user/message', time: 3, data: textMessage('/model') })
  ctx.__emit('session/event', session, { type: 'user/message', time: 4, data: { content: [] } })
  const episodeLines = readLines(path.join(dataDir, 'episodes.jsonl'))
  ok('只抓到 2 条真对话', episodeLines.length === 2, `${episodeLines.length} 条`)

  // ------------------------------------------------------------ 自动提炼
  ctx.__emit('session/event', session, { type: 'user/message', time: 5, data: textMessage('你今天话挺少的') })
  ok('没到阈值不提炼', distillCalls === 0)
  ctx.__emit('agent/turn-stopping', { agent: {}, turn: 1 })
  await sleep(40)
  ok('到阈值触发一次自动提炼', distillCalls === 1, `calls=${distillCalls}`)
  const signalLines = readLines(recordsFile)
  ok('提炼结果进信号流（只追加）', signalLines.length >= 1, `${signalLines.length} 行`)
  ok('信号带 op/来源/verdict', signalLines.some((l) => l.includes('"op":"signal"') && l.includes('"source":"distill"')))
  ok('派生出 persona.json 缓存', fs.existsSync(path.join(dataDir, 'persona.json')))
  const card1 = ctx.__contexts[0].text()
  ok('人格卡非空且含新条目', card1.includes('被夸会先否认再小声承认'), card1.split('\n')[1])
  ok('人格卡里没有小数分数', !/\d+\.\d+/.test(card1))
  ok('人格卡里有分层小标题', card1.includes('## 现在'))

  // ------------------------------------------------------------ 工具行为
  const read = ctx.__tools.get('persona_read')
  const readOut = await read.execute({})
  ok('persona_read 返回人格卡', readOut.includes('【人格状态】'))

  const observe = ctx.__tools.get('persona_observe')
  const observeOut = await observe.execute({ text: '话少但会突然说一句冷的', weight: 0.6 })
  ok('observe 回执是机器回执', observeOut === '[已记下]', observeOut)
  ok('observe 不回显任何数字', !/\d/.test(observeOut), observeOut)
  await observe.execute({ text: '话少但会突然说一句冷的', weight: 0.6 })
  await observe.execute({ text: '话少但会突然说一句冷的', weight: 0.6 })
  const afterThree = await read.execute({})
  ok('提过三次之后进入「反复想起过的」', afterThree.includes('话少但会突然说一句冷的') && afterThree.includes('反复想起过的'))
  ok('回执对空输入给出可读拒绝', (await observe.execute({ text: '   ' })) === '[没记下：这句是空的]')

  const recall = ctx.__tools.get('persona_recall')
  const recallOut = await recall.execute({})
  ok('persona_recall 翻得到她说过的话', recallOut.includes('那是真的'), recallOut)
  ok('persona_recall 翻不到时说明白', (await recall.execute({ query: '量子力学', limit: 3 })).includes('翻不到'))

  const reflect = ctx.__tools.get('persona_reflect')
  const reflectOut = await reflect.execute({}, {})
  ok('手动提炼回执是机器回执', reflectOut === '[提炼完成]', reflectOut)

  // -------------------------------------------------- 人工纠偏（只追加）
  const correct = ctx.__tools.get('persona_correct')
  ok('pin 回执', (await correct.execute({ action: 'pin', text: '从不说教' })) === '[已钉住]')
  const pinnedCard = await read.execute({})
  ok('钉住的条目进人格卡', pinnedCard.includes('从不说教'))
  ok('set_voice 回执', (await correct.execute({ action: 'set_voice', value: '短句，爱用语气词' })) === '[已改口吻]')
  const beforeHumanVoice = readLines(recordsFile).length
  const llm2Calls = []
  // 再提炼一次：自动 voice 不能覆盖人工写下的
  for (const [i, line] of ['你又来了', '今天风很大', '我不想动'].entries()) {
    ctx.__emit('session/event', session, { type: 'user/message', time: 6 + i, data: textMessage(line) })
  }
  ctx.__emit('agent/turn-stopping', { agent: {}, turn: 2 })
  await sleep(40)
  const cache = JSON.parse(fs.readFileSync(path.join(dataDir, 'persona.json'), 'utf8'))
  ok('人工口吻压住自动提炼的口吻', cache.voice === '短句，爱用语气词', cache.voice)
  ok('提炼继续追加而不是改写', readLines(recordsFile).length > beforeHumanVoice)

  const beforeForget = readLines(recordsFile).length
  const forgetOut = await correct.execute({ action: 'forget', key: '被夸会先否认' })
  ok('forget 回执', forgetOut === '[已撤回]', forgetOut)
  ok('撤回不删任何一行（历史只能追加）', readLines(recordsFile).length > beforeForget)
  const afterForget = await read.execute({})
  ok('撤回之后人格卡里不再有它', !afterForget.includes('被夸会先否认'), afterForget)
  ok('撤回后仍能翻到当时说过的话（叙述层还在）', (await recall.execute({})).includes('那是真的'))
  ok('没找到的条目给出可读回执', (await correct.execute({ action: 'forget', key: '不存在的条目xyz' })) === '[没找到这一条]')
  ok('未知 action 可读提示', (await correct.execute({ action: 'nope' })).includes('action 只支持'))

  const stats = JSON.parse(await ctx.__tools.get('persona_stats').execute({}))
  ok('persona_stats 给健康度而不是她的分数', stats.signals >= 1 && stats.records >= 1 && stats.distillRuns >= 1)
  ok('persona_stats 不含强度字段', !JSON.stringify(stats).includes('强度'))
  ctx.__dispose()

  // ------------------------------------------------- 没有模型 / 关闭提炼
  const ctx2 = makeCtx({ llm: null, selection: null })
  plugin.apply(ctx2, { dataDir: path.join(tmp, 'data2'), distillEnabled: false })
  const s2 = fakeSession('s2')
  for (let i = 0; i < 5; i++) {
    ctx2.__emit('session/event', s2, { type: 'user/message', time: 10 + i, data: textMessage(`第 ${i} 句`) })
  }
  ctx2.__emit('agent/turn-stopping', { agent: {}, turn: 1 })
  await sleep(30)
  ok('关闭自动提炼时不提炼', !fs.existsSync(path.join(tmp, 'data2', 'signals.jsonl')))
  const noModel = await ctx2.__tools.get('persona_reflect').execute({}, {})
  ok('没有模型时给出可读原因', noModel.startsWith('[没提炼：没有可用模型'), noModel)
  ok('抓取仍然工作', readLines(path.join(tmp, 'data2', 'episodes.jsonl')).length === 5)
  ok('没有片段时如实说明', noModel.includes('模型') || noModel.includes('片段'))
  ctx2.__dispose()

  // ------------------------------------------------------------ 旧档迁移
  const legacyDir = path.join(tmp, 'legacy')
  fs.mkdirSync(legacyDir, { recursive: true })
  fs.writeFileSync(
    path.join(legacyDir, 'persona.json'),
    JSON.stringify({
      version: 1,
      createdAt: Date.now() - 5 * 86400000,
      name: '老名字',
      voice: '旧口吻',
      summary: '',
      traits: [
        { key: 'k', text: '旧版里的一条', dimension: '性格', score: 0.8, hits: 4, firstSeen: 1, lastSeen: 2, source: 'auto', pinned: false },
        { key: 'k2', text: '旧版钉住的一条', dimension: '人工', score: 0.9, hits: 1, firstSeen: 1, lastSeen: 2, source: 'human', pinned: true },
      ],
    }),
    'utf8',
  )
  const ctx3 = makeCtx({ llm: null, selection: null })
  plugin.apply(ctx3, { dataDir: legacyDir })
  const migrated = readLines(path.join(legacyDir, 'signals.jsonl'))
  ok('旧档被迁移成信号流', migrated.length >= 2, `${migrated.length} 行`)
  ok('迁移保留「提过几次」', migrated.some((l) => l.includes('"carriedMentions":4')))
  ok('迁移保留钉住', migrated.some((l) => l.includes('"pinned":true')))
  const legacyCard = ctx3.__contexts[0].text()
  ok('迁移后人格卡念得出来', legacyCard.includes('旧版里的一条') && legacyCard.includes('反复想起过的'), legacyCard.slice(0, 80))
  ok('迁移后名字还在', legacyCard.includes('老名字'))
  ctx3.__dispose()

  // ------------------------------------------------- 有种子 / 不开注入
  const seedFile = path.join(tmp, 'seed.md')
  fs.writeFileSync(seedFile, '# 种子\n- 有点懒，承认自己懒\n', 'utf8')
  const ctx4 = makeCtx({ llm: null, selection: null })
  plugin.apply(ctx4, { dataDir: path.join(tmp, 'data4'), seedPath: seedFile, personaName: '大肥鱼' })
  const seeded = ctx4.__contexts[0].text()
  ok('起步人设被导入并注入', seeded.includes('有点懒') && seeded.includes('起步人设'), seeded.slice(0, 80))
  ok('起点人设不算她自己长出来的', !seeded.includes('反复想起过的（这些已经站住了'), 'seeded card 里不应出现站住条目')
  ok('种子被整份复制进人格库', fs.readFileSync(path.join(tmp, 'data4', 'seed.md'), 'utf8').includes('有点懒'))
  ctx4.__dispose()

  const ctx5 = makeCtx({ llm: null, selection: null })
  plugin.apply(ctx5, { dataDir: path.join(tmp, 'data5'), injectPersona: false })
  ok('injectPersona=false 时不注册提示词', ctx5.__sections.length === 0 && ctx5.__contexts.length === 0)
  ok('工具仍然注册', ctx5.__tools.size === 6)
  ctx5.__dispose()

  // ------------------------------------- 零依赖装配（复制目录安装的真实形状）
  // 这一份副本**没有任何 node_modules**：@deepseek-ai/schemastery 也解析不到。
  // 插件必须照样加载、照样注册工具，配置退回到人格库里的 config.json。
  // 注意：必须放在 tmp 之外，否则会往上走找到上面造的假包。
  const bareRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-persona-bare-'))
  const bareDir = path.join(bareRoot, 'bare')
  fs.mkdirSync(bareDir, { recursive: true })
  for (const file of MODULES) fs.copyFileSync(path.join(here, file), path.join(bareDir, file))
  fs.writeFileSync(path.join(bareDir, 'package.json'), JSON.stringify({ name: 'bare', private: true, type: 'module' }), 'utf8')
  const bare = await import(`file://${path.join(bareDir, 'index.js').replace(/\\/g, '/')}`)
  ok('没有任何 @deepseek-ai 包也能加载', bare.name === 'dsh-persona')
  ok('拿不到 schemastery 时 Config 为 undefined', bare.Config === undefined)

  const bareData = path.join(bareRoot, 'bare-data')
  fs.mkdirSync(bareData, { recursive: true })
  fs.writeFileSync(
    path.join(bareData, 'config.json'),
    JSON.stringify({ personaName: '配置文件里的她', distillEnabled: false }),
    'utf8',
  )
  const ctx6 = makeCtx({ llm: null, selection: null })
  bare.apply(ctx6, { dataDir: bareData })
  ok('零依赖时工具照样注册', ctx6.__tools.size === 6, `${ctx6.__tools.size}`)
  ok('配置从 config.json 读到', ctx6.__sections[0].text.includes('配置文件里的她'))
  const stats6 = JSON.parse(await ctx6.__tools.get('persona_stats').execute({}))
  ok('config.json 里的 distillEnabled 生效', stats6.自动提炼 === false)
  ctx6.__dispose()
  fs.rmSync(bareRoot, { recursive: true, force: true })
} finally {
  cleanup()
}

console.log('')
console.log(`${pass} 通过 / ${fail} 失败`)
if (fail) {
  console.log(`失败项：${failures.join('、')}`)
  process.exitCode = 1
}
