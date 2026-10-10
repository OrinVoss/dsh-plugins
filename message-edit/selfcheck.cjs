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
check('编辑态沿用官方气泡几何', /--dsw-radius-xl/.test(client) && /padding:9px 15px/.test(client) && /--dsh-content-font-size,14px/.test(client))
check('按钮几何沿用官方 action', /--dsw-radius-sm/.test(client) && /calc\(28px \+ var\(--dsh-content-font-delta/.test(client))
check('按钮排进原生操作行（复制键右侧）', /\[data-clock="start"\]\{padding-right:calc\(72px \+ 2 \* var\(--dsh-content-font-delta/.test(client))
check('编辑/撤回是图标钮', /IconEdit/.test(client) && /IconRetract/.test(client))
check('撤回不是垃圾桶也不是尖括号', !/IconTrash/.test(client) && !/M10 4L6\.70711 7\.29289/.test(client))
check('撤回是掉头箭头（U-turn + 左端箭头）', /M2 6\.5H10A3 3 0 0 1 10 12\.5H6\.4/.test(client) && /M5 3\.5L2 6\.5L5 9\.5/.test(client))
check('编辑态白底 + 蓝描线', /background:var\(--dsw-alias-bg-base,#fff\)/.test(client) && /border:1px solid var\(--dsw-alias-state-business-primary/.test(client))
check('编辑态几何与气泡一致（1px 边框用内边距抵消）', /padding:9px 15px/.test(client))
check('编辑态复用原气泡实测盒子', /measureBubbleBox/.test(client) && /getBoundingClientRect\(\)/.test(client))
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
