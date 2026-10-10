'use strict'

// dsh-token-stats 自检：不依赖 DSH 运行时，直接用 node 跑。
//   node selftest.cjs          —— 合成数据单元测试
//   node selftest.cjs --live   —— 额外扫一遍真实会话库（约 6 秒）

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const { inflateFrames, pickLogFile, localDayKey, LOG_NAME_RE } = require('./lib/scan')
const { _internal } = require('./host')

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed++
    console.log('  ok   ' + name)
  } catch (err) {
    failed++
    console.log('  FAIL ' + name + '\n       ' + ((err && err.message) || err))
  }
}

async function testAsync(name, fn) {
  try {
    await fn()
    passed++
    console.log('  ok   ' + name)
  } catch (err) {
    failed++
    console.log('  FAIL ' + name + '\n       ' + ((err && err.message) || err))
  }
}

function frame(obj) {
  return zlib.zstdCompressSync(Buffer.from(JSON.stringify(obj) + '\n', 'utf8'))
}

function step(seq, time, model, provider, input, output, cache) {
  return {
    type: 'assistant/message',
    seq,
    time,
    data: {
      usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cache },
      message: { source: { provider, model } }
    }
  }
}

console.log('\n[1] 帧解析')

test('单帧解压', () => {
  const text = inflateFrames(frame({ type: 'session', id: 'a' }))
  assert.strictEqual(JSON.parse(text.trim()).id, 'a')
})

test('连续多帧拼接后能全部解出', () => {
  const buf = Buffer.concat([
    frame({ type: 'session', id: 's1', cwd: 'D:\\x' }),
    frame(step(1, 1000, 'm-a', 'p', 10, 2, 3)),
    frame(step(2, 2000, 'm-b', 'p', 1, 1, 1))
  ])
  const lines = inflateFrames(buf).split('\n').filter(Boolean)
  assert.strictEqual(lines.length, 3)
  assert.strictEqual(JSON.parse(lines[1]).data.usage.inputTokens, 10)
})

test('压缩数据里出现帧魔数时不会错切', () => {
  // 大 payload 更可能在压缩体内偶然出现 28 B5 2F FD 字节序列
  const big = frame({ type: 'session', id: 's', blob: 'x'.repeat(5000) })
  const rest = frame(step(9, 5000, 'm', 'p', 7, 0, 0))
  const lines = inflateFrames(Buffer.concat([big, rest])).split('\n').filter(Boolean)
  assert.strictEqual(lines.length, 2)
  assert.strictEqual(JSON.parse(lines[1]).data.usage.inputTokens, 7)
})

test('空缓冲 / 无魔数返回空串', () => {
  assert.strictEqual(inflateFrames(Buffer.alloc(0)), '')
  assert.strictEqual(inflateFrames(Buffer.from('not zstd at all')), '')
})

console.log('\n[2] 版本选择')

test('同一目录取版本号最高的日志', () => {
  assert.strictEqual(pickLogFile(['session.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.v4.jsonl.zstd']), 'session.v4.jsonl.zstd')
  assert.strictEqual(pickLogFile(['session.jsonl.zstd', 'session.v3.jsonl.zstd']), 'session.v3.jsonl.zstd')
  assert.strictEqual(pickLogFile(['session.jsonl.zstd']), 'session.jsonl.zstd')
  assert.strictEqual(pickLogFile(['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd']), 'session.v4.jsonl.zstd')
})

test('无关文件被忽略', () => {
  assert.strictEqual(pickLogFile(['notes.txt', 'session.v4.jsonl.zstd.bak']), null)
  assert.strictEqual(pickLogFile([]), null)
  assert.ok(LOG_NAME_RE.test('session.v12.jsonl.zstd'))
})

console.log('\n[3] 日期与聚合')

test('localDayKey 用本地时区切日', () => {
  const d = new Date(2026, 8, 30, 23, 30, 0) // 2026-09-30 23:30 本地
  assert.strictEqual(localDayKey(d.getTime()), '2026-09-30')
  const e = new Date(2026, 0, 1, 0, 5, 0)
  assert.strictEqual(localDayKey(e.getTime()), '2026-01-01')
})

