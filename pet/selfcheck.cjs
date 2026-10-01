// dsh-pet 客户端半边自检：用桩件在 Node 里加载 client.js（不需要浏览器、不需要 DSH）。
//
//   node selfcheck.cjs
const fs = require('fs')
const path = require('path')
const vm = require('vm')

let factory = null
let registered = []
const storage = new Map()

const react = {
  createElement: function (type, props) {
    return { type: type, props: props || {}, children: Array.prototype.slice.call(arguments, 2) }
  },
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial })
}

const documentStub = {
  hidden: false,
  body: { appendChild() {}, removeChild() {}, style: {}, dataset: {} },
  head: { appendChild() {} },
  createElement: () => ({
    style: {},
    dataset: {},
    setAttribute() {},
    appendChild(child) {
      child.parentNode = this
    },
    removeChild(child) {
      child.parentNode = null
    },
    addEventListener() {},
    removeEventListener() {},
    textContent: ''
  }),
  querySelector: () => null,
  addEventListener() {},
  removeEventListener() {}
}

const sandbox = {
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  setInterval: setInterval,
  clearInterval: clearInterval,
  fetch: () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }),
  document: documentStub,
  window: {
    document: documentStub,
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key)
    },
    getComputedStyle: () => ({ getPropertyValue: () => '#4A65E8' }),
    setInterval: setInterval,
    clearInterval: clearInterval,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    innerWidth: 1440,
    innerHeight: 900,
    __ModuleLoader__: {
      load(definition) {
        factory = definition.factory
      }
    }
  }
}
sandbox.globalThis = sandbox

let passed = 0
const failures = []
function test(name, fn) {
  try {
    fn()
    passed++
    console.log('  ok   ' + name)
  } catch (error) {
    failures.push(name + ' :: ' + error.message)
    console.log('  FAIL ' + name + ' :: ' + error.message)
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed')
}

/** 两个字符串的公共前缀长度（用来粗略量化"两只宠物画得有多不一样"）。 */
function commonPrefixLength(a, b) {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a[i] === b[i]) i++
  return i
}

/** 迷你 react → 文本渲染器：调用函数组件，好断言真正落到 DOM 上的类名与文案。 */
function renderTree(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(renderTree).join('')
  if (typeof node.type === 'function') return renderTree(node.type(node.props))
  const props = node.props || {}
  const attrs = Object.keys(props)
    .filter((key) => key !== 'children' && key !== 'key' && typeof props[key] !== 'function' && props[key] !== undefined)
    .map((key) => key + '=' + String(props[key]))
    .join(' ')
  const children = (node.children || []).map(renderTree).join('')
  return '<' + node.type + ' ' + attrs + '>' + children + '</' + node.type + '>'
}

const clientPath = path.join(__dirname, 'client.js')
const code = fs.readFileSync(clientPath, 'utf8')
vm.runInNewContext(code, sandbox, { filename: clientPath })
const mod = factory((name) => {
  if (name === 'react') return react
  throw new Error('unexpected require: ' + name)
})

console.log('\n[1] 模块形状')
test('工厂返回 apply / inject / internals', () => {
  assert(factory !== null, 'window.__ModuleLoader__.load 没有被调用')
  assert(typeof mod.apply === 'function', '缺少 apply')
  assert(Array.isArray(mod.inject) && mod.inject.indexOf('slots') >= 0, 'inject 缺少 slots')
  assert(mod.petInternals && typeof mod.petInternals === 'object', '缺少 petInternals')
})

const I = mod.petInternals

console.log('\n[2] 宠物注册表')
test('至少 5 只宠物，id 唯一', () => {
  assert(I.PETS.length >= 5, '宠物太少：' + I.PETS.length)
  const ids = I.PETS.map((pet) => pet.id)
  assert(new Set(ids).size === ids.length, 'id 重复')
})

