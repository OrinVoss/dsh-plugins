'use strict'

// dsh-sysmon 自检：脱离 DSH 直接跑。
//   node selfcheck.cjs
//
// 采集分两路：CPU / 内存走 node:os（零成本，可 500ms 甚至更快）；
// 磁盘 / GPU 仍走 PowerShell（脚本里三次 Start-Sleep 就 ~700ms），后台按 2s 慢刷。
// 这里是这套设计的回归闸：纯函数算 CPU 差分，结构断言防止有人把快慢两路又合回一次阻塞采样。

const fs = require('node:fs')
const path = require('node:path')

let passed = 0
const failures = []
function check(label, fn) {
  try {
    const note = fn()
    passed++
    process.stdout.write(`  PASS  ${label}${note ? '（' + note + '）' : ''}\n`)
  } catch (err) {
    failures.push({ label, err })
    process.stdout.write(`  FAIL  ${label}\n        ${String((err && err.message) || err).split('\n').join('\n        ')}\n`)
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message)
}

const host = fs.readFileSync(path.join(__dirname, 'host.js'), 'utf8')
const client = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8')

// ---------------------------------------------------------------- CPU 差分

const m = /function cpuDeltaPct\(prev, curr\) \{[\s\S]*?\n\}/.exec(host)
check('找到纯函数 cpuDeltaPct（CPU 差分可测）', () => assert(m !== null, 'host.js 里没有 cpuDeltaPct'))
if (m !== null) {
  // eslint-disable-next-line no-new-func
  const cpuDeltaPct = new Function(`return (${m[0]})`)()
  check('半载：idle 增 90 / total 增 200 ⇒ 55%', () =>
    assert(cpuDeltaPct({ idle: 100, total: 1000 }, { idle: 190, total: 1200 }) === 55, '应得 55'))
  check('满载：idle 一点没增 ⇒ 100%', () =>
    assert(cpuDeltaPct({ idle: 0, total: 0 }, { idle: 0, total: 100 }) === 100, '应得 100'))
  check('空载：idle 与 total 同步增 ⇒ 0%', () =>
    assert(cpuDeltaPct({ idle: 0, total: 0 }, { idle: 100, total: 100 }) === 0, '应得 0'))
  check('没有基线 ⇒ null（首帧不该瞎报一个数）', () =>
    assert(cpuDeltaPct(null, { idle: 1, total: 2 }) === null, '应得 null'))
  check('快照相同时 total 增量为 0 ⇒ null（不除零）', () =>
    assert(cpuDeltaPct({ idle: 5, total: 5 }, { idle: 5, total: 5 }) === null, '应得 null'))
  check('负增量（时钟/浮点异常）⇒ null', () =>
    assert(cpuDeltaPct({ idle: 50, total: 100 }, { idle: 40, total: 100 }) === null, '应得 null'))
}

// ---------------------------------------------------------------- 快慢两路

check('CPU / 内存走 node:os（不再每次起 PowerShell）', () => {
  assert(/require\('node:os'\)/.test(host), 'host.js 应 require node:os')
  assert(/function fastSample\(\)/.test(host), '缺 fastSample()')
  assert(/os\.cpus\(\)/.test(host) && /os\.totalmem\(\)/.test(host) && /os\.freemem\(\)/.test(host), 'fastSample 应使用 os.*')
})

check('磁盘 / GPU 后台慢刷：TTL 2000ms', () => {
  assert(/const SLOW_TTL_MS = 2000/.test(host), 'SLOW_TTL_MS 应为 2000')
  assert(/function refreshSlow\(\)/.test(host), '缺 refreshSlow()')
  assert(/Date\.now\(\) - slowAt < SLOW_TTL_MS/.test(host), 'TTL 判断缺失')
  assert(/slowInflight !== null/.test(host), '应有 inflight 去重（别并发起多个 PowerShell）')
})

check('采样路由不阻塞：先踢后台慢刷，再立刻返回快数据', () => {
  const handler = /path: '\/sysmon-api\/sample',[\s\S]*?res\.end\(body\)/.exec(host)
  assert(handler !== null, '找不到 sample 路由')
  assert(/refreshSlow\(\)/.test(handler[0]), '路由应先调 refreshSlow()')
  assert(/fastSample\(\)/.test(handler[0]), '路由应直接用 fastSample()')
  assert(!/await sample\(\)/.test(handler[0]), '路由不应 await 采样（那会又变成阻塞）')
  assert(/disks: slow\.disks/.test(handler[0]) && /gpus: slow\.gpus/.test(handler[0]), '慢数据应取上一次的缓存')
})

check('客户端：轮询 500ms、弧线过渡 0.3s', () => {
  assert(/const SAMPLE_MS = 500/.test(client), 'SAMPLE_MS 应为 500')
  assert(/useSample\(SAMPLE_MS\)/.test(client), '应使用 SAMPLE_MS')
  assert(/stroke-dashoffset \.3s ease/.test(client), '弧线过渡应为 .3s')
})

check('package.json 挂了 test 脚本', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'))
  assert(pkg.scripts && pkg.scripts.test === 'node selfcheck.cjs', 'scripts.test 应为 node selfcheck.cjs')
})

// ---------------------------------------------------------------- 结果

console.log(`\n${passed} 项通过，${failures.length} 项失败。\n`)
if (failures.length) {
  for (const f of failures) console.log(`FAILED: ${f.label}\n${(f.err && f.err.stack) || ''}\n`)
  process.exit(1)
}