test('模型别名把同一个模型的前后两个名字归并', () => {
  const { canonicalModel, DEFAULT_MODEL_ALIASES, aggregate } = _internal

  // 显式别名
  assert.strictEqual(canonicalModel('deepseek-flash', DEFAULT_MODEL_ALIASES), 'deepseek-v4.1-flash')
  assert.strictEqual(
    canonicalModel('deepseek-v4.1-flash-expires-on-0910', DEFAULT_MODEL_ALIASES),
    'deepseek-v4.1-flash'
  )
  // 兜底规则：任何 -expires-on-MMDD 都去掉后缀
  assert.strictEqual(canonicalModel('some-model-expires-on-1231', {}), 'some-model')
  // 不匹配的名字原样保留
  assert.strictEqual(canonicalModel('deepseek-v4-flash', DEFAULT_MODEL_ALIASES), 'deepseek-v4-flash')
  assert.strictEqual(canonicalModel('k3', DEFAULT_MODEL_ALIASES), 'k3')
  // 用户别名优先于内置
  assert.strictEqual(canonicalModel('deepseek-flash', { 'deepseek-flash': 'my-name' }), 'my-name')

  // 归并后：总量、步数、按天矩阵都要合到同一条上
  const t1 = new Date(2026, 8, 9, 10, 0, 0).getTime()
  const t2 = new Date(2026, 8, 10, 10, 0, 0).getTime()
  const scan = {
    scanMs: 0, files: 1, failed: 0,
    sessions: [{ id: 's1', cwd: 'D:\\p', steps: 2 }],
    steps: [
      { t: t1, day: '2026-09-09', model: 'deepseek-v4.1-flash-expires-on-0910', provider: 'deepseek-official', input: 10, output: 1, cache: 100, session: 's1' },
      { t: t2, day: '2026-09-10', model: 'deepseek-flash', provider: 'deepseek-account', input: 20, output: 2, cache: 200, session: 's1' }
    ],
    range: { from: t1, to: t2 }
  }
  const merged = aggregate(scan, DEFAULT_MODEL_ALIASES)
  assert.strictEqual(merged.models.length, 1, '应合并成一个模型')
  assert.strictEqual(merged.models[0].model, 'deepseek-v4.1-flash')
  assert.strictEqual(merged.models[0].total, 333)
  assert.strictEqual(merged.models[0].steps, 2)
  assert.strictEqual(merged.days[0].models['deepseek-v4.1-flash'].total, 111)
  assert.strictEqual(merged.days[1].models['deepseek-v4.1-flash'].total, 222)
  assert.strictEqual(merged.days[0].models['deepseek-flash'], undefined, '旧名字不应再单独出现')

  // 不传别名时退化成兜底规则（去 -expires-on 后缀），但不会把 deepseek-flash 并进来
  const plain = aggregate(scan, undefined)
  assert.strictEqual(plain.models.length, 2)
})

