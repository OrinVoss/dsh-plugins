'use strict'

// dsh-memory 客户端半边自检：在 Node 里模拟 window.__ModuleLoader__ / react / document，
// 验证 bundle 形状、插槽注册参数，以及组件首次渲染不抛异常。
//   node clienttest.cjs

const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')

let passed = 0
const failures = []
function check(label, fn) {
  try {
    fn()
    passed++
    process.stdout.write(`  PASS  ${label}\n`)
  } catch (err) {
    failures.push({ label, err })
    process.stdout.write(`  FAIL  ${label}\n        ${String((err && err.message) || err).split('\n').join('\n        ')}\n`)
  }
}

// ---------------------------------------------------------------- 假环境

const loaded = []
const styleTags = []

global.window = {
  __ModuleLoader__: {
    load(entry) {
      loaded.push(entry)
    }
  }
}

global.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, set textContent(v) { this._t = v }, get textContent() { return this._t } }),
  head: { appendChild: (el) => styleTags.push(el) }
}

// 极简 React：createElement 造树，hook 返回初值，足够跑通首次渲染。
// useEffect 立即执行一次（setState 是 no-op，不会造成重渲染循环），
// 这样首次渲染就能走到 /memory-api/* 的加载路径。
const React = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children: children.flat() }
  },
  useState(init) {
    return [typeof init === 'function' ? init() : init, () => {}]
  },
  useEffect(fn) {
    const cleanup = fn()
    if (typeof cleanup === 'function') cleanup()
  },
  useCallback(fn) { return fn },
  useMemo(fn) { return fn() },
  useRef(v) { return { current: v } }
}

const requests = []
global.fetch = (url) => {
  requests.push(String(url))
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
}

console.log('')
check('bundle 以 __ModuleLoader__.load 注册且 id 正确', () => {
  const src = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8')
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', src)(global.window, global.document)
  assert.equal(loaded.length, 1, '应恰好注册一个 bundle')
  assert.equal(loaded[0].id, 'dsh-memory')
  assert.equal(typeof loaded[0].factory, 'function')
})

let clientModule
check('factory 返回 { inject, apply }', () => {
  const requireShim = (name) => {
    if (name === 'react') return React
    throw new Error(`未预期的模块请求：${name}`)
  }
  clientModule = loaded[0].factory(requireShim)
  assert.deepEqual(clientModule.inject, ['slots'])
  assert.equal(typeof clientModule.apply, 'function')
})

const registrations = []
let injectedOwner = null
check('apply 注入 settings.section 并带正确注册参数', () => {
  const ctx = {
    slots: {
      inject(owner, cb) {
        injectedOwner = owner
        return cb()
      },
      register(props, Component) {
        registrations.push({ props, Component })
        return () => {}
      }
    }
  }
  clientModule.apply(ctx)
  assert.equal(injectedOwner, 'settings.section')
  assert.equal(registrations.length, 1)
  const { props, Component } = registrations[0]
  assert.equal(props.name, 'settings.section')
  // 借用外壳已映射但无人注册的 archived-sessions 座位来拿档案盒图标；
  // 见 README §4.2——DSH 若将来启用该 id，改回 'memory' 即可（图标退回齿轮）。
  assert.equal(props.id, 'archived-sessions')
  assert.equal(typeof props.order, 'number')
  assert.equal(typeof props.label, 'function')
  assert.equal(props.label(), '记忆')
  assert.equal(typeof Component, 'function')
})

check('样式只注入一次且用主题 token', () => {
  assert.equal(styleTags.length, 1)
  const css = styleTags[0].textContent
  assert.ok(css.includes('--dsw-alias-label-primary'))
  assert.ok(css.includes('.dshmem-root'))
  assert.ok(!/#[0-9a-fA-F]{6}/.test(css), '不应出现硬编码颜色')
})

check('根元素不重复外壳的留白与滚动（外壳 .options 已有 padding 与 overflow）', () => {
  const css = styleTags[0].textContent
  const root = /\.dshmem-root\{([^}]*)\}/.exec(css)
  assert.ok(root, '找不到 .dshmem-root 规则')
  const body = root[1]
  assert.doesNotMatch(body, /height\s*:\s*100%/, '根节点不应占满高度（外壳已经是滚动容器）')
  assert.doesNotMatch(body, /overflow/, '根节点不应再开一层滚动')
  assert.doesNotMatch(body, /padding/, '根节点不应再加一层内边距')
})

check('沿用宿主设置行的规格（0.5px 发丝线 + primitives 的圆角与控件尺寸）', () => {
  const css = styleTags[0].textContent
  assert.ok(css.includes('border-bottom:.5px solid var(--dsw-alias-border-l2)'), '行分隔线应为 0.5px border-l2')
  assert.ok(css.includes('border-radius:var(--dsw-radius-md,12px)'), '控件圆角应走 --dsw-radius-md 并带兜底（官方 12px）')
  assert.ok(css.includes('border-radius:var(--dsw-radius-sm,8px)'), '控件圆角应走 --dsw-radius-sm 并带兜底（官方 8px）')
  assert.ok(css.includes('height:28px'), '按钮应为 primitives 的 sm 高度')
  assert.ok(css.includes('height:32px'), '输入框/选择器应为 primitives 的 32px')
  assert.ok(css.includes('var(--dsw-alias-button-primary-fill)'), '主按钮应走 primary fill token')
  assert.ok(css.includes('var(--dsw-alias-label-dimmed)'), 'placeholder 应走 dimmed token')
})

