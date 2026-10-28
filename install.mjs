#!/usr/bin/env node
/**
 * dsh-persona 安装器 —— 一条命令装完，可重复执行（幂等）。
 *
 *   node install.mjs                                  # 装进默认 profile（desktop）
 *   node install.mjs --seed "D:\path\persona.md" --name 大肥鱼
 *   node install.mjs --mode junction                  # 开发用：profile 里放 junction 指向本目录
 *   node install.mjs --dry-run                        # 只打印打算做什么
 *   node install.mjs --dsh-home "C:\tmp\dsh-test"     # 装进临时 DSH_HOME（自测用）
 *
 * 它做四件事，全部幂等：
 *   1. 把包放进 <profile>\node_modules\dsh-persona（复制或 junction）
 *   2. 在 <profile>\cordis.patch.yml 末尾插一行（已经有就不插）
 *   3. 在 <profile>\package.json 的 dependencies 里登记 link:（防止以后 pnpm 清理时被 prune）
 *   4. 写 <dsh-home>\persona\config.json（已经有了就跳过，除非 --force）
 *
 * 为什么不用 plugin_manager / dsh plugin add：
 *   那条路会跑 pnpm，而 pnpm 会把 profile 里不在 package.json 的包全部 prune 掉，
 *   并且在这台机器上出现过「pnpm 已经跑完但宿主等到超时、判失败、留下半装状态」。
 *   本插件零依赖，复制目录就够，不需要 pnpm。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'))
const ROW_ID = 'persona-memory'
const LEGACY_IDS = ['persona'] // 早期手动装可能用过的 id
const SKIP_COPY = new Set(['node_modules', '.git', 'dsh-fish'])

const DEFAULT_CONFIG = {
  personaName: '',
  seedPath: '',
  distillEvery: 10,
  distillMinIntervalMs: 300000,
  solidMentions: 3,
  solidVerified: 2,
  captureAssistant: true,
  episodeRetentionDays: 30,
  maxInjectChars: 3000,
  maxSeedChars: 2800,
}

// ----------------------------------------------------------------- 参数

export function parseArgs(argv) {
  const out = { profile: 'desktop', mode: 'copy', force: false, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    if (arg === '--profile') out.profile = next()
    else if (arg === '--dsh-home') out.dshHome = next()
    else if (arg === '--seed') out.seed = next()
    else if (arg === '--name') out.name = next()
    else if (arg === '--mode') out.mode = next()
    else if (arg === '--force') out.force = true
    else if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--purge') out.purge = true
    else throw new Error(`未知参数：${arg}`)
  }
  return out
}

export function resolvePaths(options = {}) {
  const dshHome = options.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const profile = options.profile || 'desktop'
  const profileDir = path.join(dshHome, 'profiles', profile)
  return {
    dshHome,
    profile,
    profileDir,
    packageTarget: path.join(profileDir, 'node_modules', PKG.name),
    patchFile: path.join(profileDir, 'cordis.patch.yml'),
    manifestFile: path.join(profileDir, 'package.json'),
    dataDir: path.join(dshHome, 'persona'),
    configFile: path.join(dshHome, 'persona', 'config.json'),
  }
}

// ------------------------------------------------------------ 小工具

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** 目录链接（Windows 用 junction，不需要管理员权限）。 */
function makeJunction(linkPath, target) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true })
  fs.symlinkSync(target, linkPath, 'junction')
}

function isLink(dir) {
  try {
    return fs.lstatSync(dir).isSymbolicLink()
  } catch {
    return false
  }
}

function removePath(dir) {
  if (isLink(dir)) {
    fs.unlinkSync(dir) // 只删链接，不动目标目录
    return
  }
  fs.rmSync(dir, { recursive: true, force: true })
}

/** 插件的 patch 行。字段顺序固定，避免重复执行时产生 diff。 */
export function patchBlock() {
  return [
    `# ${PKG.name} · 人格记忆：配置在 <DSH_HOME>${path.sep}persona${path.sep}config.json`,
    '# 注意：这里不写 config 块。引擎拿不到 schemastery 时本插件没有 Config schema，',
    '# 带 config 的行可能整行被拒；配置一律走上面那个 config.json。',
    '- insert:',
    `    - id: ${ROW_ID}`,
    `      name: ${PKG.name}`,
    '',
  ].join('\n')
}

/** 已经有本插件的行了吗？认得早期手动装用过的 id。 */
export function hasRow(text) {
  const ids = [ROW_ID, ...LEGACY_IDS]
  return ids.some((id) => new RegExp(`^\\s*-\\s*id:\\s*${id}\\s*$`, 'm').test(text))
}

// ------------------------------------------------------------- 安装

