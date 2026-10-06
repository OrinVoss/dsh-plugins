'use strict'

// 双链/指针用的 **name 查询**。
//
// 为什么需要它：本库的 `name` 命名**不统一**——2026-10-06 实测 53 条是路径式
// （`tools/dsh-plugins-repo`、`workflows/music-compose-pipeline`），35 条是**叶子名**
// （`promo-video-pipeline`、`headless-edge-slide-render`、`git-local-commit-only`…），
// 而写 `[[…]]` 时**无法从文件路径推出**该用哪种（连撞三次才做的普查）。
// lint 第 12 项会拦住错的，但那是事后；写之前先查这里。
//
//   node namemap.cjs               列出全部条目（name ↔ 目标路径）
//   node namemap.cjs 蓝屏           按关键词过滤（匹配 name / 目标路径 / 索引标题）
//   node namemap.cjs --leaf        只看叶子名条目（写指针时最容易写错的那批）
//   node namemap.cjs --path        只看路径式条目
//   node namemap.cjs --json        机器可读输出
//
// 只读，不写任何文件。

const fs = require('node:fs')
const path = require('node:path')
const store = require('./lib/store.js')

function resolveHome(explicit) {
  if (explicit) return explicit
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
  return path.join(home, 'memory')
}

/** 扫全库（全局 + 各项目库），返回 [{ name, target, title, section, style, file }] */
function collect(home) {
  const out = []
  const readIndex = (indexFile, dir) => {
    if (!fs.existsSync(indexFile)) return
    const entries = store.indexEntries(fs.readFileSync(indexFile, 'utf8'))
    for (const e of entries) {
      const p = path.join(dir, e.target)
      let name = ''
      try { name = store.parseEntry(fs.readFileSync(p, 'utf8')).meta.name || '' } catch (_) { name = '' }
      const target = path.relative(home, p).replace(/\\/g, '/')
      out.push({
        name,
        target,
        title: e.title,
        section: e.section,
        style: name.includes('/') ? 'path' : 'leaf',
        file: p
      })
    }
  }
  readIndex(path.join(home, store.INDEX_FILE), home)
  const projectsDir = path.join(home, store.PROJECTS_DIR)
  try {
    for (const d of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      const dir = path.join(projectsDir, d.name)
      readIndex(path.join(dir, 'MEMORY.md'), dir)
    }
  } catch (_) { /* 没有项目库 */ }
  return out
}

function main() {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const onlyLeaf = args.includes('--leaf')
  const onlyPath = args.includes('--path')
  const kw = args.filter((a) => !a.startsWith('--')).join(' ').toLowerCase()

  const home = resolveHome(process.env.DSH_MEMORY_HOME)
  if (!fs.existsSync(home)) {
    console.error(`找不到记忆库：${home}`)
    process.exit(1)
  }
  let rows = collect(home)
  if (onlyLeaf) rows = rows.filter((r) => r.style === 'leaf')
  if (onlyPath) rows = rows.filter((r) => r.style === 'path')
  if (kw) {
    rows = rows.filter((r) =>
      r.name.toLowerCase().includes(kw) ||
      r.target.toLowerCase().includes(kw) ||
      String(r.title || '').toLowerCase().includes(kw))
  }

  if (json) {
    console.log(JSON.stringify(rows, null, 2))
    return
  }

  const all = collect(home)
  const leaf = all.filter((r) => r.style === 'leaf').length
  console.log(`记忆库：${home}`)
  console.log(`条目 ${all.length}（路径式 name ${all.length - leaf} / 叶子名 ${leaf}）`)
  console.log('写 `[[…]]` 要用下表的 **name** 列（叶子名的不能加目录前缀，反之亦然）。\n')
  const w = Math.max(4, ...rows.map((r) => r.name.length))
  for (const r of rows) {
    console.log(`${r.style === 'leaf' ? '叶' : '路'}  ${r.name.padEnd(w)}  ←  ${r.target}`)
  }
  if (!rows.length) console.log('（没有匹配的条目）')
  console.log(`\n共 ${rows.length} 条${kw ? `（关键词「${kw}」）` : ''}`)
}

if (require.main === module) main()
module.exports = { collect, resolveHome }