test('猫和柴犬必须一眼分得开（骨架相同但特征不同）', () => {
  const cat = I.PETS.find((pet) => pet.id === 'cat')
  const shiba = I.PETS.find((pet) => pet.id === 'shiba')
  assert(cat && shiba, '缺少猫或柴犬')
  // 关键特征必须不同：耳朵造型 / 尾巴造型 / 口鼻 / 项圈
  assert(cat.params.ear !== shiba.params.ear, '耳朵造型没区分')
  assert(cat.params.tail !== shiba.params.tail, '尾巴造型没区分')
  assert(typeof shiba.params.collar === 'string', '柴犬应戴项圈')
  assert(shiba.params.collar === undefined || cat.params.collar === undefined, '猫不该戴项圈')
  const catSvg = I.renderPet(cat, {})
  const shibaSvg = I.renderPet(shiba, {})
  // 狗的口鼻是独立椭圆 + 黑鼻头，猫是三角鼻 + ω 嘴
  assert(shibaSvg.indexOf('<ellipse cx="22" cy="20.8"') >= 0, '柴犬缺少突出的口鼻')
  assert(catSvg.indexOf('<ellipse cx="22" cy="20.8"') < 0, '猫不该有狗式口鼻')
  // 结构差异足够大（不是只换了颜色）
  const differing = catSvg.length + shibaSvg.length - 2 * commonPrefixLength(catSvg, shibaSvg)
  assert(differing > 400, '两只的造型差异太小：' + differing)
})

