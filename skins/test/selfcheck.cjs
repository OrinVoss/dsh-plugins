'use strict'
// dsh-skins 打包产物自检：在 Node 里用桩件加载 client.js，跑一遍机制。
// 覆盖：模块形状 / 插件装配 / token 层形状 / 切换与销毁 / 持久化 / 设置行渲染 / 对比度。

const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const CLIENT = path.join(__dirname, '..', 'client.js')
const source = fs.readFileSync(CLIENT, 'utf8')

let failures = 0
let checks = 0
function ok(condition, label) {
  checks++
  if (condition) {
    console.log('  ok   ' + label)
  } else {
    failures++
    console.log('  FAIL ' + label)
  }
}
function section(title) {
  console.log('\n== ' + title + ' ==')
}

// ---------- 桩件 ----------
function makeReact() {
  const react = {
    createElement(type, props) {
      const children = Array.prototype.slice.call(arguments, 2)
      return { type, props: props === null || props === undefined ? {} : props, children }
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect() {}
  }
  return react
}

function makeElement(tagName) {
  const attributes = new Map()
  return {
    tagName,
    attributes,
    textContent: '',
    setAttribute(name, value) {
      attributes.set(name, value)
    },
    removeAttribute(name) {
      attributes.delete(name)
    },
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name) : null
    }
  }
}

// preexisting 用来模拟「标签已经在文档里（可能被别的包认领过）」这一种重启场景。
function makeDom(preexisting) {
  const attributes = new Map()
  const body = {
    setAttribute(name, value) {
      attributes.set(name, value)
    },
    removeAttribute(name) {
      attributes.delete(name)
    },
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name) : null
    }
  }
  const head = {
    children: [],
    appendChild(element) {
      head.children.push(element)
    }
  }
  const document = {
    body,
    head,
    querySelector(selector) {
      if (preexisting === undefined) return null
      return selector === 'style[data-plugin-css="dsh-skins"]' ? preexisting : null
    },
    createElement(tagName) {
      return makeElement(tagName)
    }
  }
  return { document, attributes, head }
}

function makeStorage(seed) {
  const map = new Map(Object.entries(seed || {}))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    _map: map
  }
}

function loadBundle(storageSeed, preexistingStyle) {
  const dom = makeDom(preexistingStyle)
  const storage = makeStorage(storageSeed)
  const win = {
    localStorage: storage,
    __ModuleLoader__: { load(spec) { win.__loaded = spec } }
  }
  const sandbox = {
    window: win,
    document: dom.document,
    Error,
    Object,
    Array,
    String,
    Number,
    Math,
    JSON,
    console
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: CLIENT })
  const spec = win.__loaded
  return { spec, dom, storage, storageMap: storage._map }
}

function makeCtx() {
  const state = { layers: [], disposals: [], registered: [], provided: {} }
  const ctx = {
    theme: {
      overrideTokens(source, tokens) {
        state.layers.push({ source, tokens })
        return () => state.disposals.push(source)
      }
    },
    slots: {
      inject(key, callback) {
        callback()
        return () => {}
      },
      register(registration, component) {
        state.registered.push({ registration, component })
        return () => {}
      }
    },
    provide(name, value) {
      state.provided[name] = value
      return () => {}
    },
    effect(callback) {
      return callback()
    }
  }
  return { ctx, state }
}

function walk(node, visit) {
  if (node === null || node === undefined || node === false) return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node === 'string' || typeof node === 'number') {
    visit(String(node))
    return
  }
  visit(node)
  if (node.children) for (const child of node.children) walk(child, visit)
}

function collectText(node) {
  const out = []
  walk(node, (item) => {
    if (typeof item === 'string') out.push(item)
  })
  return out.join(' | ')
}

