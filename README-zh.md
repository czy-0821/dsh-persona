# dsh-persona · 人格记忆

给 DSH 加一层**会长大的人格**。

`dsh-memory-whale` 记的是「他今天说了什么」，这个插件记的是「我正在变成什么样的人」。

- **自动抓**：每轮对话自动落成片段，不用模型记得调工具
- **自动提炼**：每攒够 N 条片段，用你当前的默认模型提炼一次，只提取性格/说话方式/态度，**不提取事实**
- **会站住，也会淡掉**：同一件事被提过 3 次、或被验证 2 次，才算「站住」——站住的不再随时间沉下去；没站住的按半衰期淡掉，淡掉的**折叠进「更早以前」，不删除**
- **历史只能追加**：人格是信号流算出来的，不是某次写入覆盖出来的。想改她的看法只能追加新记录或撤回旧记录
- **注入提示词**：人格卡挂在 system prompt 的动态上下文里，模型每轮都看得见
- **卡里没有数字**：她看不到自己的任何分数，只能看见事实——给她看分数，她就会照着分数演

零依赖：不 import `@deepseek-ai/dsh-tools`（工具直接交标准 JSON Schema），schemastery 拿不到也能跑。
所以**复制目录就能装**。

## Install · 安装

一条命令：

```powershell
cd F:\tool\deepseekworkspace\dsh-persona
node install.mjs --seed "F:\tool\deepseekworkspace\persona-dafeiyu.md" --name 大肥鱼
```

然后**关掉 DSH 再重开**。装完在新会话里跑一次 `persona_stats` 验证（`records` 会随对话增长）。

安装器做四件事，全部幂等（可以反复跑）：

1. 把包放进 `<profile>\node_modules\dsh-persona`
2. 在 `<profile>\cordis.patch.yml` 末尾插一行（已有就跳过）
3. 在 `<profile>\package.json` 的 `dependencies` 里登记 `link:`（防止以后 pnpm 清理时被 prune）
4. 写 `<DSH_HOME>\persona\config.json`（已有就跳过，除非 `--force`）

```powershell
node install.mjs --dry-run                        # 先看它打算做什么
node install.mjs --mode junction                  # 开发用：放链接而不是复制
node install.mjs --uninstall                      # 卸插件，人格库保留
node install.mjs --uninstall --purge              # 连人格库一起删
```

### 为什么不用面板 / `dsh plugin add`

那条路会跑 pnpm，有两件事在这台机器上真实发生过：

- **pnpm 会把 profile 里不在 `package.json` 的包全部 prune 掉**。这次实测删了 74 个包，包括插件开发指南
  `dsh-plugin-guide`（含 `dsh-plugin-dev` CLI）。
- **判成失败、留下半装状态**：pnpm 明明 1 秒就跑完了（`+ dsh-persona link:...`），
  宿主却等了 600 秒，报 `pnpm printed nothing` 超时，`package.json` 和 patch 都没写进去。

本插件零依赖，复制目录就够，完全不需要 pnpm。

### 装之前要知道的一件事

这台机器上 `@deepseek-ai/*` 从 profile 里**解析不到**（实测：
从 `desktop\node_modules` 往上 `require.resolve('@deepseek-ai/dsh-tools')` → 解析不到）。
凡是 `import` 它的插件，复制进去会**静默装死**：插件不加载、面板上也没有任何报错。
本插件因此刻意不 import 宿主的任何包（见「这套设计的来路」第 4 条）。

### 装完怎么确认

```
cordis_inspect_query  platform=host  provider=Tool     → 应该有 persona_read 等 6 个工具
```

工具都在、但人格卡没出现 → 看 `persona_stats`；两个都没有、DSH 又没报错 →
插件目录放错或 patch 行的缩进不对。兜底：换 headless profile 跑一次，`apply()` 的异常在那里才看得见。

### 改了配置怎么生效

宿主只在**启动**时读 `cordis.patch.yml` 与 `config.json`，热重载不可靠（实测改 patch 不触发、改模块时灵时不灵）。
改完配置**重启 DSH** 最稳。

## How it grows · 它怎么「长大」

```
对话 ──session/event──► episodes.jsonl          （原材料，可剪枝）
                              │
                      每 N 条 + 最短间隔
                              ▼
                   提炼（当前默认模型）
                              │  只给「这次证据多硬」和「新的/确认/推翻」
                              ▼
                   signals.jsonl                 （★ 唯一可信源，只追加）
                              │  persona.js 纯函数推导
                              │    · 相似的说法聚成一条
                              │    · 提过 3 次 / 验证 2 次 → 站住，不再下沉
                              │    · 没站住的按半衰期淡掉 → 折叠，不删除
                              │    · retract / unpin / 人工设定 都是追加一条记录
                              ▼
                    persona.json                 （派生缓存，删了会重算，结果一致）
                              │
                     人格卡 ──系统提示词上下文──► 每一轮对话
```