export function runInstall(options = {}) {
  const p = resolvePaths(options)
  const log = []
  const say = (msg) => log.push(msg)

  if (!fs.existsSync(p.profileDir)) {
    throw new Error(`找不到 profile 目录：${p.profileDir}\n先用 DSH 建一个 profile，或者用 --profile 指定名字。`)
  }

  // 1. 包
  const mode = options.mode || 'copy'
  if (options.dryRun) {
    say(`[计划] ${mode === 'junction' ? '建 junction' : '复制'} → ${p.packageTarget}`)
  } else {
    removePath(p.packageTarget)
    if (mode === 'junction') {
      makeJunction(p.packageTarget, HERE)
      say(`已建 junction：${p.packageTarget} → ${HERE}`)
    } else {
      fs.mkdirSync(path.dirname(p.packageTarget), { recursive: true })
      fs.cpSync(HERE, p.packageTarget, {
        recursive: true,
        filter: (src) => !SKIP_COPY.has(path.basename(src)),
      })
      say(`已复制包：${p.packageTarget}`)
    }
  }

  // 2. patch 行
  const patchText = fs.existsSync(p.patchFile) ? fs.readFileSync(p.patchFile, 'utf8') : ''
  if (hasRow(patchText)) {
    say('patch 行已存在，跳过（不重复插）')
  } else if (options.dryRun) {
    say(`[计划] 追加 patch 行 → ${p.patchFile}`)
  } else {
    const prefix = patchText.length && !patchText.endsWith('\n') ? '\n' : ''
    const gap = patchText.length ? '\n' : ''
    fs.writeFileSync(p.patchFile, `${patchText}${prefix}${gap}${patchBlock()}`, 'utf8')
    say(`已追加 patch 行 → ${p.patchFile}`)
  }

  // 3. dependencies 登记（防 pnpm prune）
  const manifest = readJson(p.manifestFile, { name: `dsh-profile-${p.profile}`, private: true })
  const spec = `link:${HERE.replace(/\\/g, '/')}`
  const already = manifest.dependencies && manifest.dependencies[PKG.name] === spec
  if (already) {
    say('dependencies 已登记，跳过')
  } else if (options.dryRun) {
    say(`[计划] dependencies["${PKG.name}"] = "${spec}"`)
  } else {
    manifest.dependencies = { ...(manifest.dependencies || {}), [PKG.name]: spec }
    writeJson(p.manifestFile, manifest)
    say(`已登记 dependencies["${PKG.name}"] = ${spec}`)
  }

  // 4. 数据目录配置
  const configExists = fs.existsSync(p.configFile)
  if (configExists && !options.force) {
    say('config.json 已存在，跳过（要覆盖加 --force）')
  } else if (options.dryRun) {
    say(`[计划] 写 config.json → ${p.configFile}`)
  } else {
    const config = { ...DEFAULT_CONFIG }
    if (options.name) config.personaName = String(options.name)
    if (options.seed) config.seedPath = path.resolve(options.seed)
    writeJson(p.configFile, config)
    say(`已写 config.json → ${p.configFile}`)
  }

  return { ...p, log, changed: !options.dryRun }
}

// ------------------------------------------------------------- 卸载

export function runUninstall(options = {}) {
  const p = resolvePaths(options)
  const log = []
  const say = (msg) => log.push(msg)

  if (fs.existsSync(p.packageTarget)) {
    if (options.dryRun) say(`[计划] 删除 ${p.packageTarget}`)
    else {
      removePath(p.packageTarget)
      say(`已删除包：${p.packageTarget}`)
    }
  } else {
    say('包不在 profile 里，跳过')
  }

  if (fs.existsSync(p.patchFile)) {
    const text = fs.readFileSync(p.patchFile, 'utf8')
    const filtered = text
      .split(/\r?\n/)
      .filter((line) => !/^\s*#\s*dsh-persona /.test(line))
      .join('\n')
      // 整块删掉：注释 + insert 行
      .replace(/\n*- insert:\n(?:[ \t]+-?[^\n]*\n)*?[ \t]+- id: (?:persona-memory|persona)\n(?:(?!- (?:id|insert):)[^\n]*\n)*/g, '\n')
    if (filtered !== text) {
      if (options.dryRun) say('[计划] 删除 patch 行')
      else {
        fs.writeFileSync(p.patchFile, filtered, 'utf8')
        say(`已删除 patch 行 → ${p.patchFile}`)
      }
    } else {
      say('patch 里没有本插件的行，跳过')
    }
  }

  const manifest = readJson(p.manifestFile)
  if (manifest && manifest.dependencies && manifest.dependencies[PKG.name]) {
    if (options.dryRun) say(`[计划] 删除 dependencies["${PKG.name}"]`)
    else {
      delete manifest.dependencies[PKG.name]
      writeJson(p.manifestFile, manifest)
      say(`已删除 dependencies["${PKG.name}"]`)
    }
  }

  if (options.purge) {
    if (options.dryRun) say(`[计划] 删除人格库 ${p.dataDir}`)
    else {
      fs.rmSync(p.dataDir, { recursive: true, force: true })
      say(`已删除人格库：${p.dataDir}`)
    }
  } else {
    say(`人格库保留在 ${p.dataDir}（要一起删加 --purge）`)
  }

  return { ...p, log }
}

// --------------------------------------------------------------- CLI

function usage() {
  console.log(`dsh-persona 安装器 v${PKG.version}

  node install.mjs [选项]

  --profile <名>     目标 profile，默认 desktop
  --dsh-home <目录>  DSH 主目录，默认 $DSH_HOME 或 ~/.dsh
  --seed <文件>      起步人设文件（写进 config.json 的 seedPath）
  --name <名字>      她自己叫什么
  --mode <copy|junction>  复制（默认，稳定）或 junction（开发用）
  --force            覆盖已存在的 config.json
  --dry-run          只打印计划，不落盘

卸载：node install.mjs --uninstall [--purge]
`)
}

function main(argv) {
  const options = parseArgs(argv)
  if (options.help) {
    usage()
    return 0
  }
  const isUninstall = argv.includes('--uninstall')
  const result = isUninstall ? runUninstall(options) : runInstall(options)
  for (const line of result.log) console.log(`· ${line}`)

  if (!isUninstall) {
    console.log('')
    console.log(`下一步：关掉 DSH 再重开（宿主只在启动时读 patch，热重载不可靠）。`)
    console.log(`重开后新会话里执行 persona_stats 验证：`)
    console.log(`  · records/signals 会随对话增长`)
    console.log(`  · 人格卡在 system prompt 里（【人格状态】）`)
    console.log(`人格库：${result.dataDir}`)
  }
  return 0
}

const invokedDirectly = (() => {
  try {
    return path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (err) {
    console.error(`安装失败：${err && err.message ? err.message : err}`)
    process.exitCode = 1
  }
}