test('每只都有名字/说明/三色卡/rig/参数', () => {
  for (const pet of I.PETS) {
    assert(typeof pet.name === 'string' && pet.name.length > 0, pet.id + ' 缺 name')
    assert(typeof pet.hint === 'string' && pet.hint.length > 0, pet.id + ' 缺 hint')
    assert(Array.isArray(pet.swatch) && pet.swatch.length === 3, pet.id + ' 的 swatch 应为 3 色')
    for (const color of pet.swatch) assert(/^#[0-9a-fA-F]{3,8}$/.test(color), pet.id + ' 色值不合法：' + color)
    assert(typeof I.renderPet === 'function', '缺少 renderPet')
    assert(pet.params && typeof pet.params === 'object', pet.id + ' 缺 params')
  }
})

test('每只都能渲染出合法 SVG（含可动部位类名、无 currentColor、无外链）', () => {
  for (const pet of I.PETS) {
    const svg = I.renderPet(pet, {})
    assert(svg.indexOf('<svg') === 0, pet.id + ' 不是从 <svg 开头')
    assert(svg.indexOf('class="pet-body"') >= 0, pet.id + ' 缺少 pet-body')
    assert(svg.indexOf('pet-eye') >= 0, pet.id + ' 缺少 pet-eye')
    assert(svg.indexOf('currentColor') < 0, pet.id + ' 不应依赖 currentColor')
    assert(svg.indexOf('<script') < 0, pet.id + ' 不应包含 script')
    assert(!/https?:\/\//.test(svg.replace('http://www.w3.org/2000/svg', '')), pet.id + ' 不应有外链')
    const open = (svg.match(/<g\b/g) || []).length
    const close = (svg.match(/<\/g>/g) || []).length
    assert(open === close, pet.id + ' 的 <g> 不配对：' + open + '/' + close)
    assert(svg.indexOf('</svg>') === svg.length - 6, pet.id + ' 没有正确闭合')
  }
})

test('跟随皮肤的宠物会换强调色', () => {
  const linked = I.PETS.filter((pet) => pet.link === true)
  assert(linked.length > 0, '没有 link 型宠物')
  for (const pet of linked) {
    const bare = I.renderPet(pet, {})
    const tinted = I.renderPet(pet, { accent: '#FF00AA' })
    assert(bare !== tinted, pet.id + ' 在跟随皮肤时应换色')
    assert(tinted.indexOf('#FF00AA') >= 0, pet.id + ' 没有用上强调色')
  }
  const plain = I.PETS.find((pet) => pet.link !== true)
  assert(I.renderPet(plain, {}) === I.renderPet(plain, { accent: '#FF00AA' }), '非 link 型宠物不应变色')
})

test('猫有猫的特征：虎斑额纹 / 粉鼻头 / 胡须 / 环纹尾 / 接地阴影', () => {
  const cat = I.PETS.find((pet) => pet.id === 'cat')
  assert(cat, '缺少猫')
  assert(cat.params.stripes === true, '猫应有虎斑额纹')
  assert(typeof cat.params.nose === 'string' && cat.params.nose.length > 0, '猫应有自己的鼻头色')
  assert(cat.params.whisker === true, '猫应有胡须')
  const svg = I.renderPet(cat, {})
  assert(svg.indexOf(cat.params.nose) >= 0, '鼻头色没画出来：' + cat.params.nose)
  assert(svg.indexOf(cat.params.furDark) >= 0, '虎斑用的深色没画出来：' + cat.params.furDark)
  assert(svg.indexOf('cy="36.2"') >= 0, '缺少接地阴影')
  // 胡须应该是曲线（q 命令），不是生硬的直线
  const whiskerBlock = svg.match(/opacity="\.32"[^>]*>([\s\S]*?)<\/g>/)
  assert(whiskerBlock !== null && whiskerBlock[1].indexOf('q') >= 0, '胡须应为曲线')
  // 猫不该有项圈
  assert(cat.params.collar === undefined, '猫不该戴项圈')
})

console.log('\n[3] 状态推导')
const now = 1_000_000
test('六种状态都能被推导出来', () => {
  const idle = I.deriveState({ startedAt: now - 1000 }, now, { patAt: null })
  assert(idle === 'idle', '空闲应为 idle，实际 ' + idle)
  assert(I.deriveState({ running: true }, now, { patAt: null }) === 'work', 'running 应为 work')
  assert(I.deriveState({ activeTools: 2 }, now, { patAt: null }) === 'work', '有活跃工具应为 work')
  assert(I.deriveState({ awaitingApproval: true }, now, { patAt: null }) === 'wait', '等待授权应为 wait')
  assert(I.deriveState({ lastError: { message: 'x', at: now - 100 } }, now, { patAt: null }) === 'error', '刚报错应为 error')
  assert(I.deriveState({ lastTurnEndAt: now - 100 }, now, { patAt: null }) === 'done', '刚收工应为 done')
  assert(I.deriveState({ startedAt: now - 200000 }, now, { patAt: null }) === 'sleep', '长时间无动静应打盹')
})

test('优先级：等待授权 > 报错 > 干活 > 收工', () => {
  const busy = { running: true, awaitingApproval: true, lastError: { at: now }, lastTurnEndAt: now }
  assert(I.deriveState(busy, now, { patAt: null }) === 'wait')
  assert(I.deriveState({ running: true, lastError: { at: now } }, now, { patAt: null }) === 'error')
  assert(I.deriveState({ running: true, lastTurnEndAt: now }, now, { patAt: null }) === 'work')
})

test('报错/收工有显示窗口，过期后回到 idle', () => {
  assert(I.deriveState({ lastError: { at: now - 60000 } }, now, { patAt: null }) === 'idle')
  assert(I.deriveState({ lastTurnEndAt: now - 60000 }, now, { patAt: null }) === 'idle')
})

test('摸头只在不忙的时候抢戏', () => {
  assert(I.deriveState({}, now, { patAt: now - 200 }) === 'pat')
  assert(I.deriveState({ running: true }, now, { patAt: now - 200 }) === 'work')
})

test('气泡文案随口最状态变化', () => {
  assert(I.bubbleText('work', { lastTool: { name: 'read', at: now } }, now) === '翻文件…', '应显示中文动作词')
  assert(I.bubbleText('work', { lastTool: { name: 'read', at: now - 60000 } }, now) === '干活中…')
  assert(I.bubbleText('wait', {}, now) === '等你点头')
  assert(I.bubbleText('done', {}, now) === '收工啦')
  assert(I.bubbleText('idle', {}, now) === '')
})

test('工具名一律翻成人话，绝不吐原名', () => {
  assert(I.toolLabel('read_image') === '看图', 'read_image 应翻成看图')
  assert(I.toolLabel('read') === '翻文件')
  assert(I.toolLabel('pwsh') === '敲命令' && I.toolLabel('bash') === '敲命令')
  assert(I.toolLabel('edit') === '改代码' && I.toolLabel('web_search') === '搜网页')
  assert(I.toolLabel('subagent') === '派小弟' && I.toolLabel('todo_write') === '列清单')
  assert(I.toolLabel('mcp__kimi-cu__read_image') === '看图', 'MCP 工具名应取最后一段再归类')
  assert(I.toolLabel('weird_screenshot_thing') === '看图', '按关键词兜底')
  assert(I.toolLabel('') === '忙活着' && I.toolLabel(undefined) === '忙活着', '空值应兜底')
  assert(I.toolLabel('zzz_unknown') === '忙活着', '认不出来也不吐原名')
  for (const name of Object.keys(I.TOOL_LABELS)) {
    const label = I.TOOL_LABELS[name]
    assert(/[\u4e00-\u9fa5]/.test(label), name + ' 的标签应是中文：' + label)
    assert(label.indexOf('_') < 0, name + ' 的标签不该带下划线')
  }
  const bubble = I.bubbleText('work', { lastTool: { name: 'read_image', at: now } }, now)
  assert(bubble === '看图…', '气泡里不该出现 read_image，实际 ' + bubble)
})

console.log('\n[4] 偏好与统计')
test('坏输入回落到默认值', () => {
  const prefs = I.normalizePrefs({ pet: '不存在', scale: 'x', corner: 'xx', x: 'a', y: NaN })
  assert(prefs.pet === 'cat' && prefs.scale === I.SCALE.default && prefs.corner === 'br', '未回落：' + JSON.stringify(prefs))
  assert(prefs.link === true && prefs.quiet === false && prefs.hidden === false, '布尔默认值不对')
  assert(prefs.x === null && prefs.y === null, '坐标应回落为 null')
})

test('尺寸随便调：只夹到范围内，支持小数取整与旧档位迁移', () => {
  assert(I.SCALE.max - I.SCALE.min >= 150, '可调范围太窄：' + I.SCALE.min + '..' + I.SCALE.max)
  assert(I.normalizePrefs({ scale: 500 }).scale === I.SCALE.max, '超大应夹到上限')
  assert(I.normalizePrefs({ scale: 1 }).scale === I.SCALE.min, '超小应夹到下限')
  assert(I.normalizePrefs({ scale: 99.6 }).scale === 100, '小数应取整')
  assert(I.normalizePrefs({ scale: 137 }).scale === 137, '范围内应原样保留')
  assert(I.normalizePrefs({ size: 'small' }).scale === 40, '旧档位 small 应迁移成 40')
  assert(I.normalizePrefs({ size: 'large' }).scale === 96, '旧档位 large 应迁移成 96')
  assert(I.normalizePrefs({}).scale === I.SCALE.default, '缺省应为默认尺寸')
  for (const preset of I.SIZE_PRESETS) {
    assert(typeof preset.px === 'number' && typeof preset.name === 'string', '快捷键定义不完整')
    assert(preset.px >= I.SCALE.min && preset.px <= I.SCALE.max, '快捷键超出范围：' + preset.px)
  }
})

test('部分偏好被保留，坐标取整', () => {
  const prefs = I.normalizePrefs({ pet: 'koi', quiet: true, x: 120.6, y: 40.2 })
  assert(prefs.pet === 'koi' && prefs.quiet === true && prefs.x === 121 && prefs.y === 40)
})

test('等级随 token 单调增长', () => {
  assert(I.petLevel({ tokens: 0 }) === 1)
  assert(I.petLevel({ tokens: 50000 }) === 2)
  assert(I.petLevel({ tokens: 499999 }) === 10)
  assert(I.petLevel({ tokens: 999999 }) > I.petLevel({ tokens: 1000 }))
  assert(I.petStats({ tokens: 120000, turns: 3, toolCalls: 9 }).indexOf('等级 3') === 0, '等级算错：' + I.petStats({ tokens: 120000 }))
})

console.log('\n[5] 样式表')
test('六种状态的动画与兜底都在', () => {
  for (const key of ['pet-breathe', 'pet-sway', 'pet-blink', 'pet-work', 'pet-jump', 'pet-spark', 'pet-smoke', 'pet-zzz', 'pet-heart']) {
    assert(I.CSS.indexOf('@keyframes ' + key) >= 0, '缺少关键帧 ' + key)
  }
  for (const state of ['work', 'wait', 'done', 'error', 'sleep', 'pat']) {
    assert(I.CSS.indexOf('[data-state="' + state + '"]') >= 0, '缺少状态样式 ' + state)
  }
  assert(I.CSS.indexOf('prefers-reduced-motion') >= 0, '缺少减少动态效果兜底')
  assert(I.CSS.indexOf('data-quiet="true"') >= 0, '缺少静默模式兜底')
  assert(I.CSS.indexOf('currentColor') < 0, '样式表里不应有 currentColor')
})

test('对话框带小尾巴，且贴顶时能翻到下方', () => {
  assert(I.CSS.indexOf('.pet-bubble::after') >= 0, '缺少对话框尾巴')
  assert(I.CSS.indexOf('rotate(45deg)') >= 0, '尾巴应由旋转方块构成')
  assert(I.CSS.indexOf('data-side="below"') >= 0, '缺少气泡翻转样式')
  const tail = I.CSS.match(/\.pet-bubble::after\{[^}]*\}/)
  assert(tail !== null && tail[0].indexOf('background:inherit') >= 0, '尾巴应继承气泡底色')
})

console.log('\n[6] 运动（宠物要真的会走）')
test('每只宠物的骨架都有运动档，且可走范围为正', () => {
  const rigs = new Set(I.PETS.map((pet) => pet.rig))
  for (const rig of rigs) {
    assert(I.RIG_MOTION[rig] !== undefined, '骨架缺运动档：' + rig)
    assert(I.RIG_MOTION[rig].spanX > 0, rig + ' 的 spanX 必须为正')
  }
  assert(I.motionProfile(I.PETS[0]).kind === 'walk', '猫应该是踱步')
  assert(I.motionProfile(I.PETS.find((p) => p.id === 'koi')).kind === 'glide', '锦鲤应该是滑行')
  assert(I.motionProfile(I.PETS.find((p) => p.id === 'slime')).kind === 'hop', '史莱姆应该是跳')
  assert(I.motionProfile(I.PETS.find((p) => p.id === 'robot')).kind === 'hover', '机器人应该是飘')
})

test('走动开关：静默 / 减少动态效果 / 页面隐藏 / 正在拖拉时都不动', () => {
  assert(I.motionEnabled({ roam: true }, {}) === true, '默认可动')
  assert(I.motionEnabled({ roam: false }, {}) === false, '关了就该停')
  assert(I.motionEnabled({ roam: true, quiet: true }, {}) === false, '静默模式不动')
  assert(I.motionEnabled({ roam: true }, { reducedMotion: true }) === false, '减少动态效果不动')
  assert(I.motionEnabled({ roam: true }, { hidden: true }) === false, '页面不可见不动')
  assert(I.motionEnabled({ roam: true }, { busy: true }) === false, '正在拖 / 刚摸头时不动')
})

test('可走范围贴着视口边，不会走出屏幕', () => {
  const profile = { spanX: 130, spanY: 40 }
  const size = { width: 60, height: 60 }
  const viewport = { width: 1440, height: 900 }
  const middle = I.homeBounds({ x: 700, y: 400 }, size, profile, viewport)
  assert(Math.abs(middle.minDx + 130) < 0.01 && Math.abs(middle.maxDx - 130) < 0.01, '居中的家应该能左右各走 130')
  const rightEdge = I.homeBounds({ x: 1440 - 60 - 10, y: 400 }, size, profile, viewport)
  assert(rightEdge.maxDx <= 0.01, '贴着右边缘时不该还能往右走：' + rightEdge.maxDx)
  assert(rightEdge.minDx <= -100, '右边缘时应该能往左走')
  const bottom = I.homeBounds({ x: 700, y: 900 - 60 - 10 }, size, profile, viewport)
  assert(bottom.maxDy <= 0.01, '贴着底边时不该还能往下走')
})

test('滑行轨迹是正弦且始终落在范围内', () => {
  const profile = I.RIG_MOTION.fish
  const bounds = { minDx: -150, maxDx: 150, minDy: -40, maxDy: 40 }
  let minX = Infinity
  let maxX = -Infinity
  let sawLeft = false
  let sawRight = false
  for (let t = 0; t < 60; t += 0.05) {
    const offset = I.glideOffset(profile, bounds, t)
    assert(offset.dx >= bounds.minDx - 0.01 && offset.dx <= bounds.maxDx + 0.01, '越界 dx=' + offset.dx)
    assert(offset.dy >= bounds.minDy - 0.01 && offset.dy <= bounds.maxDy + 0.01, '越界 dy=' + offset.dy)
    minX = Math.min(minX, offset.dx)
    maxX = Math.max(maxX, offset.dx)
    if (offset.vx > 0.2) sawRight = true
    if (offset.vx < -0.2) sawLeft = true
  }
  assert(maxX - minX > 200, '滑行幅度太小：' + (maxX - minX))
  assert(sawLeft && sawRight, '滑行应该来回换方向（这样才能翻面）')
})

test('随机目标点永远在范围内', () => {
  const bounds = { minDx: -100, maxDx: 100, minDy: -30, maxDy: 30 }
  for (let i = 0; i < 50; i++) {
    const target = I.pickTarget(bounds, Math.random)
    assert(target.x >= bounds.minDx && target.x <= bounds.maxDx, 'x 越界 ' + target.x)
    assert(target.y >= bounds.minDy && target.y <= bounds.maxDy, 'y 越界 ' + target.y)
  }
})

test('运行时会真的算出位移并写进 transform', () => {
  const runtime = new I.PetRuntime()
  const host = { appendChild() {} }
  runtime.attach(host)
  runtime.patch({ pet: 'koi', roam: true, quiet: false })
  runtime.stepMotion(1000)
  runtime.stepMotion(2500)
  assert(Math.abs(runtime.motion.dx) > 0.5 || Math.abs(runtime.motion.dy) > 0.5, '锦鲤应该已经游开了：' + JSON.stringify(runtime.motion))
  assert(String(runtime.root.style.transform).indexOf('translate3d') >= 0, '位移应写进 transform')
  // 关掉走动后立刻回到"家"
  runtime.patch({ roam: false })
  runtime.stepMotion(3000)
  assert(runtime.motion.dx === 0 && runtime.motion.dy === 0, '关掉走动应回到原点')
  assert(runtime.root.style.transform === '', '关掉走动应清掉 transform')
  // 猫是踱步：给两帧时间也该动起来
  runtime.patch({ pet: 'cat', roam: true })
  runtime.stepMotion(100)
  runtime.stepMotion(600)
  runtime.stepMotion(1200)
  assert(Math.abs(runtime.motion.dx) > 0.2 || Math.abs(runtime.motion.dy) > 0.2, '猫也该踱起来：' + JSON.stringify(runtime.motion))
  runtime.dispose()
})

console.log('\n[7] 设置行与浮层宿主')
test('设置行渲染出 5 个宠物件、步进胶囊与三个开关', () => {
  const json = renderTree(I.PetRow())
  assert(json.indexOf('dsh-pet-group') >= 0, '缺少分组容器')
  for (const name of ['像素猫', '柴犬', '锦鲤', '史莱姆', '小机器人']) {
    assert(json.indexOf(name) >= 0, '缺少宠物件 ' + name)
  }
  assert(json.indexOf('跟随皮肤') >= 0 && json.indexOf('静默') >= 0 && json.indexOf('显示') >= 0, '缺少开关')
  assert(json.indexOf('大小') >= 0 && json.indexOf('位置') >= 0, '缺少控件标签')
  assert(json.indexOf('dsh-pet-stepper') >= 0, '缺少步进胶囊')
  assert(json.indexOf('dsh-pet-arrow') >= 0, '步进胶囊缺少上下箭头')
  assert(json.indexOf('type=range') < 0, '不该再用原生 range 滑块')
  for (const preset of I.SIZE_PRESETS) assert(json.indexOf(preset.name) >= 0, '缺少尺寸快捷键 ' + preset.name)
})

test('步进胶囊：结构、边界禁用与连发定时器', () => {
  const steps = []
  const tree = I.PetStepper({ value: 64, min: 28, max: 200, step: 2, onStep: (delta) => steps.push(delta) })
  assert(tree.props.className === 'dsh-pet-stepper', '根节点类名不对')
  assert(tree.children[0].children[0] === '64', '应显示当前数值')
  const arrows = tree.children[1]
  assert(arrows.children.length === 2, '应有两个箭头')
  assert(arrows.children[0].props['aria-label'] === '放大一点', '上箭头标签不对')
  assert(arrows.children[1].props['aria-label'] === '缩小一点', '下箭头标签不对')
  assert(arrows.children[0].props.disabled !== true, '未到上限不该禁用')
  assert(arrows.children[1].props.disabled !== true, '未到下限不该禁用')
  // 触发一次上箭头：立即步进一次 + 挂一个连发定时器
  arrows.children[0].props.onPointerDown()
  assert(steps.length === 1 && steps[0] === 2, '上箭头应立即 +2，实际 ' + JSON.stringify(steps))
  arrows.children[0].props.onPointerUp()
  // 边界：到顶/到底时对应箭头禁用
  const top = I.PetStepper({ value: 200, min: 28, max: 200, step: 2, onStep: () => {} })
  assert(top.children[1].children[0].props.disabled === true, '到上限应禁用上箭头')
  const bottom = I.PetStepper({ value: 28, min: 28, max: 200, step: 2, onStep: () => {} })
  assert(bottom.children[1].children[1].props.disabled === true, '到下限应禁用下箭头')
})

test('浮层宿主渲染一个空容器', () => {
  const tree = I.PetLayer()
  assert(tree.props.className === 'dsh-pet-host', '浮层容器类名不对：' + tree.props.className)
})

console.log('\n[8] 插件装配')
test('apply 注册两个槽位与 pets 服务', () => {
  const calls = []
  const effects = []
  const ctx = {
    provide: (key, value) => {
      calls.push('provide:' + key)
      return () => {}
    },
    effect: (fn, label) => {
      effects.push(label)
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    slots: {
      inject: (key, callback) => {
        calls.push('inject:' + key)
        callback()
        return () => {}
      },
      register: (declaration) => {
        calls.push('register:' + declaration.name + '#' + declaration.id)
        return () => {}
      }
    }
  }
  mod.apply(ctx)
  assert(calls.indexOf('provide:pets') >= 0, '没有 provide pets 服务')
  assert(calls.indexOf('register:shell.overlay#pet') >= 0, '没有注册浮层宿主')
  assert(calls.indexOf('register:settings.general.item#pet') >= 0, '没有注册设置行')
  assert(effects.some((label) => String(label).indexOf('teardown') >= 0), '缺少 teardown effect')
})

console.log('\n[9] 运行时（DOM 桩件）')
test('PetRuntime 能挂载、切换宠物并持久化', () => {
  const runtime = new I.PetRuntime()
  assert(runtime.get() === 'cat', '默认宠物应为 cat')
  runtime.patch({ pet: 'koi' })
  assert(runtime.get() === 'koi', 'patch 没生效')
  assert(storage.get('dsh-pet:prefs').indexOf('koi') >= 0, '偏好没写进 localStorage')
  const ids = runtime.list().map((item) => item.id)
  assert(ids.length === I.PETS.length, 'list() 数量不对')
  let seen = null
  const off = runtime.subscribe((prefs) => {
    seen = prefs.pet
  })
  runtime.patch({ pet: 'robot' })
  assert(seen === 'robot', '订阅者没收到通知')
  off()
  runtime.patch({ pet: 'slime' })
  assert(seen === 'robot', '退订后不应再收到通知')
  assert(runtime.cycle(1) === 'robot', 'slime 的下一只应为 robot')
  assert(runtime.cycle(1) === 'cat', '绕到末尾应回到第一只')
  // 尺寸微调：上下箭头走 nudgeScale，必须夹在范围内
  runtime.patch({ scale: 100 })
  assert(runtime.nudgeScale(2) === 102, 'nudgeScale 应 +2')
  assert(runtime.nudgeScale(-4) === 98, 'nudgeScale 应 -4')
  runtime.patch({ scale: I.SCALE.max })
  assert(runtime.nudgeScale(10) === I.SCALE.max, '不能超过上限')
  runtime.patch({ scale: I.SCALE.min })
  assert(runtime.nudgeScale(-10) === I.SCALE.min, '不能低于下限')
  runtime.dispose()
})

console.log('\n[10] 包声明')
test('package.json 是组合包并带展示元信息', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'))
  assert(pkg.name === 'dsh-pet', '包名不对')
  assert(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch === './cordis.patch.yml', '缺少 bundle patch')
  assert(pkg.dsh.client && pkg.dsh.client.platform === 'web', '缺少 dsh.client')
  assert(pkg.icon === './icon.svg', '缺少 icon')
  assert(pkg.exports['./locale/*.json'] === './locale/*.json', 'exports 未放开 locale')
  for (const file of ['host.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'locale/zh.json', 'locale/en.json']) {
    assert(fs.existsSync(path.join(__dirname, file)), '缺少文件 ' + file)
  }
})

test('cordis.patch.yml 的 insert 与包名一致', () => {
  const yml = fs.readFileSync(path.join(__dirname, 'cordis.patch.yml'), 'utf8')
  assert(/id:\s*pet\b/.test(yml), 'patch 缺少 id: pet')
  assert(/name:\s*dsh-pet\b/.test(yml), 'patch 缺少 name: dsh-pet')
})

console.log('\n' + passed + ' 项通过，' + failures.length + ' 项失败')
if (failures.length > 0) {
  for (const failure of failures) console.log('  - ' + failure)
  process.exit(1)
}