三个刻意的分工：

1. **模型只读「人味儿」，插件负责记账。** 模型给的是 weight（这次证据多硬）和 verdict（新的/确认/推翻），不给结论。
2. **站住与淡掉是两件事。** `solidMentions=3` / `solidVerified=2` 才站住；站住的不衰减（「反复想起过的事不会淡掉」）。
3. **忘记不是删除。** 淡掉的条目折成一行「更早以前：你说过……」，原文永远还在 `signals.jsonl` 里，她也翻得到。

## Tools · 工具

| 工具 | 用途 |
|---|---|
| `persona_read` | 看此刻的她（只有事实，没有分数） |
| `persona_observe` | 记下一条自己的判断 |
| `persona_recall` | 翻自己以前说过的话 |
| `persona_reflect` | 立刻提炼一次 |
| `persona_correct` | 钉住 / 撤回 / 改对方称呼 / 改口吻 / 改自述 |
| `persona_stats` | 插件运行情况（片段数、信号数、提炼失败原因） |

**回执一律是机器回执**：`[已记下]`、`[已撤回]`、`[没记下：这句是空的]`。
不写成她可以照抄的句子，也不回显任何分数——否则模型会把工具返回的话当自己的话接着说。

平时**不需要模型调任何工具**：抓取和提炼都是插件自己做的。

## Config · 配置项

配置只有**一个**入口：`<DSH_HOME>\persona\config.json`（安装器会写一份默认的）。
不写 `cordis.patch.yml` 的 `config:` 块——宿主的 schemastery 拿不到时本插件的 `Config` 是 `undefined`，
带 config 的行可能整行被拒。改完重启 DSH 生效。

| 键 | 默认 | 说明 |
|---|---|---|
| `dataDir` | `$DSH_HOME/persona` | 人格库目录 |
| `personaName` | 空 | **她自己**叫什么（写进「现在」那段）；怎么称呼对方另由 `persona_correct rename` 定 |
| `seedPath` | 空 | 起步人设文件：整份复制进人格库，作为「起步人设」段只读注入，且最先被预算裁掉（例如现成的 `persona-dafeiyu.md`） |
| `captureUser` | `true` | 自动记对方说的话 |
| `captureAssistant` | `true` | 自动记她自己说的话（关掉可减少自我强化） |
| `captureMaxChars` | `600` | 单条片段最多存多少字 |
| `episodeRetentionDays` | `30` | 片段保留天数 |
| `episodeMaxRows` | `5000` | 片段最多保留条数 |
| `distillEnabled` | `true` | 关掉后只能手动 `persona_reflect` |
| `distillEvery` | `10` | 攒够多少条新片段触发一次提炼 |
| `distillMinIntervalMs` | `300000` | 两次自动提炼的最小间隔 |
| `distillMaxEpisodes` | `40` | 一次提炼最多读多少条片段 |
| `distillProvider` / `distillModel` | 空 | 提炼用哪个模型；留空 = 默认模型 |
| `distillTemperature` | `0.2` | 提炼温度 |
| `solidMentions` | `3` | 提过几次才算站住 |
| `solidVerified` | `2` | 被验证几次才算站住（人工钉住直通） |
| `maxTraits` | `16` | 人格卡里最多放几条，多出来的折叠 |
| `traitHalfLifeDays` | `30` | 没站住的倾向多久淡掉 |
| `traitFloor` | `0.12` | 淡到多低就折叠进「更早以前」 |
| `maxFoldedShown` | `3` | 「更早以前」一行最多列几条 |
| `injectPersona` | `true` | 是否注入人格卡 |
| `injectOrder` | `700` | 人格卡在运行上下文里的排序 |
| `maxInjectChars` | `900` | 人格卡字符上限 |
| `maxSeedChars` | `1200` | 注入种子人设的字符上限 |

## Files · 文件

全部在 `$DSH_HOME/persona/`：

| 文件 | 是什么 | 能不能手改 |
|---|---|---|
| `signals.jsonl` | **唯一可信源**，一行一条，只追加 | 只能追加。改它 = 改她的记忆 |
| `episodes.jsonl` | 对话片段（原材料），可剪枝 | 可以，丢了不影响人格 |
| `persona.json` | 派生缓存，删掉会由信号流重算 | 改了没意义（下次覆盖） |
| `runtime.json` | 插件账本：提炼游标、失败次数 | 可以，坏了最多重读一段对话 |
| `config.json` | 可选的配置入口（复制目录安装时用这个） | 可以，键名见上面的配置表 |
| `seed.md` | 起步人设的副本（`seedPath` 指过来的那份） | 可以，改完下一轮就生效 |

`persona.json` 是派生品这条由测试守着：删掉它 → 重算 → 与之前一致。

想让某句话永不被推翻：`persona_correct action=pin text="..."`。
想让她忘掉一条：`persona_correct action=forget key="..."`——**追加一条 retract，不删任何一行**。

