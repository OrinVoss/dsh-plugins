// dsh-style-extras 自检：不需要 DSH、不需要浏览器，只用 Node 读文件。
//
//   node selfcheck.cjs
//
// 覆盖：包声明（组合包 patch / 图标 / locale 导出）、patch 的五条 insert 与
// 配置、locale 元信息、图标文件（存在、是 SVG、≤256 KiB）、以及五个成员包
// 是否作为同级目录存在并各自带好图标与 locale 元信息。
const fs = require('fs')
const path = require('path')

const DIR = __dirname
const SIBLING_ROOT = path.resolve(DIR, '..')
const MEMBERS = [
  { dir: 'token-stats', pkg: 'dsh-token-stats', rowId: 'token-stats' },
  { dir: 'sysmon', pkg: 'dsh-sysmon', rowId: 'sysmon' },
  { dir: 'skins', pkg: 'dsh-skins', rowId: 'skins' },
  { dir: 'btw', pkg: 'dsh-btw', rowId: 'btw' },
  { dir: 'message-edit', pkg: 'dsh-message-edit', rowId: 'message-edit' },
]
const MAX_ICON_BYTES = 256 * 1024

let passed = 0
const failures = []
function test(name, fn) {
  try {
    fn()
    passed++
    console.log('  ok   ' + name)
  } catch (err) {
    failures.push(name + ' :: ' + err.message)
    console.log('  FAIL ' + name + ' :: ' + err.message)
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed')
}
function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

console.log('\n[1] 组合包自己的声明')

test('package.json 是组合包，带 patch 与图标', () => {
  const pkg = readJSON(path.join(DIR, 'package.json'))
  assert(pkg.name === 'dsh-style-extras', '包名应为 dsh-style-extras，实际 ' + pkg.name)
  assert(pkg.private === true, '应为 private 包')
  assert(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch, '缺少 dsh.bundle.patch')
  assert(pkg.icon === './icon.svg', '缺少 icon 声明')
  assert(pkg.exports['./locale/*.json'] === './locale/*.json', 'exports 未放开 locale')
})

test('patch 文件存在且被 package.json 指向', () => {
  const pkg = readJSON(path.join(DIR, 'package.json'))
  const patch = path.join(DIR, pkg.dsh.bundle.patch.replace(/^\.\//, ''))
  assert(fs.existsSync(patch), '缺少 ' + patch)
})

test('入口模块可被 require，且不注册任何东西', () => {
  const mod = require(path.join(DIR, 'index.js'))
  assert(mod && typeof mod === 'object', 'index.js 应导出一个空对象')
  assert(Object.keys(mod).length === 0, 'index.js 不应导出插件实现')
})

console.log('\n[2] 组合包 patch 的五条 insert')

const patchText = fs.readFileSync(path.join(DIR, 'cordis.patch.yml'), 'utf8')

test('三条 insert 的 id 与包名一一对应', () => {
  for (const m of MEMBERS) {
    assert(new RegExp('id:\\s*' + m.rowId + '\\b').test(patchText), '缺少 id: ' + m.rowId)
    assert(new RegExp('name:\\s*' + m.pkg + '\\b').test(patchText), '缺少 name: ' + m.pkg)
  }
})

test('token-stats 的 config 随迁移保留', () => {
  assert(/cacheTtlMs:\s*300000/.test(patchText), '缺少 cacheTtlMs')
  assert(/warmupOnStartup:\s*true/.test(patchText), '缺少 warmupOnStartup')
})

test('patch 里没有重复 id（同 id 插两次会加载两遍）', () => {
  const ids = patchText.split('\n').map((l) => /^\s*-\s*id:\s*(\S+)/.exec(l)).filter(Boolean).map((m) => m[1])
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i)
  assert(dup.length === 0, '重复 id: ' + dup.join(', '))
})

console.log('\n[3] 展示元信息（图标 + 中英 locale）')

function checkIcon(file, label) {
  assert(fs.existsSync(file), label + ' 缺少图标 ' + file)
  const stat = fs.statSync(file)
  assert(stat.isFile(), label + ' 的图标不是普通文件')
  assert(stat.size <= MAX_ICON_BYTES, label + ' 的图标超过 256 KiB')
  const text = fs.readFileSync(file, 'utf8')
  assert(/<svg[\s>]/.test(text), label + ' 的图标不是 SVG')
  assert(!/currentColor/.test(text), label + ' 的图标不应依赖 currentColor（渲染为 img）')
}

function checkLocale(dir, label) {
  for (const lang of ['zh', 'en']) {
    const file = path.join(dir, 'locale', lang + '.json')
    assert(fs.existsSync(file), label + ' 缺少 locale/' + lang + '.json')
    const data = readJSON(file)
    assert(data.meta && typeof data.meta.title === 'string' && data.meta.title.length > 0, label + ' 的 ' + lang + ' 缺少 meta.title')
    assert(typeof data.meta.description === 'string' && data.meta.description.length > 0, label + ' 的 ' + lang + ' 缺少 meta.description')
  }
}

test('组合包自己有图标与中英元信息', () => {
  checkIcon(path.join(DIR, 'icon.svg'), 'style-extras')
  checkLocale(DIR, 'style-extras')
})

console.log('\n[4] 五个成员包（同级目录）')

for (const m of MEMBERS) {
  const dir = path.join(SIBLING_ROOT, m.dir)
  test(m.dir + ' 存在且包名一致', () => {
    assert(fs.existsSync(dir), '缺少同级目录 ' + dir)
    const pkg = readJSON(path.join(dir, 'package.json'))
    assert(pkg.name === m.pkg, m.dir + ' 的包名应为 ' + m.pkg + '，实际 ' + pkg.name)
    assert(pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform === 'web', m.dir + ' 缺少 dsh.client 声明')
    assert(pkg.dsh.bundle === undefined, m.dir + ' 不应再自带 dsh.bundle（否则会被插入两次）')
    assert(pkg.icon === './icon.svg', m.dir + ' 缺少 icon 声明')
    assert(pkg.exports['./locale/*.json'] === './locale/*.json', m.dir + ' 的 exports 未放开 locale')
  })
  test(m.dir + ' 有图标与中英元信息', () => {
    checkIcon(path.join(dir, 'icon.svg'), m.dir)
    checkLocale(dir, m.dir)
  })
}

console.log('\n[5] 记忆插件（独立组合包，仅要求图标与元信息）')
const memoryDir = path.join(SIBLING_ROOT, 'memory')
test('memory 仍是组合包且补上了图标与元信息', () => {
  const pkg = readJSON(path.join(memoryDir, 'package.json'))
  assert(pkg.name === 'dsh-memory', '包名应为 dsh-memory')
  assert(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch, 'memory 仍应自带 dsh.bundle')
  assert(pkg.icon === './icon.svg', 'memory 缺少 icon 声明')
  checkIcon(path.join(memoryDir, 'icon.svg'), 'memory')
  checkLocale(memoryDir, 'memory')
})

console.log('\n' + passed + ' 项通过，' + failures.length + ' 项失败')
if (failures.length > 0) {
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
