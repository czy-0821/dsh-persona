import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PersonaStore } from './store.js'
// 热重载探测点：profile 里的插件是指向本目录的 junction，
// 宿主监视的是**模块文件**（index.js/*.js），不是 cordis.patch.yml。
// 所以改配置后想让运行中的实例生效，改一行注释就够了，不必重启 DSH。
import { DEFAULTS, deriveSignals, foldedLine, similarity } from './persona.js'
import { renderRules, renderContext } from './prompt.js'
import { distillOnce } from './distill.js'

export const name = 'dsh-persona'

/**
 * 两条硬依赖：
 *   tools        注册 persona_* 工具
 *   systemPrompt 把此刻的她挂进每轮提示词（不然人格只是磁盘上的字）
 * 其余（llm / agentDefaultModel）用 ctx.get 取，缺了也不该让插件装不上。
 */
export const inject = ['tools', 'systemPrompt']

/**
 * 为什么这里不 import 宿主的 @deepseek-ai/dsh-tools（学自 dsh-fish 的两次真机事故；
 * 本机实测同样解析不到：从 profile 的 node_modules 往上找，没有 @deepseek-ai/*）：
 *
 *   宿主的 defineTool 要的是「简写参数 DSL」，它替你编成 JSON Schema。
 *   但那个包能不能解析到，取决于装法：
 *     · 以 link:/复制目录装 → 从插件目录往上走找不到它（实测本机 profile 里就没有），
 *       import 直接抛，插件整个不加载；
 *     · 以 npm/包管理装 → 找到了，于是 defineTool 真的被调用，参数形态必须对。
 *   两条路要的行为不一样，靠 try/catch 兜底也只会在某一条路上对。
 *
 *   唯一的稳法：**不 import 它**，注册时直接交标准 JSON Schema。
 *   宿主 registry 只校验 output.schema，parameters 原样交给 provider，
 *   而 provider 要的就是 JSON Schema —— 中间不需要任何人替我们编译。
 */
const defineTool = (spec) => spec

/** 参数表 → 标准 JSON Schema（必填走根级 required 数组，属性上的 required 会被忽略）。 */
export function paramSchema(properties = {}, required = []) {
  return { type: 'object', properties, required, additionalProperties: false }
}
const str = (description, extra = {}) => ({ type: 'string', description, ...extra })
const num = (description) => ({ type: 'number', description })
const bool = (description) => ({ type: 'boolean', description })

const CONFIG_DEFAULTS = {
  dataDir: '',
  personaName: '',
  seedPath: '',
  captureUser: true,
  captureAssistant: true,
  captureMaxChars: 600,
  episodeRetentionDays: 30,
  episodeMaxRows: 5000,
  distillEnabled: true,
  distillEvery: 10,
  distillMinIntervalMs: 300000,
  distillMaxEpisodes: 40,
  distillProvider: '',
  distillModel: '',
  distillTemperature: 0.2,
  solidMentions: DEFAULTS.solidMentions,
  solidVerified: DEFAULTS.solidVerified,
  maxTraits: DEFAULTS.maxTraits,
  traitHalfLifeDays: DEFAULTS.halfLifeDays,
  traitFloor: DEFAULTS.floor,
  maxFoldedShown: DEFAULTS.maxFoldedShown,
  injectPersona: true,
  injectOrder: 700,
  maxInjectChars: 3000,
  maxSeedChars: 2800,
}

/**
 * 配置：有 schemastery 就用它（宿主的正式契约），没有也不让插件加载失败。
 * 拿不到 Schema 时 Config 为 undefined，配置改从人格库里的 config.json 读 ——
 * 这样「复制目录安装」在没有任何依赖的情况下也能配。
 */
let Schema = null
try {
  Schema = (await import('@deepseek-ai/schemastery')).default
} catch {
  Schema = null
}