check('页面自带记忆字形（导航图标由外壳按 id 硬编码，页面内补）', () => {
  const tree = registrations[0].Component({})
  const json = JSON.stringify(treeTree(tree))
  assert.ok(json.includes('MemoryGlyph'), '应渲染自绘的记忆字形组件')
  assert.ok(json.includes('SearchGlyph'), '搜索框应带放大镜字形')
  assert.ok(json.includes('记忆'))
})

check('组件首次渲染不抛异常并产出状态条', () => {
  const tree = registrations[0].Component({})
  const json = JSON.stringify(treeTree(tree))
  assert.ok(json.includes('记忆根'), json.slice(0, 200))
  assert.ok(json.includes('重新同步'), '应有同步按钮')
  assert.ok(json.includes('新建条目'), '应有新建按钮')
})

check('状态行显示「自动提交」开关（跟住 host 的 status.autoCommit）', () => {
  const tree = registrations[0].Component({})
  const json = JSON.stringify(treeTree(tree))
  assert.ok(json.includes('自动提交'), '状态行应显示自动提交开关')
  const src = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8')
  assert.ok(src.includes('status.autoCommit'), '应从 status 读 autoCommit')
})

check('组件渲染时只请求 /memory-api/* 且不越界', () => {
  assert.ok(requests.length > 0)
  for (const url of requests) assert.match(url, /^\/memory-api\//, url)
})

/** 把元素树压成可 JSON 化的结构（去掉函数 props）。 */
function treeTree(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(treeTree).filter((x) => x !== null)
  const props = {}
  for (const [k, v] of Object.entries(node.props || {})) {
    if (typeof v === 'function') continue
    props[k] = typeof v === 'string' || typeof v === 'number' ? v : '[value]'
  }
  return { type: typeof node.type === 'function' ? node.type.name || 'Component' : node.type, props, children: (node.children || []).map(treeTree).filter((x) => x !== null) }
}

check('健康度卡片：样式走主题 token、源码只请求 /memory-api/health', () => {
  const css = styleTags[0].textContent
  assert.ok(css.includes('.dshmem-health'), '应有健康度卡片样式')
  assert.ok(css.includes('.dshmem-meterFill'), '应有预算条样式')
  const src = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8')
  assert.ok(src.includes('/memory-api/health'), '客户端应请求 /memory-api/health')
  assert.ok(src.includes('function HealthCard'), '应有 HealthCard 组件')
})

// 下面两条照着 app.asar 里官方设计系统的实测值写（2026-10-04）：
//   --dsw-radius-sm: 8px / --dsw-radius-md: 12px
//   官方卡片底色 = --dsw-alias-markdown-code-block（CodeCard）
//   官方警示 = --dsw-alias-state-warn-primary / -warn-label（amber）
check('圆角 fallback 与官方 token 取值一致（曾经写成 6px/8px 是错的）', () => {
  const src = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8')
  assert.ok(src.includes('var(--dsw-radius-md,12px)'), 'radius-md 的 fallback 应是 12px')
  assert.ok(src.includes('var(--dsw-radius-sm,8px)'), 'radius-sm 的 fallback 应是 8px')
  assert.ok(!src.includes('var(--dsw-radius-md,8px)'), '不应再把 radius-md 的 fallback 写成 8px')
  assert.ok(!src.includes('var(--dsw-radius-sm,6px)'), '不应再把 radius-sm 的 fallback 写成 6px')
})

check('卡片形态对齐官方：官方卡片底色 + amber 警示，不自己发明语义色', () => {
  const css = styleTags[0].textContent
  const card = /\.dshmem-health\{([^}]*)\}/.exec(css)
  assert.ok(card, '找不到 .dshmem-health 规则')
  assert.ok(card[1].includes('var(--dsw-alias-markdown-code-block)'), '卡片底色应走官方的 markdown-code-block')
  assert.ok(!card[1].includes('bg-layer-1'), '卡片底色不该用 bg-layer-1（纯白，与页面同色）')
  const warn = /\.dshmem-healthWarn\{([^}]*)\}/.exec(css)
  assert.ok(warn, '找不到 .dshmem-healthWarn 规则')
  assert.ok(warn[1].includes('--dsw-alias-state-warn-primary'), '警示应用官方 warn 色')
  assert.ok(warn[1].includes('color-mix'), '底纹应沿用官方的 10% color-mix 惯例')
  assert.ok(!/healthWarn\{[^}]*state-error-primary/.test(css), '警示不该用 error 红（那是「出错了」而不是「快该维护了」）')
})

check('健康度卡片拿不到报告时不渲染（不挡主流程）', () => {
  const tree = registrations[0].Component({})
  const json = JSON.stringify(treeTree(tree))
  assert.ok(!json.includes('该维护了'), '无数据时不应出现维护提示')
  assert.ok(!json.includes('dshmem-health'), '无数据时不应渲染卡片容器')
})

console.log(`\n${passed} 项通过，${failures.length} 项失败。\n`)
if (failures.length) {
  for (const f of failures) console.log(`FAILED: ${f.label}\n${(f.err && f.err.stack) || ''}\n`)
  process.exit(1)
}
