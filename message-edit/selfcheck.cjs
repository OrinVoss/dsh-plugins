/**
 * dsh-message-edit 静态自检：不启动 DSH，只做语法与关键断言的静态核对。
 *
 *   node selfcheck.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const dir = __dirname
const failures = []
const notes = []
const check = (name, ok, detail) => {
  if (ok) notes.push(`PASS ${name}`)
  else failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

// 1) 文件齐备
for (const file of ['host.js', 'client.js', 'package.json', 'icon.svg', 'locale/zh.json', 'locale/en.json', 'README.md']) {
  check(`存在 ${file}`, fs.existsSync(path.join(dir, file)))
}

// 2) 语法
for (const file of ['host.js', 'client.js']) {
  const source = fs.readFileSync(path.join(dir, file), 'utf8')
  try {
    new vm.Script(source, { filename: file })
    check(`${file} 语法`, true)
  } catch (error) {
    check(`${file} 语法`, false, error.message)
  }
}

const host = fs.readFileSync(path.join(dir, 'host.js'), 'utf8')
const client = fs.readFileSync(path.join(dir, 'client.js'), 'utf8')

// 3) 宿主半边关键点
check('宿主导出 name/inject/apply', /module\.exports\s*=\s*\{/.test(host) && /name:\s*NAME/.test(host) && /inject:\s*\[/.test(host))
check('使用表面替换 replace', /op:\s*'replace'/.test(host))
check('sourceEventSeqs 覆盖遮蔽范围', /sourceEventSeqs:\s*shadowed/.test(host))
check('遮蔽节点是 user/message（唯一非 step 表面类型）', /session\.append\(\s*'user\/message'/.test(host) && /RECALL_SOURCE/.test(host))
check('遮蔽事件带可识别标记', /MARK\s*=\s*'dsh-recall:'/.test(host) && /id\.startsWith\(MARK\)/.test(host) && /data\.source\.kind === RECALL_SOURCE/.test(host))
check('含 step 作用域自检（旧 corrupt bug 的回归闸）', /function stepScopeViolations/.test(host) && /stepScopeViolations\(session\.snapshotEvents\(\)\)/.test(host))
check('自检含反向验证', /detector-catches-old-bug/.test(host))
check('空闲检查（未闭合轮次）', /function hasOpenTurn/.test(host))
check('落盘 flush', /ctx\.sessions\.flush\(session\)/.test(host))
check('编辑走 sessionController.prompt', /sessionController/.test(host) && /mode:\s*'queue'/.test(host))
check('三条路由齐备', ['/message-edit-api/state', '/message-edit-api/apply', '/message-edit-api/selftest'].every((p) => host.includes(p)))
check('不删除日志事件（无 truncate/splice 掉日志）', !/\.log\.splice|deleteEvent|removeEvent/.test(host))

// 4) 客户端半边关键点
check('客户端走 __ModuleLoader__', /__ModuleLoader__\.load\(/.test(client))
check('只 require react', (client.match(/require\((?![^)]*react)[^)]*\)/g) ?? []).length === 0)
check('注册进 conversation.chat.node 的 user key', /name:\s*SLOT,\s*key:\s*kind,\s*\/\/[^\n]*\n\s*priority:\s*-\d+/.test(client) || /name:\s*SLOT,\s*key:\s*kind/.test(client))
check('负 priority 遮蔽', /priority:\s*-\d+/.test(client))
check('复制官方 locale（读 entry 而非 entry.options）', /official\.locale === undefined \? \{\} : \{ locale: official\.locale \}/.test(client))
check('复制官方 inject', /official\.inject === undefined \? \{\} : \{ inject: official\.inject \}/.test(client))
check('官方条目按 priority 0 定位', /\(entry\.options\.priority \?\? 0\) === 0/.test(client))
check('遮蔽优先级低于官方（压过热更遗留）', /priority:\s*-\d{3,}/.test(client))
check('按轮次的行过滤', /data-chat-turn/.test(client) && /applyHiddenRows/.test(client))
// 行过滤必须**逐行判断**，不能取「首尾连续区间」：撤回/编辑可以多次发生，中间夹着之后新建的
// 正常轮次，被遮蔽集合因此有空洞；取连续区间会把空洞里的正常轮次一起藏掉（2026-10-14 真机反馈：
// 某会话 16 个被遮蔽轮次 → 连续区间 103 个轮次，多藏 87 个）。
// 把纯函数 hiddenRowFlags 从 client.js 里抠出来直接跑 —— 测的是真代码，不是复制品。
{
  const m = /function hiddenRowFlags\([\s\S]*?\n    \}/.exec(client)
  check('找到纯函数 hiddenRowFlags（行过滤判定可测）', m !== null)
  if (m !== null) {
    // eslint-disable-next-line no-new-func
    const hiddenRowFlags = new Function(`return (${m[0]})`)()
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
    check('后缀块：3,4,5 全藏', eq(hiddenRowFlags(['3', '3', '4', '5'], [3, 4, 5]), [true, true, true, true]))
    check('有空洞：只藏集合里的轮次，区间内正常轮次必须留着（回归闸）',
      eq(hiddenRowFlags(['3', '4', '5', '6', '11', '12'], [3, 4, 6, 11]), [true, true, false, true, true, false]))
    check('没有 data-chat-turn 的行沿用上一行轮次', eq(hiddenRowFlags(['5', null, null, '6'], [5]), [true, true, true, false]))
    check('首个带轮次的行之前，属性缺失的行不藏', eq(hiddenRowFlags([null, '5'], [5]), [false, true]))
    check('空输入不炸', eq(hiddenRowFlags([], []), []))
  }
}
check('编辑态沿用官方气泡几何', /--dsw-radius-xl/.test(client) && /padding:9px 15px/.test(client) && /--dsh-content-font-size,14px/.test(client))
// 编辑框宽度：**右缘锚定气泡右缘**，宽度 = max(气泡宽, EDIT_MIN_WIDTH)，多出的宽度全部向左长，
// 并用 --me-extra-left 补成左内边距（文字不动）。
// 反过来（左缘锚定 + minWidth）会让盒子向右长、右缘越出内容列，把贴右缘的 ✓/✕ 顶到滚动条上
// （2026-10-14 真机反馈：编辑 "ok" 时盒子被撑到 172 CSS px，✕ 中心与滚动条虚线重叠）。
// 宽度算术也跑真函数：max(气泡宽, 最小宽)，多出的部分向左长。
{
  const mm = /function editorBoxWidth\([\s\S]*?\n    \}/.exec(client)
  check('找到纯函数 editorBoxWidth（宽度算术可测）', mm !== null)
  if (mm !== null) {
    // 纯函数引用了闭包常量 EDIT_MIN_WIDTH，按参数注入；值从 client.js 里读，避免测试里另写一份。
    const minW = Number((/const EDIT_MIN_WIDTH = (\d+)/.exec(client) ?? [])[1] || 180)
    // eslint-disable-next-line no-new-func
    const editorBoxWidth = new Function('EDIT_MIN_WIDTH', `return (${mm[0]})`)(minW)
    const j = (v) => JSON.stringify(v)
    check('两字符气泡（58px）⇒ 盒子取最小宽 180px', editorBoxWidth(58) === 180)
    check('刚好 180px 的气泡 ⇒ 宽度不变', editorBoxWidth(180) === 180)
    check('比最小宽还宽的气泡（400px）⇒ 严格等于气泡', editorBoxWidth(400) === 400)
    check('极窄（12px）⇒ 仍是 180px', editorBoxWidth(12) === 180)
  }
}

// 挑气泡的纯函数：合成候选跑真代码（2026-10-19 的 bug 就是"按 DOM 层级猜"猜到了别的块）
{
  const pm = /function pickBubbleRect\([\s\S]*?\n    \}/.exec(client)
  check('找到纯函数 pickBubbleRect（挑气泡可测）', pm !== null)
  if (pm !== null) {
    // pickBubbleRect 依赖同作用域的 hasFill，把**真 hasFill** 注入进来（都跑真代码）。
    const hm = /function hasFill\([\s\S]*?\n    \}/.exec(client)
    check('找到纯函数 hasFill', hm !== null)
    // eslint-disable-next-line no-new-func
    const hasFill = new Function(`return (${hm[0]})`)()
    // eslint-disable-next-line no-new-func
    const pickBubbleRect = new Function('hasFill', `return (${pm[0]})`)(hasFill)
    const box = (w, h) => ({ width: w, height: h })
    const bubble = { rect: box(240, 42), background: 'rgb(1, 2, 3)', text: '现在正常了，你无需测试了' }
    const actions = { rect: box(100, 28), background: 'transparent', text: '' }
    const chip = { rect: box(80, 24), background: 'rgb(9, 9, 9)', text: '工作区内修改' }
    const wrap = { rect: box(700, 500), background: 'rgb(1, 2, 3)', text: '现在正常了，你无需测试了' }
    check('只有气泡时选气泡', pickBubbleRect([bubble], '现在正常了') === bubble.rect)
    check('透明块（操作行）不会被选中', pickBubbleRect([actions, bubble], '现在正常了') === bubble.rect)
    check('祖先块也含文字时选**面积最小**的（气泡本体）', pickBubbleRect([wrap, bubble], '现在正常了') === bubble.rect)
    check('全都透明时返回 null', pickBubbleRect([actions], '现在正常了') === null)
    check('无候选时返回 null', pickBubbleRect([], '现在正常了') === null)
    check('probe 为空时退回面积最大的有底色块',
      pickBubbleRect([chip, bubble], '') === bubble.rect)
  }
}

check('编辑框右缘锚定气泡右缘 + 最小宽度向左生长（不得用 minWidth 向右撑）',
  /const EDIT_MIN_WIDTH = 180/.test(client)
  && /Math\.max\(bubbleWidth, EDIT_MIN_WIDTH\)/.test(client)   // 宽度算术在纯函数里
  && /editorBoxWidth\(editBox\.width\)/.test(client)
  && /right: Math\.round\(rootRect\.right - rect\.right\)/.test(client)
  && /right: `\$\{editBox\.right\}px`/.test(client)
  // 文本区必须铺满盒子（2026-10-19：曾用左内边距把多出的宽度补回去，短消息被挤成每行 5 个字）
  && !/--me-extra-left/.test(client)
  && /measureBubbleBox\(originalText\)/.test(client)
  // 按消息文本认气泡，而不是按 DOM 层级猜（层级一变就会量到别的块）
  && /indexOf\(probe\) !== -1/.test(client)
  && /el\.closest\('\.me-editor'\)/.test(client)
  && (client.match(/minWidth:/g) ?? []).length === 1)
check('按钮几何沿用官方 action', /--dsw-radius-sm/.test(client) && /calc\(28px \+ var\(--dsh-content-font-delta/.test(client))
check('按钮排进原生操作行（复制键右侧）', /\[data-clock="start"\]\{padding-right:calc\(72px \+ 2 \* var\(--dsh-content-font-delta/.test(client))
check('编辑/撤回是图标钮', /IconEdit/.test(client) && /IconRetract/.test(client))
check('撤回不是垃圾桶也不是尖括号', !/IconTrash/.test(client) && !/M10 4L6\.70711 7\.29289/.test(client))
check('撤回是掉头箭头（U-turn + 左端箭头）', /M2 6\.5H10A3 3 0 0 1 10 12\.5H6\.4/.test(client) && /M5 3\.5L2 6\.5L5 9\.5/.test(client))
check('编辑态白底 + 蓝描线', /background:var\(--dsw-alias-bg-base,#fff\)/.test(client) && /border:1px solid var\(--dsw-alias-state-business-primary/.test(client))
check('编辑态几何与气泡一致（1px 边框用内边距抵消）', /padding:9px 15px/.test(client))
check('编辑态复用原气泡实测盒子', /measureBubbleBox/.test(client) && /getBoundingClientRect\(\)/.test(client))
check('遮蔽占位节点走官方「上下文」注入行（form=notice + summary）', /form: 'notice', summary: RECALL_NOTICE\[action\]/.test(host) && /const RECALL_NOTICE = \{/.test(host))
check('遮蔽占位节点不被整轮隐藏（它是用户唯一能看到"这里被撤回"的地方）', /data-me-mask/.test(client) && /querySelector\('\[data-context-source\]'\)/.test(client) && /isRecallMask/.test(client))
check('官方条目没进账本时绝不注册遮蔽条（注册了会被让位 → 按钮消失）', /const tryRegisterUser = \(\) =>/.test(client) && /if \(official === undefined\) return false/.test(client) && !/ctx\.slots\.inject\(SLOT, \(\) => register\('user'/.test(client))
check('slots/changed 不得自触发重注册（同轮 dispose+register 会抛 already has an entry）', /registeredSignature/.test(client) && /if \(registration !== null && signatureOf\(official\) === registeredSignature\) return/.test(client) && /window\.setTimeout\(\(\) => \{\n\s+try \{\n\s+tryRegisterUser\(\)/.test(client))
check('注册异常绝不抛回 boot 路径（抛一次会连带 3 个官方 entry 激活失败）', /report\('register', error\)/.test(client) && /report\('slots-changed', error\)/.test(client) && /report\('inject-register', error\)/.test(client))
check('用官方 slots/changed 事件等官方条目（不靠启动顺序、不靠轮询）', /ctx\.on\('slots\/changed'/.test(client) && /ctx\.effect\(\(\) => ctx\.on\('slots\/changed'/.test(client))
check('包装层不改变官方宽度基准（.me-root 必须是块级，不能 flex 收缩）', /me-root\{position:relative;display:block;width:100%/.test(client) && !/me-root\{position:relative;display:flex/.test(client))
check('✓/✕ 不进盒子（盒子高度==气泡高度）', /me-editor-actions\{position:absolute;right:0;top:calc\(100% \+ 4px\)/.test(client))
check('盒子宽度不被 CSS 上限压过实测值', /me-editor\{box-sizing:border-box;max-width:100%/.test(client))
const editingBranch = client.slice(client.indexOf('if (editing) {'), client.indexOf("className: 'me-editor'"))
check('编辑态无缝：官方消息本体照常渲染', editingBranch !== '' && /React\.createElement\(Original, props\)/.test(editingBranch) && /'data-editing': '1'/.test(editingBranch))
check('编辑时收起操作行并撤掉预留 padding（官方操作行也隐藏）', /\[data-editing="1"\] \.me-actions\{display:none\}/.test(client) && /\[data-editing="1"\] \[data-clock="start"\]\{padding-right:0;visibility:hidden\}/.test(client))
check('编辑器覆盖层带上实测几何', /position: 'absolute'/.test(client) && /minHeight: `\$\{editBox\.height\}px`/.test(client))
check('编辑过渡动画：蓝底→白底+蓝环', /@keyframes me-edit-morph/.test(client) && /0%\{background:var\(--dsw-specific-bubble\);border-color:transparent\}/.test(client))
check('退出编辑有反向动画', /@keyframes me-edit-morph-out/.test(client) && /\[data-closing="1"\]\{animation:me-edit-morph-out/.test(client))
check('反向动画播完才卸载编辑器', /const CLOSE_MS = \d+/.test(client) && /setTimeout\(\(\) => \{[\s\S]{0,200}setEditing\(false\)/.test(client))
check('关闭态不可再交互', /\[data-closing="1"\]\{animation:me-edit-morph-out 150ms cubic-bezier\(\.4,0,\.6,1\) both;pointer-events:none\}/.test(client))
check('关闭动画时长与 CLOSE_MS 一致', /const CLOSE_MS = (\d+)/.test(client) && new RegExp(`me-edit-morph-out ${(/const CLOSE_MS = (\d+)/.exec(client) ?? [])[1]}ms`).test(client))
const morphBlock = /@keyframes me-edit-morph\{([\s\S]*?)\n\}/.exec(client)
check('动画不做透明度/缩放（文字不位移）', morphBlock !== null && !/opacity/.test(morphBlock[1]) && !/scale\(/.test(morphBlock[1]))
check('操作行动画用 backwards（不钉死 opacity）', /\.me-actions\{animation:me-edit-fade 140ms ease backwards\}/.test(client))
check('尊重 prefers-reduced-motion', /prefers-reduced-motion:reduce/.test(client))
check('图标是官方路径数据（内联）', /M2\.25 8\.5L5\.49732 11\.7473/.test(client) && /M2\.5 2\.5L13\.5 13\.5/.test(client) && /M7\.7849 8\.23878L13\.888 2\.13574/.test(client))
check('按键行为与官方内联编辑器一致', /event\.shiftKey/.test(client) && /isComposing/.test(client) && /'Escape'/.test(client))
check('编辑框自增高', /scrollHeight \+ node\.offsetHeight - node\.clientHeight/.test(client))
check('prompt 传真的 AbortSignal', /AbortSignal\.timeout\(/.test(host))
check('prompt 失败有日志与回传', /promptError/.test(host) && /prompt 失败/.test(host))
check('state 暴露 recentOps / liveSessions', /recentOps/.test(host) && /liveSessions/.test(host))
check('转发官方 props', /React\.createElement\(Original, props\)/.test(client))
check('样式自带 data-plugin', /setAttribute\('data-plugin'/.test(client))

// 5) 撤回确认弹窗：必须是自绘的 DSH 原生风格，不能用系统框
check('撤回确认走行内气泡（不再 window.confirm / 不用全屏遮罩）', !/window\.confirm\s*\(/.test(client) && /className: 'me-confirm'/.test(client) && !/me-confirm-mask/.test(client))
check('确认气泡挂在消息行内（.me-root 的子元素）', /'data-confirming'/.test(client) && /confirmRef/.test(client) && /React\.createElement\('div', \{\n\s+className: 'me-confirm'/.test(client))
check('不抬整个消息行的层级（否则气泡会浮到输入框上）', !/me-root\[data-confirming="1"\]\{z-index/.test(client))
check('气泡视觉抄官方弹层/菜单取值', /--dsw-menu-surface-fill/.test(client) && /--dsw-radius-lg/.test(client) && /--dsw-elevation-panel/.test(client))
check('气泡按钮抄官方 Button 原子（sm 尺寸）', /--dsw-alias-button-primary-fill/.test(client) && /--dsw-alias-button-primary-hover/.test(client) && /--dsw-alias-interactive-bg-hover/.test(client) && /height:28px;padding:0 10px/.test(client))
check('气泡关闭语义（Enter 确认 / Esc 取消 / 点外面取消）', /event\.key === 'Escape'/.test(client) && /event\.key === 'Enter'/.test(client) && /addEventListener\('mousedown', onDown, true\)/.test(client))
check('气泡被输入框挡住时翻到消息上方', /data-placement/.test(client) && /querySelectorAll\('input, textarea/.test(client) && /me-confirm\[data-placement="above"\]\{top:auto;bottom:calc\(100% \+ 6px\)\}/.test(client))

const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
check('package.json 不再自带 bundle（它是拓展包的成员）', !(pkg.dsh && pkg.dsh.bundle))
check('package.json 声明客户端半边', pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform === 'web')
check('拓展包的 patch 里声明了本包', fs.readFileSync(path.join(dir, '..', 'style-extras', 'cordis.patch.yml'), 'utf8').includes(`name: ${pkg.name}`))

process.stdout.write(notes.join('\n') + '\n')
if (failures.length > 0) {
  console.error('\nFAILURES:\n' + failures.map((line) => '  ✗ ' + line).join('\n'))
  process.exitCode = 1
} else {
  console.log(`\nselfcheck OK（${notes.length} 项）`)
}
