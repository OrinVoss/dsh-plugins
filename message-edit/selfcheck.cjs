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
for (const file of ['host.js', 'client.js', 'package.json', 'cordis.patch.yml', 'README.md']) {
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
check('替换体是空 content 的 system/message', /role:\s*'system'/.test(host) && /content:\s*\[\]/.test(host))
check('替换事件带可识别标记', /MARK\s*=\s*'dsh-recall:'/.test(host) && /id\.startsWith\(MARK\)/.test(host))
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
check('编辑态沿用官方气泡几何', /--dsh-chat-content-width,748px\) \* \.702/.test(client) && /--dsw-specific-bubble/.test(client) && /--dsw-radius-xl/.test(client))
check('按钮几何沿用官方 action', /--dsw-radius-sm/.test(client) && /calc\(28px \+ var\(--dsh-content-font-delta/.test(client))
check('图标是官方路径数据（内联）', /M2\.25 8\.5L5\.49732 11\.7473/.test(client) && /M2\.5 2\.5L13\.5 13\.5/.test(client))
check('按键行为与官方内联编辑器一致', /event\.shiftKey/.test(client) && /isComposing/.test(client) && /'Escape'/.test(client))
check('编辑框自增高', /scrollHeight \+ node\.offsetHeight - node\.clientHeight/.test(client))
check('prompt 传真的 AbortSignal', /AbortSignal\.timeout\(/.test(host))
check('prompt 失败有日志与回传', /promptError/.test(host) && /prompt 失败/.test(host))
check('state 暴露 recentOps / liveSessions', /recentOps/.test(host) && /liveSessions/.test(host))
check('转发官方 props', /React\.createElement\(Original, props\)/.test(client))
check('样式自带 data-plugin', /setAttribute\('data-plugin'/.test(client))

const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
check('package.json 声明 bundle patch', pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch === './cordis.patch.yml')
check('package.json 声明客户端半边', pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform === 'web')
check('patch 里的 id 与包名一致', fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8').includes(`name: ${pkg.name}`))

process.stdout.write(notes.join('\n') + '\n')
if (failures.length > 0) {
  console.error('\nFAILURES:\n' + failures.map((line) => '  ✗ ' + line).join('\n'))
  process.exitCode = 1
} else {
  console.log(`\nselfcheck OK（${notes.length} 项）`)
}
