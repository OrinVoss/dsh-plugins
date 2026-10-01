'use strict'

// 把已有的 Markdown 记忆库（例如 Z code 的 global-memory）导入 dsh-memory 的记忆根。
// 两边的目录结构与 index 格式本来就一致，所以这是「保结构复制」而不是翻译。
//
//   node import.cjs --from "C:\Users\17040\.zcode\global-memory" --to "<DSH_HOME>\memory"
//   node import.cjs --from ... --to ... --dry-run     只报告，不写盘
//   node import.cjs --from ... --to ... --force       覆盖已存在的同名条目
//
// 结束后会用 lib/store.js 重建/校验索引。

const fs = require('node:fs')
const path = require('node:path')
const { createStore, parseIndex, upsertIndexEntry, INDEX_FILE, PROJECTS_DIR } = require('./lib/store')

function parseArgs(argv) {
  const out = { from: null, to: null, dryRun: false, force: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--from') out.from = argv[++i]
    else if (a === '--to') out.to = argv[++i]
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--force') out.force = true
    else if (a === '--help' || a === '-h') out.help = true
    else throw new Error(`未知参数 ${JSON.stringify(a)}`)
  }
  return out
}

function walkMd(dir, base, out) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name)
    const rel = path.relative(base, full).replace(/\\/g, '/')
    if (item.isDirectory()) {
      if (rel === PROJECTS_DIR) continue
      walkMd(full, base, out)
    } else if (item.isFile() && item.name.endsWith('.md')) {
      out.push(rel)
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.from || !args.to) {
    console.log('用法: node import.cjs --from <源记忆根> --to <目标记忆根> [--dry-run] [--force]')
    process.exit(args.help ? 0 : 2)
  }
  const from = path.resolve(args.from)
  const to = path.resolve(args.to)
  if (!fs.existsSync(from)) throw new Error(`源目录不存在：${from}`)
  if (from === to) throw new Error('源与目标相同，无需导入')

  const files = []
  walkMd(from, from, files)
  files.sort()

  const plan = []
  for (const rel of files) {
    if (rel === INDEX_FILE) continue
    const dest = path.join(to, rel)
    const exists = fs.existsSync(dest)
    plan.push({ rel, dest, action: exists ? (args.force ? 'overwrite' : 'skip') : 'copy' })
  }

  console.log(`源：${from}`)
  console.log(`目标：${to}`)
  console.log(`条目：${plan.length} 个（复制 ${plan.filter((p) => p.action === 'copy').length}，` +
    `覆盖 ${plan.filter((p) => p.action === 'overwrite').length}，` +
    `跳过已存在 ${plan.filter((p) => p.action === 'skip').length}）${args.dryRun ? ' —— dry-run，不写盘' : ''}`)
  for (const p of plan) console.log(`  ${p.action.padEnd(9)} ${p.rel}`)

  if (args.dryRun) {
    const header = path.join(from, INDEX_FILE)
    if (fs.existsSync(header)) {
      const idx = parseIndex(fs.readFileSync(header, 'utf8'))
      console.log(`\n索引分组：${idx.sections.map((s) => `${s.title}(${s.entries.length})`).join('、')}`)
    }
    return
  }

  for (const p of plan) {
    if (p.action === 'skip') continue
    fs.mkdirSync(path.dirname(p.dest), { recursive: true })
    fs.copyFileSync(path.join(from, p.rel), p.dest)
  }

  // 索引：先整体复制（两边格式一致，相对路径不变），再把「有文件但索引里没有」的补进去
  const store = createStore({ home: to, agentsPath: path.join(path.dirname(to), 'AGENTS.md') })
  const srcIndexPath = path.join(from, INDEX_FILE)
  const destIndexPath = path.join(to, INDEX_FILE)
  let indexText = fs.existsSync(destIndexPath)
    ? fs.readFileSync(destIndexPath, 'utf8')
    : (fs.existsSync(srcIndexPath) ? fs.readFileSync(srcIndexPath, 'utf8') : '')
  if (!fs.existsSync(destIndexPath) && indexText) {
    fs.mkdirSync(to, { recursive: true })
    fs.writeFileSync(destIndexPath, indexText, 'utf8')
    console.log(`\n已导入索引 ${INDEX_FILE}（${parseIndex(indexText).sections.length} 个分组）`)
  }

  const indexed = new Set(parseIndex(indexText).sections.flatMap((s) => s.entries.map((e) => e.target)))
  const missing = plan.map((p) => p.rel).filter((rel) => !indexed.has(rel))
  if (missing.length) {
    for (const rel of missing) {
      const abs = path.join(to, rel)
      const text = fs.readFileSync(abs, 'utf8')
      const fm = /^---[\s\S]*?\n---/.exec(text)
      const desc = fm && /(?:^|\n)\s*description:\s*(.+)/.exec(fm[0])
      indexText = upsertIndexEntry(indexText || '# 全局记忆库（跨工作区通用）\n', '导入', {
        title: rel.replace(/\.md$/, '').split('/').pop(),
        target: rel,
        summary: desc ? desc[1].trim() : ''
      })
    }
    fs.mkdirSync(to, { recursive: true })
    fs.writeFileSync(destIndexPath, indexText, 'utf8')
    console.log(`\n已把 ${missing.length} 个未被索引的条目补进「导入」分组`)
  }

  const finalEntries = store.listIndex('global').entries.length
  console.log(`\n完成。目标索引现有 ${finalEntries} 条。`)
  console.log(`下一步：在插件配置里把 home 指到 ${to}（或保持默认 ${'<DSH_HOME>/memory'}）。`)
}

try {
  main()
} catch (err) {
  console.error(`import 失败：${String((err && err.message) || err)}`)
  process.exit(1)
}
