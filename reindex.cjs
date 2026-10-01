'use strict'

// dsh-memory 索引修复：把索引里**同一 target 的重复登记**合并成一条。
//
//   node reindex.cjs [memoryHome] [--dry-run]
//
// 合并规则：位置以**第一次**登记为准（那是人工维护过的分组），行内容以**最后一次**
// 登记为准（后来的写入更新了标题/摘要）。摘空的重复分组会被剪掉，改完顺带重新同步
// <dshHome>/AGENTS.md 的托管区块。记忆库不存在时跳过且退出码 0。
//
// 为什么需要它：2026-10-01 之前的 upsertIndexEntry 只在**本分组内**找同 target，
// overwrite 时漏传 section（回退成 name 首段目录）就会在文件末尾新开一组再追加一行，
// 旧分组里那行原样留着 → INDEX.md 出现两行同 target。写入路径已修（现在按 target
// 全局去重并自愈），本脚本用来把已经写脏的库修回来；`lintmemory.cjs` 会守住这条。

const fs = require('node:fs')
const path = require('node:path')
const store = require('./lib/store')

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const positional = args.filter((a) => !a.startsWith('--'))
const home = path.resolve(
  positional[0] || process.env.DSH_MEMORY_HOME || path.join(store.resolveDshHome(), 'memory')
)

if (!fs.existsSync(home)) {
  console.log(`\n记忆库不存在，无需修复：${home}\n`)
  process.exit(0)
}

console.log(`\n记忆库索引修复${dryRun ? '（dry-run，不写盘）' : ''}：${home}\n`)

const indexFiles = [path.join(home, store.INDEX_FILE)]
const projectsDir = path.join(home, store.PROJECTS_DIR)
if (fs.existsSync(projectsDir)) {
  for (const e of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const p = path.join(projectsDir, e.name, store.PROJECT_INDEX_FILE)
    if (fs.existsSync(p)) indexFiles.push(p)
  }
}

let changedFiles = 0
let mergedEntries = 0
for (const file of indexFiles) {
  const rel = path.relative(home, file).split(path.sep).join('/')
  const before = fs.readFileSync(file, 'utf8')
  const res = store.repairIndex(before)
  if (!res.changed) {
    console.log(`  ok    ${rel}（无重复登记）`)
    continue
  }
  changedFiles++
  mergedEntries += res.duplicates.length
  for (const d of res.duplicates) {
    console.log(`  修复  ${rel} → ${d.target}（${d.sections.join(' / ')}）`)
  }
  if (!dryRun) {
    const tmp = `${file}.tmp-reindex-${process.pid}`
    fs.writeFileSync(tmp, res.text, 'utf8')
    fs.renameSync(tmp, file)
  }
}

if (dryRun) {
  console.log(`\n${changedFiles} 个索引文件有重复登记，共 ${mergedEntries} 处（dry-run，未写盘）。\n`)
  process.exit(0)
}

const memStore = store.createStore({
  home,
  agentsPath: path.join(path.dirname(home), 'AGENTS.md')
})
const sync = memStore.syncAgents(null)
console.log(`\n${changedFiles} 个索引文件被修复，共合并 ${mergedEntries} 处重复登记。`)
console.log(`AGENTS.md 托管区块：${sync.changed ? '已重新同步' : '无需变化'}（${sync.path}）\n`)