// ---------- WCAG 对比度 ----------
function parseHex(value) {
  if (typeof value !== 'string' || value[0] !== '#') return null
  const hex = value.slice(1)
  if (hex.length !== 6 && hex.length !== 3) return null
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16)
  ]
}
function luminance(rgb) {
  const channel = rgb.map((value) => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * channel[0] + 0.7152 * channel[1] + 0.0722 * channel[2]
}
function contrast(a, b) {
  const la = luminance(a)
  const lb = luminance(b)
  const light = Math.max(la, lb)
  const dark = Math.min(la, lb)
  return (light + 0.05) / (dark + 0.05)
}

// ---------- 1. 模块形状 ----------
section('模块形状')
const loaded = loadBundle()
ok(loaded.spec && loaded.spec.id === 'dsh-skins', 'bundle id = dsh-skins')
ok(typeof loaded.spec.factory === 'function', 'factory 是函数')
const exported = loaded.spec.factory((name) => {
  if (name === 'react') return makeReact()
  throw new Error('unexpected require: ' + name)
})
ok(typeof exported.apply === 'function', 'exports.apply')
ok(Array.isArray(exported.inject), 'exports.inject')
ok(exported.inject.indexOf('theme') !== -1 && exported.inject.indexOf('slots') !== -1, 'inject 声明了 slots 与 theme')
const internals = exported.skinInternals
ok(internals && Array.isArray(internals.SKINS), '暴露测试内部视图')

// ---------- 2. 皮肤注册表 ----------
section('皮肤注册表')
const skins = internals.SKINS
ok(skins.length >= 2, '至少两套皮肤（' + skins.length + '）')
ok(skins.some((s) => s.id === 'morandi'), '含莫兰迪')
ok(skins.some((s) => s.id === 'guofeng'), '含中国风')
for (const skin of skins) {
  ok(typeof skin.name === 'string' && skin.name.length > 0, skin.id + ' 有中文名：' + skin.name)
  ok(Array.isArray(skin.swatch) && skin.swatch.length >= 3, skin.id + ' 有 3 个色卡')
  ok(skin.light && skin.dark, skin.id + ' 浅色/深色两套槽位都有')
  ok(
    (skin.css || '').indexOf('body[data-dsh-skin="' + skin.id + '"]') !== -1,
    skin.id + ' 自带 css 以自身皮肤属性作前缀'
  )
  ok(typeof skin.font === 'string' && skin.font.length > 0, skin.id + ' 声明了字体栈')
  ok(typeof skin.fontName === 'string' && skin.fontName.length > 0, skin.id + ' 有字体显示名：' + skin.fontName)
  ok(/(serif|sans-serif)\s*$/.test(skin.font || ''), skin.id + ' 字体栈以通用族收尾（装不上也不塌）')
  ok((skin.font || '').indexOf('"') !== -1, skin.id + ' 字体栈里带空格的家族名已加引号')
}

// ---------- 3. token 层形状 ----------
section('token 层形状')
for (const skin of skins) {
  const layer = internals.buildLayer(skin)
  const tokens = Object.keys(layer)
  ok(tokens.length >= 80, skin.id + ' 覆盖 token 数 = ' + tokens.length)
  let bad = 0
  let nameless = 0
  for (const token of tokens) {
    const pair = layer[token]
    if (!pair || typeof pair.light !== 'string' || typeof pair.dark !== 'string' || pair.light.length === 0 || pair.dark.length === 0) bad++
    if (token.indexOf('--') !== 0) nameless++
  }
  ok(bad === 0, skin.id + ' 每个 token 都是 { light, dark } 字符串对（违规 ' + bad + '）')
  ok(nameless === 0, skin.id + ' token 名都以 -- 开头')
  ok(layer['--dsw-alias-bg-base'] !== undefined, skin.id + ' 覆盖了画布底色')
  ok(layer['--dsw-skin-id'].light === skin.id, skin.id + ' 带 --dsw-skin-id 标识 token')
  const font = layer['--dsw-font-family']
  ok(
    font !== undefined && font.light === skin.font && font.dark === skin.font,
    skin.id + ' 覆盖 --dsw-font-family（两档同值 = ' + skin.fontName + '）'
  )
}
// 缺槽位必须报错
let threw = false
try {
  internals.buildLayer({ id: 'broken', light: {}, dark: {} })
} catch (error) {
  threw = /缺少槽位/.test(String(error.message))
}
ok(threw, '缺槽位时抛出可读错误')

// ---------- 4. 装配 / 切换 / 销毁 ----------
section('运行时装配')
const run = makeCtx()
exported.apply(run.ctx)
ok(run.state.layers.length === 0, '无持久化记录时启动不叠加任何层')
ok(run.state.provided.skins !== undefined, '以 skins 服务对外提供')
ok(run.state.registered.length === 1, '注册了 1 个设置行')
ok(run.state.registered[0].registration.id === 'skins', "设置行 id = 'skins'")
ok(run.state.registered[0].registration.name === 'settings.general.item', '注册进 settings.general.item')
ok(run.state.registered[0].registration.order === 13, '排在外观(10)/字号(11)之后')

const runtime = run.state.provided.skins
ok(runtime.get() === 'default', '初始态为 default')
ok(runtime.list().length === skins.length, 'list() 返回全部皮肤')

runtime.set('morandi')
ok(run.state.layers.length === 1 && run.state.layers[0].source === 'dsh-skins/morandi', '切到莫兰迪：挂上 dsh-skins/morandi 层')
ok(loaded.dom.document.body.getAttribute('data-dsh-skin') === 'morandi', 'body 标记 data-dsh-skin=morandi')
ok(loaded.storageMap.get('dsh-skins:active') === 'morandi', '皮肤选择已持久化')

runtime.set('guofeng')
ok(run.state.layers.length === 2 && run.state.layers[1].source === 'dsh-skins/guofeng', '切到中国风：挂上新层')
ok(run.state.disposals[0] === 'dsh-skins/morandi', '切层时先销毁旧层')
ok(loaded.dom.document.body.getAttribute('data-dsh-skin') === 'guofeng', 'body 标记跟着换')

runtime.set('default')
ok(run.state.disposals[1] === 'dsh-skins/guofeng', '切回默认销毁皮肤层')
ok(loaded.dom.document.body.getAttribute('data-dsh-skin') === null, '切回默认清掉 body 标记')
ok(loaded.storageMap.has('dsh-skins:active') === false, '切回默认清掉持久化记录')

let rejected = false
try {
  runtime.set('nope')
} catch (error) {
  rejected = /未注册/.test(String(error.message))
}
ok(rejected, '未注册的皮肤 id 被拒绝')

// 重复订阅与通知
let notified = 0
const unsubscribe = runtime.subscribe(() => notified++)
runtime.set('morandi')
runtime.set('morandi')
ok(notified === 1, '同一皮肤重复设置只通知一次')
unsubscribe()
runtime.set('default')
ok(notified === 1, '退订后不再通知')

// ---------- 5. 持久化恢复 ----------
section('持久化恢复')
const reloaded = loadBundle({ 'dsh-skins:active': 'guofeng' })
const reloadedExports = reloaded.spec.factory((name) => (name === 'react' ? makeReact() : null))
const rerun = makeCtx()
reloadedExports.apply(rerun.ctx)
ok(rerun.state.layers.length === 1 && rerun.state.layers[0].source === 'dsh-skins/guofeng', '重启后自动恢复上次的皮肤')
ok(reloaded.dom.document.body.getAttribute('data-dsh-skin') === 'guofeng', '恢复后 body 标记正确')

// 未注册的持久化值必须被忽略
const stale = loadBundle({ 'dsh-skins:active': 'ghost' })
const staleExports = stale.spec.factory((name) => (name === 'react' ? makeReact() : null))
const staleRun = makeCtx()
staleExports.apply(staleRun.ctx)
ok(staleRun.state.layers.length === 0, '持久化里的陌生皮肤 id 被忽略')

// ---------- 6. 设置行渲染 ----------
section('设置行渲染')
const rowRun = makeCtx()
exported.apply(rowRun.ctx)
const component = rowRun.state.registered[0].component
let tree = null
let renderError = null
try {
  tree = component({})
} catch (error) {
  renderError = error
}
ok(renderError === null, '组件渲染不报错' + (renderError ? '：' + renderError.message : ''))
const text = collectText(tree)
ok(text.indexOf('皮肤') !== -1, '渲染出标题「皮肤」')
ok(text.indexOf('默认') !== -1, '渲染出「默认」项')
ok(text.indexOf('莫兰迪') !== -1, '渲染出「莫兰迪」项')
ok(text.indexOf('中国风') !== -1, '渲染出「中国风」项')
let fontsShown = 0
for (const skin of skins) {
  if (text.indexOf(skin.fontName) !== -1) fontsShown++
}
ok(fontsShown === skins.length, '每套皮肤的字体名都渲染出来了（' + fontsShown + '/' + skins.length + '）')
ok(text.indexOf('内置字体') !== -1, '「默认」项标注了内置字体')
let cubeCount = 0
walk(tree, (node) => {
  if (node && typeof node === 'object' && typeof node.props.className === 'string' && node.props.className.indexOf('dsh-skins-cube') !== -1) cubeCount++
})
ok(cubeCount === skins.length + 1, '皮肤方块数 = 默认 + ' + skins.length)
let swatchCount = 0
walk(tree, (node) => {
  if (node && typeof node === 'object' && node.props && node.props.className === 'dsh-skins-chip') swatchCount++
})
ok(swatchCount === (skins.length + 1) * 3, '色卡总数 = ' + (skins.length + 1) * 3)

// 点击方块能切换
rowRun.state.provided.skins.set('default')
const morandiTree = component({})
let clicked = false
walk(morandiTree, (node) => {
  if (
    !clicked &&
    node &&
    typeof node === 'object' &&
    node.props &&
    typeof node.props.className === 'string' &&
    node.props.className.indexOf('dsh-skins-cube') !== -1 &&
    node.children &&
    collectText(node).indexOf('莫兰迪') !== -1
  ) {
    clicked = true
    node.props.onClick()
  }
})
ok(clicked && rowRun.state.provided.skins.get() === 'morandi', '点「莫兰迪」方块能切到该皮肤')

// ---------- 7. 样式标签归属 ----------
section('样式标签归属（模块系统按 data-plugin 记账）')
const fresh = loadBundle()
const freshExports = fresh.spec.factory((name) => (name === 'react' ? makeReact() : null))
freshExports.apply(makeCtx().ctx)
const injected = fresh.dom.head.children[0]
ok(injected !== undefined && injected.getAttribute('data-plugin-css') === 'dsh-skins', '注入的 style 标签带 data-plugin-css="dsh-skins"')
ok(
  injected !== undefined && injected.getAttribute('data-plugin') === 'dsh-skins',
  '注入的 style 标签把自己认在 data-plugin 名下（否则会被邻居包认领，邻居热更时连样式一起删掉）'
)
ok(
  injected !== undefined && String(injected.textContent).indexOf('.dsh-skins-cube') !== -1,
  '样式表内容包含设置行样式（.dsh-skins-cube）'
)
const stolen = makeElement('style')
stolen.setAttribute('data-plugin-css', 'dsh-skins')
stolen.setAttribute('data-plugin', 'dsh-neighbour')
const repair = loadBundle(undefined, stolen)
const repairExports = repair.spec.factory((name) => (name === 'react' ? makeReact() : null))
repairExports.apply(makeCtx().ctx)
ok(stolen.getAttribute('data-plugin') === 'dsh-skins', '被别的包误认领过的标签会被改回自己名下')
ok(repair.dom.head.children.length === 0, '标签已存在时不再重复注入')

// ---------- 8. 对比度 ----------
section('对比度（浅色/深色 × 皮肤）')
const PAIRS = [
  ['textPrimary', 'canvas', 7, '正文 / 画布'],
  ['textPrimary', 'surface', 7, '正文 / 面板'],
  ['textSecondary', 'surface', 4.5, '次要文字 / 面板'],
  ['textTertiary', 'surface', 3, '三级文字 / 面板'],
  ['onAccent', 'accent', 4.5, '按钮前景 / 品牌色'],
  ['link', 'surface', 4.5, '链接 / 面板'],
  ['textPrimary', 'bubble', 7, '正文 / 气泡']
]
let worst = { ratio: 99, label: '' }
for (const skin of skins) {
  for (const scheme of ['light', 'dark']) {
    const palette = Object.assign({}, internals.SCHEME_DEFAULTS[scheme], skin[scheme])
    const results = []
    for (const [fg, bg, min, label] of PAIRS) {
      const a = parseHex(palette[fg])
      const b = parseHex(palette[bg])
      if (a === null || b === null) {
        ok(false, skin.id + '/' + scheme + ' ' + label + ' 颜色不是可解析的 hex')
        continue
      }
      const ratio = contrast(a, b)
      if (ratio < worst.ratio) worst = { ratio, label: skin.id + '/' + scheme + ' ' + label }
      results.push(label + ' ' + ratio.toFixed(2) + (ratio >= min ? '✓' : '✗(需 ' + min + ')'))
      ok(ratio >= min, skin.id + '/' + scheme + ' ' + label + ' = ' + ratio.toFixed(2) + '（需 ≥ ' + min + '）')
    }
    console.log('     ' + skin.id + '/' + scheme + ' → ' + results.join('，'))
  }
}
console.log('\n  最低对比度：' + worst.label + ' = ' + worst.ratio.toFixed(2))

// ---------- 汇总 ----------
console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败') + '：' + checks + ' 项检查，' + failures + ' 项失败')
process.exit(failures === 0 ? 0 : 1)