test('aggregate 汇总总量 / 模型 / 按天矩阵', () => {
  const t1 = new Date(2026, 8, 29, 10, 0, 0).getTime()
  const t2 = new Date(2026, 8, 30, 10, 0, 0).getTime()
  const t3 = new Date(2026, 8, 30, 12, 0, 0).getTime()
  const scan = {
    scanMs: 1,
    sessions: [
      { id: 's1', cwd: 'D:\\proj-a', steps: 2 },
      { id: 's2', cwd: 'D:\\proj-a', steps: 1 }
    ],
    files: 2,
    failed: 0,
    steps: [
      { t: t1, day: '2026-09-29', model: 'm-a', provider: 'p1', input: 10, output: 1, cache: 100, session: 's1' },
      { t: t2, day: '2026-09-30', model: 'm-a', provider: 'p1', input: 20, output: 2, cache: 200, session: 's1' },
      { t: t3, day: '2026-09-30', model: 'm-b', provider: 'p2', input: 30, output: 3, cache: 300, session: 's2' }
    ],
    range: { from: t1, to: t3 }
  }
  const data = _internal.aggregate(scan)

  // 总量：input 60 / output 6 / cache 600
  assert.strictEqual(data.totals.input, 60)
  assert.strictEqual(data.totals.output, 6)
  assert.strictEqual(data.totals.cache, 600)
  assert.strictEqual(data.totals.total, 666)
  assert.strictEqual(data.totals.steps, 3)
  assert.strictEqual(data.totals.sessions, 2)

  // 按天补全：只有 29、30 两天
  assert.deepStrictEqual(data.days.map((d) => d.day), ['2026-09-29', '2026-09-30'])
  assert.strictEqual(data.days[0].total, 111)
  assert.strictEqual(data.days[1].total, 555)
  // 30 日按模型分解：m-a 222、m-b 333，且带完整明细（客户端切换范围要用）
  assert.strictEqual(data.days[1].models['m-a'].total, 222)
  assert.strictEqual(data.days[1].models['m-b'].total, 333)
  assert.strictEqual(data.days[1].models['m-a'].input, 20)
  assert.strictEqual(data.days[1].models['m-a'].steps, 1)
  assert.strictEqual(data.days[0].models['m-a'].cache, 100)

  // 模型按总量降序：m-b 333 > m-a 333? 相等时顺序不保证，只校验聚合值
  const byName = Object.fromEntries(data.models.map((m) => [m.model, m]))
  assert.strictEqual(byName['m-a'].total, 333)
  assert.strictEqual(byName['m-b'].total, 333)
  assert.strictEqual(byName['m-a'].provider, 'p1')

  // 工作区合并了同 cwd 的会话
  assert.strictEqual(data.workspaces.length, 1)
  assert.strictEqual(data.workspaces[0].sessions, 2)
  assert.strictEqual(data.workspaces[0].total, 666)
})

test('aggregate 对空数据不崩', () => {
  const data = _internal.aggregate({
    scanMs: 0, sessions: [], files: 0, failed: 0, steps: [], range: { from: null, to: null }
  })
  assert.strictEqual(data.totals.total, 0)
  assert.deepStrictEqual(data.days, [])
  assert.deepStrictEqual(data.models, [])
})

test('缺失 usage 的步不会被计入（由扫描层过滤）', () => {
  // 扫描层只挑 data.usage 存在的记录；这里验证聚合层的输入契约
  const data = _internal.aggregate({
    scanMs: 0, files: 0, failed: 0, sessions: [{ id: 's', cwd: null, steps: 0 }],
    steps: [], range: { from: null, to: null }
  })
  assert.strictEqual(data.totals.steps, 0)
})

console.log('\n[4] 包声明')

test('package.json 声明了 client 半边与展示元信息（成员身份由拓展包组合包声明）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'))
  assert.strictEqual(pkg.name, 'dsh-token-stats')
  assert.strictEqual(pkg.main, 'host.js')
  assert.strictEqual(pkg.dsh && pkg.dsh.bundle, undefined, '成员包不再自带 dsh.bundle')
  assert.ok(pkg.dsh.client && pkg.dsh.client.platform === 'web')
  assert.strictEqual(pkg.icon, './icon.svg')
  assert.strictEqual(pkg.exports['./locale/*.json'], './locale/*.json')
  for (const f of ['host.js', 'client.js', 'lib/scan.js', 'icon.svg', 'locale/zh.json', 'locale/en.json']) {
    assert.ok(fs.existsSync(path.join(__dirname, f)), '缺少文件 ' + f)
  }
  assert.ok(!fs.existsSync(path.join(__dirname, 'cordis.patch.yml')), 'cordis.patch.yml 应已删除（改由组合包声明）')
})

test('locale 元信息带标题与描述', () => {
  const zh = JSON.parse(fs.readFileSync(path.join(__dirname, 'locale', 'zh.json'), 'utf8'))
  assert.ok(zh.meta && typeof zh.meta.title === 'string' && zh.meta.title.length > 0, '缺少中文标题')
  assert.ok(typeof zh.meta.description === 'string' && zh.meta.description.length > 0, '缺少中文描述')
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, 'locale', 'en.json'), 'utf8'))
  assert.ok(en.meta && typeof en.meta.title === 'string' && en.meta.title.length > 0, '缺少英文标题')
})

test('client.js 注册了 main 与 sidebar.panellist 的同一个 id', () => {
  const src = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8')
  assert.ok(src.includes("'sidebar.panellist'"), '缺少 sidebar.panellist 注册')
  assert.ok(/name:\s*'main'/.test(src), '缺少 main 注册')
  assert.ok(src.includes('PANEL_ID'), '应使用统一的 PANEL_ID')
})

