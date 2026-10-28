// 安装器自测：在临时 DSH_HOME 里真跑一遍 install / 再跑一遍 / uninstall。
// 不碰真实 profile。node smoke.install.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hasRow, patchBlock, runInstall, runUninstall, resolvePaths } from './install.mjs'

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-persona-install-'))
const profileDir = path.join(tmp, 'profiles', 'desktop')
fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true })

try {
  const p = resolvePaths({ dshHome: tmp, profile: 'desktop' })
  ok('路径解析：profile 目录', p.profileDir === profileDir)
  ok('路径解析：数据目录在 DSH_HOME 下', p.configFile === path.join(tmp, 'persona', 'config.json'))

  // ---------------------------------------------------------------- 首次装
  const first = runInstall({ dshHome: tmp, profile: 'desktop', name: '大肥鱼' })
  ok('装了包', fs.existsSync(path.join(p.packageTarget, 'index.js')))
  ok('包里有 install.mjs 之外的核心文件', fs.existsSync(path.join(p.packageTarget, 'persona.js')))
  ok('没有把 node_modules 复制进去', !fs.existsSync(path.join(p.packageTarget, 'node_modules')))
  ok('patch 行写进去了', hasRow(fs.readFileSync(p.patchFile, 'utf8')))
  const manifest = JSON.parse(fs.readFileSync(p.manifestFile, 'utf8'))
  ok('dependencies 登记了 link:', String(manifest.dependencies['dsh-persona']).startsWith('link:'))
  const config = JSON.parse(fs.readFileSync(p.configFile, 'utf8'))
  ok('config.json 写了名字', config.personaName === '大肥鱼')
  ok('config.json 预算够放完整起步人设', config.maxInjectChars >= 3000 && config.maxSeedChars >= 2800)
  ok('安装日志不是空的', first.log.length >= 4, `${first.log.length} 行`)

  // -------------------------------------------------------------- 幂等性
  const patchBefore = fs.readFileSync(p.patchFile, 'utf8')
  const second = runInstall({ dshHome: tmp, profile: 'desktop', name: '另一个名字' })
  ok('重复安装不重复插 patch 行', fs.readFileSync(p.patchFile, 'utf8') === patchBefore)
  ok('重复安装遇到 config.json 会跳过', JSON.parse(fs.readFileSync(p.configFile, 'utf8')).personaName === '大肥鱼')
  ok('重复安装的日志说明了跳过', second.log.some((l) => l.includes('跳过')))
  const forced = runInstall({ dshHome: tmp, profile: 'desktop', force: true, name: '改过的名字' })
  ok('--force 能覆盖配置', JSON.parse(fs.readFileSync(p.configFile, 'utf8')).personaName === '改过的名字')
  ok('--force 之后 patch 仍只有一行', (fs.readFileSync(p.patchFile, 'utf8').match(/id: persona-memory/g) || []).length === 1)
  ok('--force 没白跑', forced.log.length >= 4)

  // ------------------------------------------------------------- 已有行检测
  ok('认得出早期手动装用的 id: persona', hasRow('- insert:\n    - id: persona\n      name: dsh-persona\n'))
  ok('认得出 id: persona-memory', hasRow(patchBlock()))
  ok('不把 persona-memory 误认成 persona', hasRow('- insert:\n    - id: persona-memory\n'))
  ok('别的插件行不算数', !hasRow('- insert:\n    - id: memory-whale\n      name: dsh-memory-whale\n'))

  // ---------------------------------------------------------------- 试运行
  const dryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-persona-dry-'))
  fs.mkdirSync(path.join(dryDir, 'profiles', 'desktop', 'node_modules'), { recursive: true })
  const dry = runInstall({ dshHome: dryDir, profile: 'desktop', dryRun: true })
  ok('--dry-run 不落盘', !fs.existsSync(path.join(dryDir, 'persona', 'config.json')))
  ok('--dry-run 有计划输出', dry.log.some((l) => l.startsWith('[计划]')))
  fs.rmSync(dryDir, { recursive: true, force: true })

  // --------------------------------------------------------------- junction
  const jDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-persona-j-'))
  fs.mkdirSync(path.join(jDir, 'profiles', 'desktop', 'node_modules'), { recursive: true })
  runInstall({ dshHome: jDir, profile: 'desktop', mode: 'junction' })
  const jTarget = path.join(jDir, 'profiles', 'desktop', 'node_modules', 'dsh-persona')
  ok('junction 模式建的是链接', fs.lstatSync(jTarget).isSymbolicLink())
  ok('junction 指向源码目录', fs.realpathSync(jTarget) === fs.realpathSync(process.cwd()))
  fs.rmSync(jDir, { recursive: true, force: true })

  // ---------------------------------------------------------------- 缺目录
  let threw = false
  try {
    runInstall({ dshHome: path.join(tmp, 'nope'), profile: 'desktop' })
  } catch {
    threw = true
  }
  ok('profile 不存在时明确报错而不是乱写', threw)

  // ---------------------------------------------------------------- 卸载
  const off = runUninstall({ dshHome: tmp, profile: 'desktop' })
  ok('卸载删掉了包', !fs.existsSync(p.packageTarget))
  ok('卸载删掉了 patch 行', !hasRow(fs.readFileSync(p.patchFile, 'utf8')))
  ok('卸载删掉了 dependencies', !JSON.parse(fs.readFileSync(p.manifestFile, 'utf8')).dependencies?.['dsh-persona'])
  ok('卸载默认保留人格库', fs.existsSync(p.configFile))
  ok('卸载日志说明了保留', off.log.some((l) => l.includes('人格库保留')))

  const purged = runUninstall({ dshHome: tmp, profile: 'desktop', purge: true })
  ok('--purge 连人格库一起删', !fs.existsSync(path.join(tmp, 'persona')))
  ok('--purge 的日志说明了删除', purged.log.some((l) => l.includes('已删除人格库')))

  // ------------------------------------- 已有别的内容的 patch 文件不能被弄坏
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-persona-other-'))
  const otherProfile = path.join(otherDir, 'profiles', 'desktop')
  fs.mkdirSync(path.join(otherProfile, 'node_modules'), { recursive: true })
  const otherPatch = path.join(otherProfile, 'cordis.patch.yml')
  fs.writeFileSync(otherPatch, '- id: ui-chat\n  name: "@deepseek-ai/dsh-client-ui-chat"\n', 'utf8')
  runInstall({ dshHome: otherDir, profile: 'desktop' })
  const merged = fs.readFileSync(otherPatch, 'utf8')
  ok('保留别人的行', merged.includes('id: ui-chat') && merged.includes('id: persona-memory'))
  runUninstall({ dshHome: otherDir, profile: 'desktop' })
  const afterUn = fs.readFileSync(otherPatch, 'utf8')
  ok('卸载后别人的行还在', afterUn.includes('id: ui-chat'), JSON.stringify(afterUn))
  ok('卸载后本插件的行没了', !hasRow(afterUn))
  fs.rmSync(otherDir, { recursive: true, force: true })
} finally {
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
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
