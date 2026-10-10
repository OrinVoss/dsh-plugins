'use strict'

// dsh-memory 自检：脱离 DSH 直接跑 lib/store.js 的全部文件逻辑。
//   node selfcheck.cjs
// 全部通过退出码 0；任一失败退出码 1。

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')

const storeLib = require('./lib/store')

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-selfcheck-'))
const home = path.join(root, 'memory')
const agents = path.join(root, 'AGENTS.md')
// 假 cwd 用临时目录：注入工作区记忆区块的代码会写 <cwd>/AGENTS.local.md，
// 用真实工作区路径会把测试夹具泄漏到开发者的仓库里（2026-10-09 真漏过一次）。
const cwd = path.join(root, 'workspace')
fs.mkdirSync(cwd, { recursive: true })

console.log(`\n临时目录：${root}\n`)
const store = storeLib.createStore({ home, agentsPath: agents, maxBlockBytes: 20000 })

// ---------------------------------------------------------------- 基础

check('初始索引为空', () => {
  const idx = store.listIndex('global')
  assert.equal(idx.exists, false)
  assert.deepEqual(idx.entries, [])
})

check('slugify 归一化', () => {
  assert.equal(storeLib.slugify('Git Local Commit Only'), 'git-local-commit-only')
  assert.equal(storeLib.slugify('preferences/git-local-commit-only'), 'preferences/git-local-commit-only')
  assert.equal(storeLib.slugify('Web: CSS/竖排!'), 'web-css/竖排')
  assert.equal(storeLib.slugify('tools/dsh-desktop-app.md'), 'tools/dsh-desktop-app')
  assert.equal(storeLib.slugify('  A   B  '), 'a-b')
  assert.throws(() => storeLib.slugify('  '))
  assert.throws(() => storeLib.slugify('../etc/passwd'), /不是合法路径/)
})

check('projectKey 稳定且形如 Z code', () => {
  const k = storeLib.projectKey(cwd)
  assert.match(k, /^[a-z0-9\u4e00-\u9fa5._-]+-[0-9a-f]{16}$/)
  assert.equal(k, storeLib.projectKey(cwd + '\\'))
  assert.notEqual(k, storeLib.projectKey('D:\\other\\project'))
})

check('parseIndex 把折行续行并回摘要', () => {
  const text = [
    '# 索引',
    '',
    '## 本机与网络',
    '',
    '- [env](machine-env-and-network.md) — **权威版**：代理 `127.0.0.1:10808`、各包管理器',
    '  （git/cargo/npm/rustup）的代理陷阱、Python/ffmpeg 等路径',
    '- [bsod](hardware/honor-laptop-nvidia-bsod.md) — 荣耀笔记本蓝屏',
    '',
    '> 尾注不属于任何条目',
    ''
  ].join('\n')
  const parsed = storeLib.parseIndex(text)
  assert.equal(parsed.sections.length, 1)
  const entries = parsed.sections[0].entries
  assert.equal(entries.length, 2)
  assert.match(entries[0].summary, /权威版/)
  assert.match(entries[0].summary, /代理陷阱/, '续行应并入上一条摘要')
  assert.doesNotMatch(entries[0].summary, /尾注/)
  assert.equal(entries[1].summary, '荣耀笔记本蓝屏', '续行不应污染下一条')
})

check('upsert 替换折行条目时不留孤行', () => {
  const text = [
    '## 工具配置',
    '',
    '- [kimi](tools/kimi-resources.md) — 第一行摘要',
    '  第二行续写',
    '  第三行续写',
    '- [other](tools/other.md) — 别的',
    ''
  ].join('\n')
  const next = storeLib.upsertIndexEntry(text, '工具配置', {
    title: 'kimi',
    target: 'tools/kimi-resources.md',
    summary: '新摘要'
  })
  assert.equal(next.split('\n').filter((l) => l.includes('kimi-resources.md')).length, 1)
  assert.doesNotMatch(next, /第二行续写/)
  assert.doesNotMatch(next, /第三行续写/)
  assert.match(next, /tools\/other\.md/, '同 section 的其它条目应保留')
  assert.match(next, /新摘要/)
})

check('removeIndexEntry 连带删掉折行续行', () => {
  const text = [
    '## 工具配置',
    '',
    '- [kimi](tools/kimi-resources.md) — 第一行',
    '  续行内容',
    '- [other](tools/other.md) — 别的',
    ''
  ].join('\n')
  const res = storeLib.removeIndexEntry(text, 'tools/kimi-resources.md')
  assert.equal(res.removed, true)
  assert.doesNotMatch(res.text, /续行内容/)
  assert.match(res.text, /tools\/other\.md/)
})