export const Config =
  Schema && typeof Schema.object === 'function'
    ? Schema.object({
        dataDir: Schema.string().default(CONFIG_DEFAULTS.dataDir).description('人格库目录，留空用 $DSH_HOME/persona'),
        personaName: Schema.string().default(CONFIG_DEFAULTS.personaName).description('她自己叫什么'),
        seedPath: Schema.string().default(CONFIG_DEFAULTS.seedPath).description('起步人设文件（可选）'),
        captureUser: Schema.boolean().default(CONFIG_DEFAULTS.captureUser).description('自动记对方说的话'),
        captureAssistant: Schema.boolean().default(CONFIG_DEFAULTS.captureAssistant).description('自动记她自己说的话'),
        captureMaxChars: Schema.number().default(CONFIG_DEFAULTS.captureMaxChars).description('单条片段字符上限'),
        episodeRetentionDays: Schema.number().default(CONFIG_DEFAULTS.episodeRetentionDays).description('片段保留天数'),
        episodeMaxRows: Schema.number().default(CONFIG_DEFAULTS.episodeMaxRows).description('片段最多条数'),
        distillEnabled: Schema.boolean().default(CONFIG_DEFAULTS.distillEnabled).description('是否允许后台自动提炼'),
        distillEvery: Schema.number().default(CONFIG_DEFAULTS.distillEvery).description('每多少条新片段提炼一次'),
        distillMinIntervalMs: Schema.number()
          .default(CONFIG_DEFAULTS.distillMinIntervalMs)
          .description('两次自动提炼的最小间隔（毫秒）'),
        distillMaxEpisodes: Schema.number().default(CONFIG_DEFAULTS.distillMaxEpisodes).description('一次提炼最多读多少片段'),
        distillProvider: Schema.string().default(CONFIG_DEFAULTS.distillProvider).description('提炼用 provider'),
        distillModel: Schema.string().default(CONFIG_DEFAULTS.distillModel).description('提炼用模型'),
        distillTemperature: Schema.number().default(CONFIG_DEFAULTS.distillTemperature).description('提炼温度'),
        solidMentions: Schema.number().default(CONFIG_DEFAULTS.solidMentions).description('提过几次才算站住'),
        solidVerified: Schema.number().default(CONFIG_DEFAULTS.solidVerified).description('被验证几次才算站住'),
        maxTraits: Schema.number().default(CONFIG_DEFAULTS.maxTraits).description('人格卡最多几条'),
        traitHalfLifeDays: Schema.number().default(CONFIG_DEFAULTS.traitHalfLifeDays).description('倾向半衰期（天）'),
        traitFloor: Schema.number().default(CONFIG_DEFAULTS.traitFloor).description('多低就折叠'),
        maxFoldedShown: Schema.number().default(CONFIG_DEFAULTS.maxFoldedShown).description('折叠行最多列几条'),
        injectPersona: Schema.boolean().default(CONFIG_DEFAULTS.injectPersona).description('是否注入人格卡'),
        injectOrder: Schema.number().default(CONFIG_DEFAULTS.injectOrder).description('人格段排序'),
        maxInjectChars: Schema.number().default(CONFIG_DEFAULTS.maxInjectChars).description('人格卡字符上限'),
        maxSeedChars: Schema.number().default(CONFIG_DEFAULTS.maxSeedChars).description('起步人设字符上限'),
      })
    : undefined

const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