## Design debts · 这套设计的来路

四条是从 [ssamurias/dsh-fish](https://github.com/ssamurias/dsh-fish)（MIT）学来的，只借思路不借代码：

1. **历史只能追加，状态是派生的。** 它把 `events.jsonl` 当唯一可信源，`state.json` 随时可由 `rebuild()` 重算；这里对应 `signals.jsonl` 与 `persona.json`。
2. **不能读自己的数值。** 它把「不让她看见自己的参数」做成代码级保证（物理层不进提示词）；这里落到人格卡：**卡里一个分数都不出现**，连规则段也不教她读分数。
3. **工具回执不写成她能复述的句子。** 它踩过「回执被当成她自己的话，AI 味重」；这里所有回执都是 `[已记下]` 这种方括号机器回执。
4. **不 import 宿主的 `@deepseek-ai/dsh-tools`，注册时直接交标准 JSON Schema。** 它被这条坑过两次：`link:` 装时那个包解析不到（参数原样发给 provider → `schema must be a JSON Schema of type: object`），npm 装时又能解析到（`defineTool` 把根上的 `type: 'object'` 当成一个叫 `type` 的参数 → 工具全部注册失败）。这里照它的结论办：**不 import，就不存在这两种形态的差别**。

没有搬的：它的 B 站接触面、四个阶段与三道瓶颈、web 观测台。那是一个完整产品，这里只做人格这一层。

## Known limits · 红线与已知限制

- **提炼会花 token**：每次提炼 = 一次小模型调用。嫌贵就调大 `distillEvery` / `distillMinIntervalMs`，或关掉 `distillEnabled`。
- **人格会漂**：模型可能把某句话读得过重。对策是固化门槛 + 衰减 + 人工 `pin`；跑偏了就 `persona_correct`。
- **信号流不会自动瘦身**：它只追加。一年几百条没问题；真到了几千条，导出的 `persona.json` 仍然是当前状态，够看。
- **不看图片**：只抓文本块；子会话（子代理、workflow 子任务）的对话也不抓。
- **片段是明文**：`episodes.jsonl` 里是原始对话。别放同步盘；敏感项目建议关掉 `captureUser` 或调小 `episodeRetentionDays`。
- **并发是「锁 + 追加」不是事务**：极端情况下（同毫秒双写）可能丢一条，但不会写坏历史。
- 静态检查 `dsh-plugin-dev check` 有一项不满足：`manifest-files` 要求 `lib`/`dist` 构建目录（本插件是纯 JS，源码在根目录，和 `dsh-memory-whale` 一致）。只对 npm 发布有意义。

## Self-test · 自测

```powershell
cd F:\tool\deepseekworkspace\dsh-persona
node smoke.mjs               # 纯逻辑 + 存储，70 项
node smoke.integration.mjs   # 装配：假 ctx 跑 apply()，63 项
node smoke.install.mjs       # 安装器：临时 DSH_HOME 里装一遍/再装一遍/卸一遍，35 项
```

`smoke.mjs` 覆盖：信号流追加/撤回/解除钉住、人工设定压住自动的、相似合并、固化门槛、站住不衰减、淡掉折叠（不删除）、条目上限只折叠、人格卡无数字、字符上限、chunk 流收口、解析容错，以及「删掉 persona.json 重算结果一致」。

`smoke.integration.mjs` 用假的 `@deepseek-ai` 包在临时目录里真跑 `apply()`：工具注册、分层规则段、抓取过滤、到阈值自动提炼、机器回执、`persona_recall`、人工钉住与撤回（撤回后历史仍完整）、人工口吻压住自动的、没有模型时的降级、旧档迁移、起步人设注入、`injectPersona=false`。

## 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| `persona_stats` 里 `distillFailures` 一直涨 | 提炼用的模型调不通 | 看 `lastError`；显式配 `distillProvider`/`distillModel` |
| 片段在涨但人格卡不动 | 没到 `distillEvery` 阈值，或 `distillEnabled=false` | 调小阈值，或手动 `persona_reflect` |
| 改了配置不生效 | 宿主只在**模块文件**变化时热重载，不监听 `cordis.patch.yml` 与 `config.json` | 改一行 `index.js` 注释即可（profile 里的插件是指向源码目录的 junction），或重启 DSH |
| 人格卡里只有「现在」 | 还没有任何信号 | 先 `persona_observe` 一条，或聊够一轮让提炼跑一次 |
| 人格卡根本没进提示词 | `injectPersona=false` | 检查配置 |
| 她说话不像卡里那样 | 卡被 `maxInjectChars` 截断了 | 调大上限，或减少条目（`maxTraits`） |
| 插件装上了但没反应 | 宿主 `apply()` 抛错在 web 下可能完全不可见 | 换 headless profile 复现，看日志里的 `persona` 行 |