check('upsert 新增条目时不会插进上一条的折行续行里', () => {
  const text = [
    '## 工具配置',
    '',
    '- [old](tools/old.md) — 第一行摘要',
    '  续行甲',
    '  续行乙',
    ''
  ].join('\n')
  const next = storeLib.upsertIndexEntry(text, '工具配置', {
    title: '新条目',
    target: 'tools/new.md',
    summary: '新摘要'
  })
  const lines = next.split('\n')
  const oldLine = lines.findIndex((l) => l.includes('tools/old.md'))
  const newLine = lines.findIndex((l) => l.includes('tools/new.md'))
  assert.equal(newLine, oldLine + 3, `新条目应排在上一条的续行之后，实际 old=${oldLine} new=${newLine}\n${next}`)
  assert.match(lines[oldLine + 1], /续行甲/)
  assert.match(lines[oldLine + 2], /续行乙/)
  // 解析回来时两条摘要都应完整
  const entries = storeLib.parseIndex(next).sections[0].entries
  assert.equal(entries.length, 2)
  assert.equal(entries[0].summary, '第一行摘要 续行甲 续行乙')
  assert.equal(entries[1].summary, '新摘要')
})

// ---------------------------------------------------------------- 写入

check('写入全局条目 → 文件 + frontmatter + 索引', () => {
  const res = store.write('global', {
    name: 'preferences/git-local-commit-only',
    title: 'Git 只做本地提交',
    description: '只要本地 commit、不推送；每次更改都要提交',
    type: 'feedback',
    section: '用户偏好与协作约定',
    body: '事实：用户要求只 commit 不 push。\n\n**Why:** 远端与本地分叉。\n\n**How to apply:** 见 [[dsh-desktop-app]]。',
    sessionId: 'sess_test_1'
  }, cwd)
  assert.equal(res.ok, true)
  assert.equal(res.updated, false)
  assert.equal(res.target, 'preferences/git-local-commit-only.md')

  const raw = fs.readFileSync(path.join(home, 'preferences', 'git-local-commit-only.md'), 'utf8')
  assert.match(raw, /^---\nname: preferences\/git-local-commit-only\n/)
  assert.match(raw, /description: 只要本地 commit、不推送；每次更改都要提交/)
  assert.match(raw, /node_type: memory/)
  assert.match(raw, /type: feedback/)
  assert.match(raw, /scope: global/)
  assert.match(raw, /originSessionId: sess_test_1/)
  assert.match(raw, /\*\*How to apply:\*\*/)

  const idx = fs.readFileSync(path.join(home, 'INDEX.md'), 'utf8')
  assert.match(idx, /## 用户偏好与协作约定/)
  assert.match(idx, /- \[Git 只做本地提交\]\(preferences\/git-local-commit-only\.md\) — 只要本地 commit、不推送；每次更改都要提交/)
})

check('同 section 第二条追加在既有条目之后', () => {
  store.write('global', {
    name: 'preferences/keep-readmes-in-sync',
    title: '交付时同步 README',
    description: '新功能与设计变更要同步更新 README',
    section: '用户偏好与协作约定',
    body: '正文'
  }, cwd)
  const idx = fs.readFileSync(path.join(home, 'INDEX.md'), 'utf8')
  const first = idx.indexOf('git-local-commit-only.md')
  const second = idx.indexOf('keep-readmes-in-sync.md')
  assert.ok(first !== -1 && second > first, '第二条应排在第一条之后')
  assert.equal(idx.split('## 用户偏好与协作约定').length - 1, 1, 'section 标题不应重复')
})

check('新 section 会追加到文件末尾', () => {
  store.write('global', {
    name: 'tools/kimi-resources',
    title: 'Kimi 资源',
    description: '需要真实登录态的网页任务走 kimi-webbridge',
    section: '工具配置',
    body: '正文'
  }, cwd)
  const idx = fs.readFileSync(path.join(home, 'INDEX.md'), 'utf8')
  assert.match(idx, /## 工具配置\n- \[Kimi 资源\]/)
  assert.ok(idx.indexOf('## 工具配置') > idx.indexOf('## 用户偏好与协作约定'))
})

check('已存在且未带 overwrite → 拒绝，不覆盖', () => {
  const res = store.write('global', {
    name: 'tools/kimi-resources',
    description: '重复写',
    body: '不该覆盖'
  }, cwd)
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'exists')
  assert.match(res.message, /overwrite: true/)
  const raw = fs.readFileSync(path.join(home, 'tools', 'kimi-resources.md'), 'utf8')
  assert.match(raw, /kimi-webbridge/)
  assert.doesNotMatch(raw, /不该覆盖/)
})

check('overwrite: true 更新正文且保留 createdAt', () => {
  const before = storeLib.parseEntry(fs.readFileSync(path.join(home, 'tools', 'kimi-resources.md'), 'utf8')).meta
  const res = store.write('global', {
    name: 'tools/kimi-resources',
    title: 'Kimi 资源（更新）',
    description: '更新后的摘要',
    section: '工具配置',
    body: '更新后的正文',
    overwrite: true
  }, cwd)
  assert.equal(res.ok, true)
  assert.equal(res.updated, true)
  const after = storeLib.parseEntry(fs.readFileSync(path.join(home, 'tools', 'kimi-resources.md'), 'utf8')).meta
  assert.equal(after.createdAt, before.createdAt)
  const idx = fs.readFileSync(path.join(home, 'INDEX.md'), 'utf8')
  assert.match(idx, /Kimi 资源（更新）/)
  assert.equal(idx.split('kimi-resources.md').length - 1, 1, '索引里不应出现两条同目标条目')
})

check('空 body / 空 description 被拒绝', () => {
  assert.equal(store.write('global', { name: 'x/y', description: 'd', body: '   ' }, cwd).reason, 'empty-body')
  assert.equal(store.write('global', { name: 'x/z', description: '', body: 'b' }, cwd).reason, 'no-description')
})

// ------------------------------------------------- 索引重复登记回归（2026-10-01）

check('索引去重：overwrite 漏传 section → 沿用原分组，不追加重复登记', () => {
  const s = storeLib.createStore({
    home: path.join(root, 'bug4a'),
    agentsPath: path.join(root, 'bug4a-AGENTS.md')
  })
  s.write('global', {
    name: 'preferences/skill-strict-execution',
    title: '严格执行 skill',
    description: '走完该 skill 文档化的全流程',
    section: '用户偏好与协作约定',
    body: '原正文'
  }, cwd)
  const res = s.write('global', {
    name: 'preferences/skill-strict-execution',
    title: '严格执行 skill = 走完 SKILL.md 与 references 全流程',
    description: '开工前先读完配套文件',
    overwrite: true,
    body: '原正文\n\n补强章节'
  }, cwd)
  assert.equal(res.ok, true)
  assert.equal(res.section, '用户偏好与协作约定', '漏传 section 时应沿用索引里现有的分组（而不是 name 首段 preferences）')
  const idxText = fs.readFileSync(path.join(root, 'bug4a', 'INDEX.md'), 'utf8')
  assert.equal(idxText.split('preferences/skill-strict-execution.md').length - 1, 1, `索引里只应有一行：\n${idxText}`)
  assert.match(idxText, /严格执行 skill = 走完 SKILL\.md/)
  assert.doesNotMatch(idxText, /## preferences/, '不应新建 preferences 分组')
  assert.ok(idxText.endsWith('\n') && !idxText.endsWith('\n\n'), '索引应以单个换行结尾')
  // 再覆盖一次：行数、结尾都不应变化（幂等）
  s.write('global', {
    name: 'preferences/skill-strict-execution',
    title: '严格执行 skill = 走完 SKILL.md 与 references 全流程',
    description: '开工前先读完配套文件',
    overwrite: true,
    body: '原正文\n\n补强章节'
  }, cwd)
  const again = fs.readFileSync(path.join(root, 'bug4a', 'INDEX.md'), 'utf8')
  assert.equal(again, idxText, '同内容重复覆盖应完全幂等')
})

check('索引去重：显式指定别的分组 → 条目搬家，搬空的旧分组被剪掉', () => {
  const s = storeLib.createStore({
    home: path.join(root, 'bug4b'),
    agentsPath: path.join(root, 'bug4b-AGENTS.md')
  })
  s.write('global', { name: 'tools/x', title: 'X', description: 'd1', section: '工具配置', body: 'b1' }, cwd)
  const res = s.write('global', {
    name: 'tools/x',
    title: 'X',
    description: 'd2',
    section: '新分组',
    body: 'b2',
    overwrite: true
  }, cwd)
  assert.equal(res.section, '新分组')
  const idxText = fs.readFileSync(path.join(root, 'bug4b', 'INDEX.md'), 'utf8')
  assert.equal(idxText.split('tools/x.md').length - 1, 1, `搬家后只应有一行：\n${idxText}`)
  assert.match(idxText, /## 新分组\n- \[X\]\(tools\/x\.md\) — d2/)
  assert.doesNotMatch(idxText, /## 工具配置/, '被搬空的旧分组标题应剪掉')
})

check('索引去重：upsert 顺手清掉同 target 的重复登记（自愈）', () => {
  const text = [
    '# 索引',
    '',
    '## 用户偏好与协作约定',
    '- [旧标题](preferences/a.md) — 旧摘要',
    '',
    '## preferences',
    '- [新标题](preferences/a.md) — 新摘要',
    ''
  ].join('\n')
  const next = storeLib.upsertIndexEntry(text, 'preferences', {
    title: '最新标题',
    target: 'preferences/a.md',
    summary: '最新摘要'
  })
  assert.equal(next.split('preferences/a.md').length - 1, 1, `重复登记应被清掉：\n${next}`)
  assert.match(next, /- \[最新标题\]\(preferences\/a\.md\) — 最新摘要/)
  assert.equal(storeLib.parseIndex(next).sections.length, 1, '被掏空的重复分组应剪掉')
})

check('索引去重：repairIndex 位置取首次登记、内容取末次登记（含折行续行）', () => {
  const text = [
    '# 索引',
    '',
    '## 交付物制作技巧',
    '- [旧标题](workflows/music.md) — 旧摘要第一行',
    '  旧摘要续行（合并后不该留下）',
    '',
    '## 工具配置',
    '- [别的](tools/other.md) — 别的摘要',
    '',
    '## workflows',
    '- [新标题](workflows/music.md) — 新摘要',
    ''
  ].join('\n')
  const res = storeLib.repairIndex(text)
  assert.equal(res.changed, true)
  assert.deepEqual(res.duplicates, [{ target: 'workflows/music.md', sections: ['交付物制作技巧', 'workflows'] }])
  assert.doesNotMatch(res.text, /旧摘要续行/, '首次登记的折行续行应一起删掉')
  assert.doesNotMatch(res.text, /旧摘要第一行/)
  const parsed = storeLib.parseIndex(res.text)
  assert.deepEqual(parsed.sections.map((s) => s.title), ['交付物制作技巧', '工具配置'], '位置以首次登记为准，空掉的 workflows 分组被剪掉')
  assert.equal(parsed.sections[0].entries.length, 1)
  assert.equal(parsed.sections[0].entries[0].title, '新标题')
  assert.equal(parsed.sections[0].entries[0].summary, '新摘要')
  assert.match(res.text, /tools\/other\.md/)
  // 没有重复时不动原文
  const clean = storeLib.repairIndex(res.text)
  assert.equal(clean.changed, false)
  assert.equal(clean.text, res.text)
})

// ---------------------------------------------------------------- 项目作用域

check('项目作用域落到 projects/<key>/ 且索引文件是 MEMORY.md', () => {
  const res = store.write('project', {
    name: 'decisions/api-gateway',
    title: '网关选型',
    description: '本项目用 httpx 而不是 requests',
    type: 'project',
    body: '正文'
  }, cwd)
  assert.equal(res.ok, true)
  const key = storeLib.projectKey(cwd)
  assert.equal(res.target, 'decisions/api-gateway.md')
  assert.ok(fs.existsSync(path.join(home, 'projects', key, 'MEMORY.md')))
  assert.ok(fs.existsSync(path.join(home, 'projects', key, 'decisions', 'api-gateway.md')))
})

check('无 cwd 时项目作用域明确报错', () => {
  assert.throws(() => store.write('project', { name: 'a', description: 'd', body: 'b' }, null), /工作目录/)
})

// ---------------------------------------------------------------- 读取与检索

check('memory_read 按名字精确读取', () => {
  const res = store.read('global', 'tools/kimi-resources', cwd)
  assert.equal(res.found, true)
  assert.equal(res.meta.type, 'reference')
  assert.match(res.body, /更新后的正文/)
})

check('memory_read 名字允许省略 .md', () => {
  const a = store.read('global', 'tools/kimi-resources', cwd)
  const b = store.read('global', 'tools/kimi-resources.md', cwd)
  assert.equal(a.found, true)
  assert.equal(b.found, true)
  assert.equal(a.target, b.target)
})

check('检索命中标题', () => {
  const res = store.search('global', 'README', cwd, 5)
  assert.ok(res.total >= 1)
  assert.match(res.results[0].body, /正文/)
})

check('检索命中正文全文（索引摘要里没有的词）', () => {
  const res = store.search('global', '更新后的正文', cwd, 5)
  assert.ok(res.results.some((r) => r.target === 'tools/kimi-resources.md'), JSON.stringify(res.results.map((r) => r.target)))
})

check('检索中文子串命中', () => {
  const res = store.search('global', '推送', cwd, 5)
  assert.ok(res.results.some((r) => r.target === 'preferences/git-local-commit-only.md'))
})

check('空 query 返回索引概览', () => {
  const res = store.search('global', '', cwd, 3)
  assert.ok(res.total >= 3, `total=${res.total}`)
  assert.equal(res.results.length, 3, 'limit 应生效')
})

// ---------------------------------------------------------------- AGENTS.md

check('首次同步创建 AGENTS.md 与托管区块', () => {
  const res = store.syncAgents(cwd)
  assert.equal(res.changed, true)
  const text = fs.readFileSync(agents, 'utf8')
  assert.match(text, /^# 全局指令/)
  assert.ok(text.includes(storeLib.BLOCK_BEGIN))
  assert.ok(text.includes(storeLib.BLOCK_END))
  assert.match(text, /### 全局记忆索引/)
  assert.match(text, /Git 只做本地提交/)
  assert.match(text, /memory_write/)
})

check('重复同步幂等（内容不变则不改文件）', () => {
  const before = fs.readFileSync(agents, 'utf8')
  const res = store.syncAgents(cwd)
  assert.equal(res.changed, false)
  assert.equal(fs.readFileSync(agents, 'utf8'), before)
})

check('项目作用域可以直接按项目键寻址（设置页走这条）', () => {
  const key = storeLib.projectKey(cwd)
  const res = store.read('project', 'decisions/api-gateway', key)
  assert.equal(res.found, true)
  const list = store.listIndex('project', key)
  assert.equal(list.key, key)
  assert.ok(list.entries.some((e) => e.target === 'decisions/api-gateway.md'))
  // 不存在的键只是空库，不报错
  const empty = store.listIndex('project', 'nothing-0000000000000000')
  assert.equal(empty.entries.length, 0)
})

check('listProjects 列出项目库与条目数', () => {
  const list = store.listProjects()
  assert.equal(list.length, 1)
  assert.equal(list[0].key, storeLib.projectKey(cwd))
  assert.ok(list[0].entries >= 1)
  assert.ok(list[0].updatedAt)
})

check('status 汇总记忆库状态（设置页顶部用）', () => {
  const s = store.status(cwd)
  assert.equal(s.home, home)
  assert.equal(s.agentsPath, agents)
  assert.equal(s.maxBlockBytes, 20000)
  assert.equal(s.global.count, 3)
  assert.ok(s.global.bytes > 0)
  assert.ok(s.project && s.project.key === storeLib.projectKey(cwd))
  assert.equal(s.projects, 1)
  assert.ok(s.blockBytes > 0, 'AGENTS.md 里的托管区块应被计入')
})

check('保留用户自己写在区块外的内容', () => {
  const before = fs.readFileSync(agents, 'utf8')
  const custom = `${before}\n## 我自己的硬规则\n\n- 回复用简体中文。\n`
  fs.writeFileSync(agents, custom, 'utf8')
  store.write('global', {
    name: 'machine/proxy',
    title: '代理',
    description: '代理在 127.0.0.1:10808',
    section: '本机与网络',
    body: '正文'
  }, cwd)
  store.syncAgents(cwd)
  const after = fs.readFileSync(agents, 'utf8')
  assert.match(after, /## 我自己的硬规则/)
  assert.match(after, /- 回复用简体中文。/)
  assert.match(after, /代理在 127\.0\.0\.1:10808/, '新记忆应已同步进区块')
  assert.equal(after.split(storeLib.BLOCK_BEGIN).length - 1, 1, '托管区块只能有一个')
  assert.equal(after.split(storeLib.BLOCK_END).length - 1, 1)
})

check('用户提前写好别的 AGENTS.md 时，区块追加而不是覆盖', () => {
  const other = path.join(root, 'AGENTS2.md')
  fs.writeFileSync(other, '# 我的全局指令\n\n- 只说中文。\n', 'utf8')
  const s2 = storeLib.createStore({ home, agentsPath: other })
  const res = s2.syncAgents(cwd)
  assert.equal(res.changed, true)
  const text = fs.readFileSync(other, 'utf8')
  assert.match(text, /^# 我的全局指令\n\n- 只说中文。\n\n<!-- dsh-memory:begin -->/)
  // 再同步一次不应改动
  assert.equal(s2.syncAgents(cwd).changed, false)
})

check('索引超预算时区块被截断且给出提示', () => {
  const bigHome = path.join(root, 'memory-big')
  const big = storeLib.createStore({ home: bigHome, agentsPath: path.join(root, 'AGENTS3.md') })
  for (let i = 0; i < 40; i++) {
    big.write('global', {
      name: `bulk/entry-${i}`,
      title: `条目 ${i}`,
      description: `这是第 ${i} 条用于把索引撑爆的长摘要——`.repeat(3),
      section: '压测',
      body: '正文'
    }, cwd)
  }
  const tiny = storeLib.createStore({
    home: bigHome,
    agentsPath: path.join(root, 'AGENTS4.md'),
    maxBlockBytes: 1200
  })
  const res = tiny.syncAgents(cwd)
  const text = fs.readFileSync(res.path, 'utf8')
  assert.ok(text.includes(storeLib.BLOCK_BEGIN) && text.includes(storeLib.BLOCK_END))
  assert.match(text, /索引超预算/)
  assert.match(text, /完整内容见/)
  assert.ok(text.length < 1200 + 1200, `区块应被限制，实际 ${text.length} 字符`)
  // 完整索引仍在磁盘上
  assert.ok(fs.readFileSync(path.join(bigHome, 'INDEX.md'), 'utf8').includes('entry-39'))
})

// ------------------------------------------------- 回归：BUG-2 检索切词 / BUG-3 空分组

check('tokenize 切词：多词、标点、中英混排、版本号不被切碎', () => {
  const t = storeLib.tokenize
  assert.deepEqual(t('CUDA 蓝屏'), ['cuda', '蓝屏'])
  assert.deepEqual(t('CUDA，蓝屏；Blackwell'), ['cuda', '蓝屏', 'blackwell'])
  assert.deepEqual(t('CUDA蓝屏'), ['cuda', '蓝屏'], '无空格的中英混排应按字符类边界切开')
  assert.deepEqual(t('CUDA 13.4'), ['cuda', '13.4'], '句点不应把版本号切碎')
  assert.deepEqual(t('lib/store.js'), ['lib', 'store.js'])
  assert.deepEqual(t('done. Next'), ['done', 'next'], '句末句点应被修掉')
  assert.deepEqual(t('   '), [])
  assert.deepEqual(t('dsh-desktop-app'), ['dsh', 'desktop', 'app'], '连字符是分隔符')
  assert.deepEqual(t('蓝屏'), ['蓝屏'], '两字中文是一个词，且不做 bigram 展开')
})

check('BUG-2 多词查询不再假阴性（各词分散在不同条目里）', () => {
  const s = storeLib.createStore({
    home: path.join(root, 'memory-multi'),
    agentsPath: path.join(root, 'AGENTS-multi.md')
  })
  s.write('global', { name: 'a/cuda', title: 'CUDA 构建', description: '必须用 CUDA 13.4 构建', section: '压测', body: '正文甲' }, cwd)
  s.write('global', { name: 'b/bsod', title: '蓝屏', description: '荣耀笔记本 5 次蓝屏', section: '压测', body: '正文乙' }, cwd)

  const spread = s.search('global', 'CUDA 蓝屏', cwd, 5)
  const targets = spread.results.map((r) => r.target)
  assert.ok(targets.includes('a/cuda.md'), `应命中 CUDA 条目：${JSON.stringify(targets)}`)
  assert.ok(targets.includes('b/bsod.md'), `应命中 蓝屏 条目：${JSON.stringify(targets)}`)
  assert.deepEqual(spread.terms, ['cuda', '蓝屏'])

  // 整串命中仍然排最前
  const exact = s.search('global', 'CUDA 13.4', cwd, 5)
  assert.equal(exact.results[0].target, 'a/cuda.md')

  // 单字中文也算命中（原先整串匹配时同样能中）
  assert.ok(s.search('global', '蓝屏', cwd, 5).results.some((r) => r.target === 'b/bsod.md'))

  // 不相关/乱码查询必须零命中——刻意不做 bigram 兜底，就是为了守住这条
  assert.equal(s.search('global', 'zzz-不存在的词', cwd, 5).total, 0)
  assert.equal(
    s.search('global', '不存在的关键词xyzzy', cwd, 5).total,
    0,
    '乱码查询不该命中（去掉 bigram 兜底的原因）'
  )
  // 已知限制：无空格的多词中文不切分，用空格即可（见 README §10）
  assert.equal(s.search('global', '笔记本蓝屏', cwd, 5).total, 0, '单串中文不做二次切分')
  assert.ok(s.search('global', '笔记本 蓝屏', cwd, 5).results.some((r) => r.target === 'b/bsod.md'))
})

check('BUG-3 删掉某组最后一条后，空分组标题被剪掉', () => {
  const ixFile = path.join(root, 'memory-multi', 'INDEX.md')
  const before = fs.readFileSync(ixFile, 'utf8')
  assert.match(before, /^## 压测$/m)
  const res = storeLib.removeIndexEntry(before, 'a/cuda.md')
  assert.equal(res.removed, true)
  assert.deepEqual(res.pruned, [], '同组还有 b/bsod，此时不该剪任何分组')
  assert.match(res.text, /^## 压测$/m, '同组还有 b/bsod，分组不该被剪')
  const res2 = storeLib.removeIndexEntry(res.text, 'b/bsod.md')
  assert.deepEqual(res2.pruned, ['压测'])
  assert.doesNotMatch(res2.text, /^## 压测$/m, '该组已空，标题应被剪掉')
  assert.match(res2.text, /^# /m, '文件头不应被动')
  assert.ok(res2.text.endsWith('\n'), '结尾应保持一个换行')
})

check('BUG-3 forget 报告被剪掉的分组', () => {
  const s = storeLib.createStore({
    home: path.join(root, 'memory-prune'),
    agentsPath: path.join(root, 'AGENTS-prune.md')
  })
  s.write('global', { name: 'tmp/only', title: '独苗', description: '占一个分组', section: '一次性', body: '正文' }, cwd)
  s.write('global', { name: 'keep/me', title: '留下的', description: '另一个分组', section: '常驻', body: '正文' }, cwd)
  const res = s.forget('global', 'tmp/only', cwd)
  assert.deepEqual(res.pruned, ['一次性'])
  const text = fs.readFileSync(path.join(root, 'memory-prune', 'INDEX.md'), 'utf8')
  assert.doesNotMatch(text, /^## 一次性$/m)
  assert.match(text, /^## 常驻$/m)
  assert.doesNotMatch(text, /\n{3,}/, '不应留下多余空行')
})

check('pruneEmptySections 只剪空组，不碰文件头与有内容的组', () => {
  const text = [
    '# 索引标题',
    '',
    '## 有内容',
    '',
    '- [a](a.md) — 摘要',
    '',
    '## 空的',
    '',
    '## 也有内容',
    '',
    '- [b](b.md) — 摘要',
    ''
  ].join('\n')
  const out = storeLib.pruneEmptySections(text)
  assert.match(out, /^# 索引标题$/m)
  assert.match(out, /^## 有内容$/m)
  assert.match(out, /^## 也有内容$/m)
  assert.doesNotMatch(out, /## 空的/)
  assert.match(out, /- \[a\]\(a\.md\)/)
  assert.match(out, /- \[b\]\(b\.md\)/)
})

// ---------------------------------------------------------------- 删除

check('forget 删除文件 + 摘掉索引条目', () => {
  const res = store.forget('global', 'tools/kimi-resources', cwd)
  assert.equal(res.removed, true)
  assert.equal(res.deindexed, true)
  assert.equal(fs.existsSync(path.join(home, 'tools', 'kimi-resources.md')), false)
  const idx = fs.readFileSync(path.join(home, 'INDEX.md'), 'utf8')
  assert.doesNotMatch(idx, /kimi-resources\.md/)
  assert.match(idx, /git-local-commit-only\.md/, '其它条目应保留')
})

check('forget 清理空目录', () => {
  assert.equal(fs.existsSync(path.join(home, 'tools')), false, 'tools/ 应被清掉')
})

check('删除不存在的条目不报错', () => {
  const res = store.forget('global', 'nope/none', cwd)
  assert.equal(res.removed, false)
  assert.equal(res.deindexed, false)
})

check('forget 后同步仍幂等', () => {
  store.syncAgents(cwd)
  assert.equal(store.syncAgents(cwd).changed, false)
})

// ---------------------------------------------------------------- CRLF

check('parseEntry 兼容 CRLF：frontmatter 最后一行元数据不丢', () => {
  const text = [
    '---',
    'name: crlf-entry',
    'description: 说明',
    'metadata:',
    '  node_type: memory',
    '  type: reference',
    '  scope: global',
    '  updatedAt: 2026-10-01T00:00:00.000Z',
    '---',
    '',
    '正文',
    ''
  ].join('\r\n')
  const { meta, body } = storeLib.parseEntry(text)
  assert.equal(meta.scope, 'global', 'CRLF 下最后几行 scope 仍应解析')
  assert.equal(meta.updatedAt, '2026-10-01T00:00:00.000Z', 'CRLF 下 updatedAt 不应丢')
  assert.equal(body, '正文')
})

// ---------------------------------------------------------------- 工作区记忆注入

check('buildProjectBlock 渲染托管区块与条目', () => {
  const block = store.buildProjectBlock(cwd)
  assert.match(block, /<!-- dsh-memory-project:begin -->/)
  assert.match(block, /<!-- dsh-memory-project:end -->/)
  assert.match(block, /### 工作区记忆索引/)
  assert.match(block, /decisions\/api-gateway\.md/)
  assert.match(block, /网关选型/)
})

check('buildProjectBlock 空索引给出可读占位', () => {
  const c = path.join(root, 'ws-empty')
  fs.mkdirSync(c, { recursive: true })
  const block = store.buildProjectBlock(c)
  assert.match(block, /还没有记忆条目/)
})

check('buildProjectBlock 超预算时截断并提示', () => {
  const tinyHome = path.join(root, 'tiny-memory')
  const tinyCwd = path.join(root, 'ws-tiny')
  fs.mkdirSync(tinyCwd, { recursive: true })
  const tiny = storeLib.createStore({ home: tinyHome, agentsPath: path.join(root, 'tiny-AGENTS.md'), maxProjectBlockBytes: 700 })
  for (let i = 0; i < 8; i++) {
    tiny.write('project', { name: `x/e${i}`, title: `条目${i}`, description: '描述'.repeat(20), body: 'b' }, tinyCwd)
  }
  const block = tiny.buildProjectBlock(tinyCwd)
  assert.match(block, /索引超预算，此处省略/)
})

check('syncWorkspaceAgents 无项目条目时不建文件', () => {
  const c = path.join(root, 'ws-none')
  fs.mkdirSync(c, { recursive: true })
  const res = store.syncWorkspaceAgents(c)
  assert.equal(res.changed, false)
  assert.equal(res.reason, 'no-project-index')
  assert.ok(!fs.existsSync(path.join(c, 'AGENTS.local.md')))
})

check('syncWorkspaceAgents 有项目条目时写入工作区文件', () => {
  const res = store.syncWorkspaceAgents(cwd)
  assert.equal(res.changed, true)
  const file = path.join(cwd, 'AGENTS.local.md')
  assert.equal(res.path, file)
  const text = fs.readFileSync(file, 'utf8')
  assert.match(text, /decisions\/api-gateway\.md/)
})

check('syncWorkspaceAgents 幂等：内容不变时不动文件', () => {
  const res = store.syncWorkspaceAgents(cwd)
  assert.equal(res.changed, false)
})

check('syncWorkspaceAgents 不碰托管区块外的用户内容', () => {
  const c = path.join(root, 'ws-user')
  fs.mkdirSync(c, { recursive: true })
  const file = path.join(c, 'AGENTS.local.md')
  fs.writeFileSync(file, '# 我自己的说明\n\n别动这一段。\n', 'utf8')
  store.write('project', { name: 'notes/a', title: 'A', description: 'd', body: 'b' }, c)
  const res = store.syncWorkspaceAgents(c)
  assert.equal(res.changed, true)
  const text = fs.readFileSync(file, 'utf8')
  assert.match(text, /# 我自己的说明/)
  assert.match(text, /别动这一段。/)
  assert.match(text, /notes\/a\.md/)
})

check('syncWorkspaceAgents 条目清空后摘区块并删空文件', () => {
  const c = path.join(root, 'ws-clear')
  fs.mkdirSync(c, { recursive: true })
  store.write('project', { name: 'gone/x', title: 'X', description: 'd', body: 'b' }, c)
  assert.equal(store.syncWorkspaceAgents(c).changed, true)
  const file = path.join(c, 'AGENTS.local.md')
  assert.ok(fs.existsSync(file))
  store.forget('project', 'gone/x', c)
  const res = store.syncWorkspaceAgents(c)
  assert.equal(res.removed, true)
  assert.ok(!fs.existsSync(file))
})

check('syncWorkspaceAgents 拒绝记忆根内部与相对路径', () => {
  assert.equal(store.syncWorkspaceAgents(home).reason, 'inside-memory-home')
  assert.equal(store.syncWorkspaceAgents('relative/path').reason, 'no-cwd')
  assert.equal(store.syncWorkspaceAgents(null).reason, 'no-cwd')
})

check('injectProjectBlock:false 时完全不写工作区', () => {
  const c = path.join(root, 'ws-off')
  fs.mkdirSync(c, { recursive: true })
  const off = storeLib.createStore({ home, agentsPath: agents, injectProjectBlock: false })
  off.write('project', { name: 'off/y', title: 'Y', description: 'd', body: 'b' }, c)
  assert.equal(off.syncWorkspaceAgents(c).reason, 'disabled')
  assert.ok(!fs.existsSync(path.join(c, 'AGENTS.local.md')))
})

// ---------------------------------------------------------------- 结果

fs.rmSync(root, { recursive: true, force: true })

console.log(`\n${passed} 项通过，${failures.length} 项失败。\n`)
if (failures.length) {
  for (const f of failures) console.log(`FAILED: ${f.label}\n${(f.err && f.err.stack) || ''}\n`)
  process.exit(1)
}