/** 从消息的内容块里取纯文本（图片、附件、工具块一律跳过）。 */
function textOfMessage(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  const parts = []
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

function safeOrder(resolve, fallback) {
  try {
    const value = resolve()
    return Number.isFinite(value) ? value : fallback
  } catch {
    return fallback
  }
}

/**
 * 人格库里的 config.json。
 * 拿不到 schemastery 时 patch 里的 config 可能根本到不了插件（Config 为 undefined），
 * 所以配置的第二个入口是数据目录里的一个 JSON 文件；patch 里写了的键优先。
 */
function readConfigFile(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

export function apply(ctx, config) {
  const base = { ...CONFIG_DEFAULTS, ...(config || {}) }
  const dataRoot = base.dataDir || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'persona')
  // 优先级：patch/ctx 配置 > 数据目录 config.json > 内置默认
  const settings = { ...base, ...readConfigFile(dataRoot), ...(config || {}) }
  const root = settings.dataDir || dataRoot
  const store = new PersonaStore(root)
  const logger = typeof ctx.logger === 'function' ? ctx.logger('persona') : console
  let distilling = false

  const deriveOpts = () => ({
    solidMentions: settings.solidMentions,
    solidVerified: settings.solidVerified,
    halfLifeDays: settings.traitHalfLifeDays,
    floor: settings.traitFloor,
    maxTraits: settings.maxTraits,
    maxFoldedShown: settings.maxFoldedShown,
    now: Date.now(),
  })
  const cardOptions = () => ({
    maxChars: settings.maxInjectChars,
    maxFoldedShown: settings.maxFoldedShown,
    maxSeedChars: settings.maxSeedChars,
    seedText: readSeed(),
    personaName: settings.personaName,
    now: Date.now(),
  })

  /** 此刻的她：永远由信号流现算，不从缓存读（缓存只是给人看的副本）。 */
  const currentModel = () => deriveSignals(store.records(), deriveOpts())
  const refreshCache = () => {
    const model = currentModel()
    const { counts, name, voice, summary, traits } = model
    store.writeCache({
      records: counts.records,
      name,
      voice,
      summary,
      traits: traits.map((t) => ({
        text: t.text,
        dimension: t.dimension,
        mentions: t.mentions,
        solid: t.solid,
        pinned: t.pinned,
      })),
    })
    return model
  }

  // ------------------------------------------------------- 种子与旧档迁移

  const seedFile = path.join(root, 'seed.md')
  const seedCache = { key: '', text: '' }
  /** 起步人设：复制进人格库一份，内容变了才重读。永不抛。 */
  const readSeed = () => {
    try {
      const st = fs.statSync(seedFile)
      const key = `${st.size}:${st.mtimeMs}`
      if (seedCache.key !== key) {
        seedCache.text = fs.readFileSync(seedFile, 'utf8')
        seedCache.key = key
      }
      return seedCache.text
    } catch {
      return ''
    }
  }

  const importSeed = () => {
    const raw = String(settings.seedPath || '').trim()
    if (!raw) return
    const abs = path.isAbsolute(raw) ? raw : path.resolve(raw)
    try {
      if (!fs.existsSync(abs)) {
        logger.warn?.(`persona 种子文件不存在：${abs}`)
        return
      }
      // 种子不是「她长出来的东西」，所以不进信号流：整份复制进人格库，
      // 由人格卡的「起步人设」那一段只读引用，且最先被预算裁掉。
      const text = fs.readFileSync(abs, 'utf8')
      if (!fs.existsSync(seedFile) || fs.readFileSync(seedFile, 'utf8') !== text) {
        fs.writeFileSync(seedFile, text, 'utf8')
        seedCache.key = ''
        logger.info?.(`persona 已导入起步人设：${abs} → ${seedFile}`)
      }
    } catch (e) {
      logger.warn?.(`persona 种子导入失败：${e && e.message ? e.message : e}`)
    }
  }

  /** 旧版（v1 可变快照）→ 信号流。只搬一次；搬完历史就只能追加了。 */
  const migrateLegacy = () => {
    if (store.hasRecords()) return
    const cache = store.readCache()
    if (!cache || !Array.isArray(cache.traits) || !cache.traits.length) return
    const rows = cache.traits
      .filter((t) => t && typeof t.text === 'string')
      .map((t) => ({
        text: t.text,
        dimension: t.dimension,
        weight: Math.min(1, Math.max(0.05, Number(t.score) || 0.3)),
        source: 'migrated',
        carriedMentions: Math.max(1, Number(t.hits) || 1),
        pinned: t.pinned === true,
      }))
    if (rows.length) {
      store.appendRecords('signal', rows)
      logger.info?.(`persona 已把旧版 ${rows.length} 条条目迁移成信号流`)
    }
    if (cache.name) store.appendRecords('name', [{ value: cache.name, source: 'auto' }])
    if (cache.voice) store.appendRecords('voice', [{ value: cache.voice, source: 'auto' }])
    if (cache.summary) store.appendRecords('summary', [{ value: cache.summary, source: 'auto' }])
  }

  migrateLegacy()
  importSeed()
  refreshCache()

  // ------------------------------------------------------- 模型与提炼

  const resolveModel = () => {
    if (settings.distillProvider && settings.distillModel) {
      return { provider: settings.distillProvider, model: settings.distillModel }
    }
    const service = ctx.get('agentDefaultModel')
    if (!service || typeof service.currentSelection !== 'function') return null
    try {
      const selection = service.currentSelection()
      if (selection && selection.provider && selection.model) {
        return { provider: selection.provider, model: selection.model }
      }
    } catch {
      /* 读不到默认模型就当作没配 */
    }
    return null
  }

  const runDistill = async ({ trigger = 'auto', signal, force = false } = {}) => {
    if (distilling) return { ok: false, reason: 'busy', message: '上一次提炼还没结束' }
    const target = resolveModel()
    if (!target) {
      return {
        ok: false,
        reason: 'no-model',
        message: '没有可用模型：请配置 distillProvider/distillModel，或先设置默认模型',
      }
    }
    const llm = ctx.get('llm')
    if (!llm || typeof llm.stream !== 'function') {
      return { ok: false, reason: 'no-llm', message: 'llm 服务不可用，无法提炼' }
    }
    distilling = true
    try {
      const now = Date.now()
      const runtime = store.runtime()
      // 手动提炼要真的重读最近一段，不能因为游标没动就空转
      const episodes = store.recentEpisodes(
        settings.distillMaxEpisodes,
        force ? {} : { sinceId: runtime.lastEpisodeId },
      )
      if (!episodes.length) {
        return { ok: true, added: 0, skipped: true, message: '没有新的对话片段' }
      }
      const model = currentModel()
      const result = await distillOnce({
        llm,
        provider: target.provider,
        model: target.model,
        episodes,
        state: model,
        options: {
          halfLifeDays: settings.traitHalfLifeDays,
          maxInjectChars: settings.maxInjectChars,
          personaName: settings.personaName,
        },
        signal,
        temperature: settings.distillTemperature,
      })

      const rows = result.signals.map((s) => ({ ...s, source: 'distill' }))
      if (rows.length) store.appendRecords('signal', rows)
      if (result.voice) store.appendRecords('voice', [{ value: result.voice, source: 'auto' }])
      if (result.summary) store.appendRecords('summary', [{ value: result.summary, source: 'auto' }])
      store.saveRuntime({
        lastEpisodeId: episodes[episodes.length - 1].id,
        lastDistillAt: now,
        distillRuns: runtime.distillRuns + 1,
        lastError: '',
      })
      if (store.countEpisodes() > settings.episodeMaxRows) {
        store.pruneEpisodes({
          keepDays: settings.episodeRetentionDays,
          maxRows: settings.episodeMaxRows,
          now,
        })
      }
      const after = refreshCache()
      logger.info?.(
        `persona ${trigger === 'auto' ? '自动提炼' : '提炼'}完成：新增证据 ${rows.length} 条，站住 ${after.counts.solid} 条，倾向 ${after.counts.tendencies} 条`,
      )
      return { ok: true, added: rows.length, note: result.note || '' }
    } catch (e) {
      const message = e && e.message ? String(e.message) : String(e)
      try {
        const runtime = store.runtime()
        store.saveRuntime({
          distillFailures: runtime.distillFailures + 1,
          lastError: message.slice(0, 300),
          lastDistillAt: Date.now(),
        })
      } catch {
        /* 记账失败不影响主流程 */
      }
      logger.warn?.(`persona 提炼失败：${message}`)
      return { ok: false, reason: 'error', message }
    } finally {
      distilling = false
    }
  }

  const maybeAutoDistill = () => {
    if (!settings.distillEnabled || distilling) return
    try {
      const runtime = store.runtime()
      if (Date.now() - (runtime.lastDistillAt || 0) < settings.distillMinIntervalMs) return
      const pending = store.recentEpisodes(settings.distillEvery * 4, { sinceId: runtime.lastEpisodeId })
      if (pending.length < settings.distillEvery) return
      void runDistill({ trigger: 'auto' })
    } catch (e) {
      logger.warn?.(`persona 自动提炼检查失败：${e && e.message ? e.message : e}`)
    }
  }

  // ------------------------------------------------------------ 自动抓取

  const capture = (session, event) => {
    if (!event || typeof event !== 'object') return
    // 子会话（子代理 / workflow 子任务）不是「你和对方的交流」
    if (session && session.header && session.header.origin === 'subagent') return
    let role = ''
    let message = null
    if (event.type === 'user/message' && settings.captureUser) {
      role = 'user'
      message = event.data
    } else if (event.type === 'assistant/message' && settings.captureAssistant) {
      role = 'assistant'
      message = event.data && event.data.message
    } else {
      return
    }
    let text = textOfMessage(message)
    if (!text) return
    if (/^[/!]/.test(text)) return // 人类斜杠命令不算对话
    if (text.length > settings.captureMaxChars) text = text.slice(0, settings.captureMaxChars)
    if (text.trim().length < 2) return
    const sessionId = String((session && session.id) || '')
    store.appendEpisodes([{ ts: event.time || Date.now(), sessionId, role, text }])
  }

  ctx.on('session/event', (session, event) => {
    try {
      capture(session, event)
      // `agent/turn-stopping` 在这个宿主里没派发给全局插件监听器（实测：片段攒够了、
      // 间隔也过了，distillRuns 仍是 0；手动 persona_reflect 一次就通）。
      // 所以改用更可靠的持久事件兜一次：一轮结束时检查要不要提炼。
      // 两条路都留着，重复检查由 maybeAutoDistill 自己的阈值挡掉。
      if (event && event.type === 'turn/end') maybeAutoDistill()
    } catch (e) {
      logger.warn?.(`persona 抓取失败：${e && e.message ? e.message : e}`)
    }
  })

  ctx.on('agent/turn-stopping', () => {
    try {
      maybeAutoDistill()
    } catch (e) {
      logger.warn?.(`persona 触发检查失败：${e && e.message ? e.message : e}`)
    }
  })

  // --------------------------------------------------------- 提示词注入

  if (settings.injectPersona) {
    const sectionOrder = safeOrder(() => ctx.systemPrompt.getSectionOrder('deployment:persona-suffix'), 8500)
    const contextOrder = safeOrder(() => ctx.systemPrompt.getContextOrder('runtime-context'), settings.injectOrder)

    ctx.effect(() =>
      ctx.systemPrompt.section({
        name: 'persona:rules',
        order: sectionOrder,
        // 静态规矩：不随人格变化，也不引用变量
        text: renderRules({ personaName: settings.personaName }),
      }),
    )
    ctx.effect(() =>
      ctx.systemPrompt.context({
        name: 'persona:state',
        order: contextOrder,
        text: () => {
          try {
            return renderContext(currentModel(), cardOptions())
          } catch {
            return ''
          }
        },
      }),
    )
  }

  // ------------------------------------------------------------- 工具
  // 回执一律是机器回执（`[已记下]`），不写成她可以照抄的句子，
  // 也不回显任何分数 —— 她看得见的东西里没有数字。

  ctx.tools.register(
    defineTool({
      name: 'persona_read',
      description: '看你现在是什么样子。人格卡里只有事实，没有分数。',
      parameters: paramSchema(),
      output: textOutput,
      async execute() {
        const card = renderContext(currentModel(), cardOptions())
        return card || '还没有。你现在还没有站住的想法——这不是空白，这是起点。'
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'persona_observe',
      description:
        '记下一条关于你自己的判断：你发现自己确实是这么想、这么做的时候用。只记倾向，不记事实流水。一次对话最多 1-2 条。',
      parameters: paramSchema(
        {
          text: str('一句具体的话（≤24 字），例如「被夸会先否认，再小声承认」'),
          dimension: str('性格 / 说话方式 / 偏好 / 态度，默认性格'),
          weight: num('你有多确定，0-1，拿不准就写低一点'),
        },
        ['text'],
      ),
      output: textOutput,
      async execute(args) {
        const text = String((args && args.text) || '').trim()
        if (!text) return '[没记下：这句是空的]'
        const written = store.appendRecords('signal', [
          { text, dimension: args.dimension, weight: args.weight, source: 'tool' },
        ])
        if (!written.length) return '[没记下：换一句更具体的说法]'
        refreshCache()
        return '[已记下]'
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'persona_recall',
      description:
        '翻你自己以前说过的话。想确认「我那时候是怎么说的」时用；只翻得到你留下的片段，翻不到就是翻不到。',
      parameters: paramSchema({
        query: str('想翻什么；留空则给最近的几句'),
        limit: num('最多几条，默认 6'),
      }),
      output: textOutput,
      async execute(args) {
        const limit = Math.max(1, Math.min(20, Number(args && args.limit) || 6))
        const mine = store.recentEpisodes(2000).filter((e) => e.role === 'assistant')
        if (!mine.length) return '翻不到。你还没说过什么。'
        const query = String((args && args.query) || '').trim()
        let picked = mine
        if (query) {
          picked = mine
            .map((e) => ({ e, s: similarity(e.text, query) }))
            .filter((x) => x.s >= 0.2 || x.e.text.includes(query))
            .sort((a, b) => b.s - a.s)
            .map((x) => x.e)
        }
        if (!picked.length) return '翻不到。也许那时候你没说过这件事。'
        return picked
          .slice(-limit)
          .map((e) => `- ${e.text}`)
          .join('\n')
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'persona_reflect',
      description: '现在就想一想最近的事：读最近一段对话，看有没有长出新的判断。平时会自己按节奏做，这里手动催一次。',
      parameters: paramSchema(),
      output: textOutput,
      async execute(_args, exec) {
        const result = await runDistill({ trigger: 'tool', signal: exec && exec.signal, force: true })
        if (!result.ok) return `[没提炼：${result.message || result.reason}]`
        if (result.skipped) return '[没提炼：没有可读的对话片段]'
        return '[提炼完成]'
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'persona_correct',
      description:
        '改口与纠偏：把一条钉住（以后不会被推翻）、撤回一条、或者改「怎么称呼对方」与自称。使用者说「你这一点不对」时用。',
      parameters: paramSchema(
        {
          action: str('pin / unpin / forget / rename / set_voice / set_summary', {
            enum: ['pin', 'unpin', 'forget', 'rename', 'set_voice', 'set_summary'],
          }),
          text: str('pin 时的内容'),
          key: str('unpin / forget 时用来定位：内容片段'),
          value: str('rename=怎么称呼对方；set_voice=口吻；set_summary=自述'),
        },
        ['action'],
      ),
      output: textOutput,
      async execute(args) {
        const action = String((args && args.action) || '').trim()
        const key = String((args && (args.key || args.text)) || '').trim()
        const value = String((args && (args.value || args.text)) || '').trim()
        const model = currentModel()

        if (action === 'pin') {
          const text = String((args && args.text) || '').trim()
          if (!text) return '[没记下：pin 需要 text]'
          store.appendRecords('signal', [{ text, dimension: '人工', weight: 1, source: 'human', pinned: true, verdict: 'confirm' }])
          refreshCache()
          return '[已钉住]'
        }
        if (action === 'unpin') {
          if (!key) return '[没改：要给 key]'
          if (!model.traits.some((t) => t.text.includes(key))) return '[没找到这一条]'
          store.appendRecords('unpin', [{ match: key }])
          refreshCache()
          return '[已解除钉住]'
        }
        if (action === 'forget') {
          if (!key) return '[没改：要给 key]'
          const target = model.traits.find((t) => t.text.includes(key))
          if (!target) return '[没找到这一条]'
          store.appendRecords('retract', [{ targets: target.members, match: key, why: 'human' }])
          refreshCache()
          return '[已撤回]'
        }
        if (action === 'rename') {
          if (!value) return '[没改：要给 value]'
          store.appendRecords('name', [{ value, source: 'human' }])
          refreshCache()
          return '[已改称呼]'
        }
        if (action === 'set_voice') {
          if (!value) return '[没改：要给 value]'
          store.appendRecords('voice', [{ value, source: 'human' }])
          refreshCache()
          return '[已改口吻]'
        }
        if (action === 'set_summary') {
          if (!value) return '[没改：要给 value]'
          store.appendRecords('summary', [{ value, source: 'human' }])
          refreshCache()
          return '[已改自述]'
        }
        return '[没改：action 只支持 pin / unpin / forget / rename / set_voice / set_summary]'
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'persona_stats',
      description: '插件自己的运行情况：片段数、信号数、提炼次数与失败原因。排查「人格怎么不长」时用。',
      parameters: paramSchema(),
      output: textOutput,
      async execute() {
        const stats = store.stats()
        const runtime = store.runtime()
        const model = currentModel()
        const pending = store.recentEpisodes(settings.distillEvery * 4, { sinceId: runtime.lastEpisodeId }).length
        return JSON.stringify(
          {
            ...stats,
            distillRuns: runtime.distillRuns,
            distillFailures: runtime.distillFailures,
            lastDistillAt: runtime.lastDistillAt || 0,
            lastError: runtime.lastError || '',
            solid: model.counts.solid,
            tendencies: model.counts.tendencies,
            待提炼片段: pending,
            触发阈值: settings.distillEvery,
            自动提炼: settings.distillEnabled,
            折叠: foldedLine(model),
          },
          null,
          2,
        )
      },
    }),
  )

  // 卸载时清理（effect 的 disposer 在插件卸载/HMR 时自动执行）
  ctx.effect(() => () => {
    logger.info?.(`persona 已卸载，人格库：${store.dir}`)
  })

  logger.info?.(
    `persona 就绪：${store.dir}（信号 ${store.countRecords()} 条，自动提炼=${settings.distillEnabled ? '开' : '关'}）`,
  )
}