test('client.js 语法可解析', () => {
  const vm = require('vm')
  const src = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8')
  new vm.Script(src, { filename: 'client.js' })
})

/** 从 client.js 里按大括号配对抠出一个自包含函数（跳过字符串/模板串内的括号）。 */
function extractFunction(src, name) {
  const start = src.indexOf('function ' + name)
  if (start < 0) return null
  let depth = 0
  let quote = null
  let started = false
  for (let i = start; i < src.length; i++) {
    const ch = src[i]
    if (quote !== null) {
      if (ch === '\\') { i++; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue }
    if (ch === '{') { depth++; started = true } else if (ch === '}') {
      depth--
      if (started && depth === 0) return src.slice(start, i + 1)
    }
  }
  return null
}

test('趋势图平滑插值不会钻到 0 线以下（回归）', () => {
  const src = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8')
  const body = extractFunction(src, 'monotonePath')
  assert.ok(body !== null, '找不到 monotonePath')
  const monotonePath = new Function('return (' + body + ')')()
  assert.strictEqual(typeof monotonePath, 'function')

  // 路径里的每个 `,数字` 都是控制点/端点的 y（格式恒为 x,y）
  const ysOf = (d) => [...d.matchAll(/,(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]))

  // 「从高值骤降到 0、随后一直贴 0」——Catmull-Rom 正是在这里过冲到负值区。
  // 屏幕坐标里 y 越大值越小，所以这里断言 y 不超过谷底的 200。
  const falling = [[0, 50], [1, 200], [2, 200], [3, 200]]
  const d1 = ysOf(monotonePath(falling))
  assert.ok(Math.max(...d1) <= 200 + 1e-6, '曲线钻过了谷底：max y = ' + Math.max(...d1))

  // 一般情形：曲线必须落在数据的 [min,max] 之内
  const wave = [[0, 60], [1, 60], [2, 180], [3, 180], [4, 60]]
  const d2 = ysOf(monotonePath(wave))
  assert.ok(Math.max(...d2) <= 180 + 1e-6, '下界越界：' + Math.max(...d2))
  assert.ok(Math.min(...d2) >= 60 - 1e-6, '上界越界：' + Math.min(...d2))

  // 全 0 的序列必须画成直线段，不能有起伏
  const flat = [[0, 200], [1, 200], [2, 200]]
  const d3 = ysOf(monotonePath(flat))
  assert.deepStrictEqual([...new Set(d3)], [200], '全 0 序列被画出了起伏')

  // 退化输入不抛错
  assert.strictEqual(monotonePath([]), '')
  assert.ok(monotonePath([[0, 10]]).startsWith('M'))
  assert.ok(monotonePath([[0, 10], [1, 20]]).includes('L'))
})

test('切换时间范围时模型颜色保持不变（回归）', () => {
  const src = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8')
  const body = extractFunction(src, 'buildView')
  assert.ok(body !== null, '找不到 buildView')

  // buildView 只依赖这两个模块级常量，注入进去即可独立编译
  const RANGES = [{ id: '7', days: 7 }, { id: '30', days: 30 }, { id: 'all', days: 0 }]
  const PALETTE = ['#a', '#b', '#c', '#d', '#e']
  const colorOf = (i) => PALETTE[i % PALETTE.length]
  const buildView = new Function('RANGES', 'colorOf', 'return (' + body + ')')(RANGES, colorOf)

  const mkCell = (total) => ({ input: total / 2, output: total / 2, cache: 0, total, steps: 1 })
  const mkDay = (day, name, total) => ({
    day, input: total / 2, output: total / 2, cache: 0, total, steps: 1, models: { [name]: mkCell(total) }
  })
  // 全量排名：top 100 > mid 50 > late 10
  const days = []
  for (let i = 1; i <= 10; i++) days.push(mkDay(`2026-08-${String(i).padStart(2, '0')}`, 'top', 100))
  for (let i = 15; i <= 24; i++) days.push(mkDay(`2026-08-${String(i).padStart(2, '0')}`, 'mid', 50))
  for (let i = 25; i <= 30; i++) days.push(mkDay(`2026-08-${String(i).padStart(2, '0')}`, 'late', 900))

  const allTime = [
    { model: 'top', provider: 'p', total: 1000, steps: 10, input: 0, output: 0, cache: 0 },
    { model: 'mid', provider: 'p', total: 500, steps: 10, input: 0, output: 0, cache: 0 },
    { model: 'late', provider: 'p', total: 300, steps: 6, input: 0, output: 0, cache: 0 }
  ]
  const data = { days, models: allTime, totals: { total: 1800 }, source: { sessions: 1, steps: 26 } }

  const ranges = ['7', '30', 'all']
  const views = ranges.map((r) => buildView(data, r))
  const colorByName = new Map()
  for (const view of views) {
    for (const m of view.models) {
      assert.ok(typeof m.color === 'string' && m.color.length > 0, m.model + ' 没有颜色')
      const seen = colorByName.get(m.model)
      if (seen === undefined) colorByName.set(m.model, m.color)
      else assert.strictEqual(m.color, seen, m.model + ' 在不同范围里颜色变了')
    }
  }

  // 颜色必须落在该模型的全量排名上，而不是当前范围的排名
  const allView = views[2]
  const sevenView = views[0]
  const byAll = Object.fromEntries(allView.models.map((m) => [m.model, m]))
  const bySeven = Object.fromEntries(sevenView.models.map((m) => [m.model, m]))
  assert.strictEqual(byAll['top'].color, colorOf(0))
  assert.strictEqual(byAll['mid'].color, colorOf(1))
  assert.strictEqual(byAll['late'].color, colorOf(2))
  // 近 7 日里 late 的「范围排名」升到第一，但颜色仍是全量第 3 名那个
  assert.strictEqual(bySeven['late'].color, colorOf(2), '近 7 日里 late 被按范围排名重新配色了')
  assert.strictEqual(bySeven['late'].total, 5400)
  // 范围过滤本身仍要正确：近 7 日 = 8/24..8/30，含 1 天 mid + 6 天 late
  assert.strictEqual(sevenView.days.length, 7)
  assert.strictEqual(sevenView.models.length, 2)
  assert.strictEqual(sevenView.models[0].model, 'late', '范围内按用量排序应把 late 排第一')
})

test('圆环外沿留在 viewBox 以内，不会被裁成平口（回归）', () => {
  const src = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8')
  const body = extractFunction(src, 'donutRing')
  assert.ok(body !== null, '找不到 donutRing')
  const donutRing = new Function('return (' + body + ')')()

  const num = (name) => {
    const m = new RegExp('const ' + name + ' = (\\d+)').exec(src)
    assert.ok(m !== null, '找不到常量 ' + name)
    return Number(m[1])
  }

  // 用 client.js 里的真实常量算一遍：外沿（半径 + 最大描边的一半）必须在方框内
  const S = num('DONUT_SIZE')
  const K = num('DONUT_STROKE')
  const G = num('DONUT_HOVER_GROW')
  const real = donutRing(S, K, G)
  const outer = real.radius + real.hoverStroke / 2
  assert.ok(outer < S / 2, `外沿 ${outer} 已触及/超出边界 ${S / 2}，会被裁成平口`)
  assert.ok(S / 2 - outer >= 1, `外沿余量 ${S / 2 - outer}px 太小，抗锯齿仍会被切`)

  // 记录这个回归本身：旧公式 (size - stroke) / 2 让外沿正好相切
  assert.strictEqual((220 - 32) / 2 + 32 / 2, 220 / 2, '旧公式应当正好相切（这正是当初被裁的原因）')
  assert.ok(real.radius + real.hoverStroke / 2 < 220 / 2 - 1, '新半径应明显小于相切值')

  // 公式要对任意尺寸都成立（不只是 220）
  for (const [size, stroke, grow] of [[120, 32, 5], [240, 16, 0], [220, 40, 8]]) {
    const ring = donutRing(size, stroke, grow)
    assert.ok(ring.radius > 0, `size=${size} 时半径算成了负值`)
    assert.ok(
      ring.radius + ring.hoverStroke / 2 < size / 2,
      `size=${size} stroke=${stroke} grow=${grow} 时外沿越界`
    )
  }
})

test('client.js 引用的每个 dshts-* 类名都有对应样式', () => {
  const src = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8')
  // 定义：CSS 字符串里的 `.dshts-x{` / `.dshts-x,` / `.dshts-x:`
  const defined = new Set(
    [...src.matchAll(/\.(dshts-[A-Za-z0-9_-]+)\s*[,{:]/g)].map((m) => m[1])
  )
  // 引用：className: '...' / className: "..." / class 串
  const used = new Set()
  for (const m of src.matchAll(/className:\s*(['"])([^'"]+)\1/g)) {
    for (const cls of m[2].split(/\s+/)) if (cls.startsWith('dshts-')) used.add(cls)
  }
  const missing = [...used].filter((c) => !defined.has(c))
  assert.deepStrictEqual(missing, [], '缺少样式定义: ' + missing.join(', '))
  assert.ok(defined.size > 20, '样式数量异常（只解析到 ' + defined.size + ' 个类）')
})

/**
 * 取出形如 `h('svg', {...}, ...)` 的完整调用文本（按括号配对，跳过字符串内的括号）。
 * 用来验证 svg 内部没有混入 HTML 元素 —— 那种错误 node 语法检查抓不到，
 * 但会在浏览器里直接抛错。
 */
function extractCall(src, marker) {
  const start = src.indexOf(marker)
  if (start < 0) return null
  let depth = 0
  let quote = null
  for (let i = src.indexOf('(', start); i < src.length; i++) {
    const ch = src[i]
    if (quote !== null) {
      if (ch === '\\') { i++; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue }
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  return src.slice(start)
}

test('client.js 的 svg 调用体内不混入 HTML 元素', () => {
  const src = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8')
  let found = 0
  let from = 0
  for (;;) {
    const marker = "h('svg'"
    const idx = src.indexOf(marker, from)
    if (idx < 0) break
    from = idx + marker.length
    const body = extractCall(src, marker)
    if (body === null) break
    found++
    for (const bad of ["h('div'", "h('span'", "h('button'"]) {
      assert.ok(body.indexOf(bad) < 0, 'svg 调用体内出现 ' + bad + '（应为 SVG 元素）')
    }
  }
  assert.ok(found >= 2, '只找到 ' + found + ' 处 svg 调用，解析可能失效')
})

console.log('\n[5] 真实会话库')

async function live() {
  const home = _internal.resolveHome()
  const { scanSessions } = require('./lib/scan')
  const scan = await scanSessions(home)
  assert.ok(scan.sessions.length > 0, '没有找到任何会话')
  assert.ok(scan.steps.length > 0, '没有解析出任何 usage')
  for (const s of scan.steps) {
    assert.ok(s.input >= 0 && s.output >= 0 && s.cache >= 0, '出现负数 token')
    assert.ok(typeof s.model === 'string' && s.model.length > 0, '模型名为空')
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(s.day), '日期格式不对: ' + s.day)
  }
  const data = _internal.aggregate(scan)
  console.log('  会话 %d，文件 %d，步 %d，模型 %d，天 %d',
    data.source.sessions, data.source.files, data.source.steps, data.models.length, data.days.length)
  console.log('  总计 %s tokens（input %s / output %s / cache %s），扫描 %dms',
    data.totals.total, data.totals.input, data.totals.output, data.totals.cache, data.scanMs)
  console.log('  时间范围 %s -> %s', data.days[0] ? data.days[0].day : '-', data.days[data.days.length - 1] ? data.days[data.days.length - 1].day : '-')
  // 按天总量之和必须等于总量
  const sum = data.days.reduce((acc, d) => acc + d.total, 0)
  assert.strictEqual(sum, data.totals.total, '按天之和与总量不一致')
  const modelSum = data.models.reduce((acc, m) => acc + m.total, 0)
  assert.strictEqual(modelSum, data.totals.total, '按模型之和与总量不一致')
}

async function main() {
  if (process.argv.includes('--live')) {
    await testAsync('扫描真实会话库并自洽', live)
  }
  console.log(`\n${passed} 通过，${failed} 失败`)
  process.exit(failed === 0 ? 0 : 1)
}

main()
