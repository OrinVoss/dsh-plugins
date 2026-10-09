'use strict'

// dsh-memory 记忆库字段 lint：直接校验真实记忆库（不写盘），补 selfcheck 只测
// 「纯文件逻辑」的盲区——字段约定与索引/文件的一致性。
//
//   node lintmemory.cjs [memoryHome]      # 也可用 $DSH_MEMORY_HOME
//
// 记忆库不存在（换机器、未初始化）时跳过且退出码 0；发现问题退出码 1。
//
// 约定（2026-10-01 统一，见记忆库 INDEX.md 的「字段约定」）：
//   scope  global = 全局库根条目；project = projects/<name>-<hash>/ 下的条目
//   type   reference | feedback | workflow | fact | project
//          project 只允许「本身就是长期计划/项目」的条目：projects/ 下，或 study/ 白名单
//   2026-10-04 补：description 不许折行；索引摘要必须与 frontmatter description 一致（两套摘要合一）；
//                   索引标题不许是英文文件名（标题是显示用的那套，name 只是检索兜底）；
//                   正文 [[…]] 必须命中某个条目的 name；AGENTS.md 托管区块不许被预算截断

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const store = require('./lib/store')

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

const home = path.resolve(
  process.argv[2] || process.env.DSH_MEMORY_HOME || path.join(store.resolveDshHome(), 'memory')
)
if (!fs.existsSync(home)) {
  console.log(`\n记忆库不存在，跳过 lint：${home}\n`)
  process.exit(0)
}
console.log(`\n记忆库 lint：${home}\n`)

const PROJECT_INDEX_RE = /^projects\/[^/]+\/MEMORY\.md$/
const PROJECT_TYPE_WHITELIST = [/^projects\//, /^study\//]

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.md') && e.name !== store.INDEX_FILE && !PROJECT_INDEX_RE.test(path.relative(home, p).split(path.sep).join('/'))) out.push(p)
  }
  return out
}

const rel = (p) => path.relative(home, p).split(path.sep).join('/')
const entries = walk(home, []).map((p) => ({ p, r: rel(p), ...store.parseEntry(fs.readFileSync(p, 'utf8')) }))
const indexFiles = []
for (const p of [path.join(home, store.INDEX_FILE), ...walkProjects(home)]) if (p) indexFiles.push(p)

function walkProjects(dir) {
  const out = []
  const projects = path.join(dir, store.PROJECTS_DIR)
  if (!fs.existsSync(projects)) return out
  for (const e of fs.readdirSync(projects, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const p = path.join(projects, e.name, store.PROJECT_INDEX_FILE)
    if (fs.existsSync(p)) out.push(p)
  }
  return out
}

const indexes = indexFiles.map((p) => {
  const r = rel(p)
  const isProject = r.startsWith(store.PROJECTS_DIR + '/')
  const base = isProject ? path.dirname(p) : home
  const parsed = store.parseIndex(fs.readFileSync(p, 'utf8'))
  const listed = []
  for (const s of parsed.sections) for (const e of s.entries) listed.push(e.target)
  return { p, r, isProject, base, listed, sections: parsed.sections }
})

console.log(`（${entries.length} 个条目 / ${indexes.length} 个索引文件）\n`)

check('每个条目都有 frontmatter，且 name/description 齐备', () => {
  const bad = entries.filter((e) => e.meta.node_type !== 'memory' || !e.meta.name || !e.meta.description)
  if (bad.length) throw new Error(`缺字段：\n  ${bad.map((e) => e.r).join('\n  ')}`)
})

check('frontmatter 的 name 末段与文件名一致', () => {
  const bad = []
  for (const e of entries) {
    const isProject = e.r.startsWith(store.PROJECTS_DIR + '/')
    const base = isProject ? e.r.split('/').slice(0, 2).join('/') : ''
    const stem = (isProject ? e.r.slice(base.length + 1) : e.r).replace(/\.md$/, '')
    const last = stem.split('/').pop()
    if (![stem, last].includes(e.meta.name)) bad.push(`${e.r} → name=${e.meta.name}`)
  }
  if (bad.length) throw new Error(`name 与路径不符：\n  ${bad.join('\n  ')}`)
})

check('scope 显式且与位置一致（全局根=global，projects/=project）', () => {
  const bad = []
  for (const e of entries) {
    const isProject = e.r.startsWith(store.PROJECTS_DIR + '/')
    const want = isProject ? 'project' : 'global'
    if (e.meta.scope !== want) bad.push(`${e.r} → scope=${e.meta.scope || '(缺)'}，应为 ${want}`)
  }
  if (bad.length) throw new Error(`scope 不符：\n  ${bad.join('\n  ')}`)
})

check('type 合法；project 只用于 projects/ 或 study/ 白名单', () => {
  const bad = []
  for (const e of entries) {
    if (!store.ENTRY_TYPES.includes(e.meta.type)) bad.push(`${e.r} → type=${e.meta.type || '(缺)'}`)
    else if (e.meta.type === 'project' && !PROJECT_TYPE_WHITELIST.some((re) => re.test(e.r))) {
      bad.push(`${e.r} → type=project 但不在白名单（见 INDEX.md 字段约定）`)
    }
  }
  if (bad.length) throw new Error(`type 不符：\n  ${bad.join('\n  ')}`)
})

check('索引里没有重复登记同一条目', () => {
  const bad = []
  for (const idx of indexes) {
    const seen = new Set()
    for (const t of idx.listed) {
      if (seen.has(t)) bad.push(`${idx.r} 重复：${t}`)
      seen.add(t)
    }
  }
  if (bad.length) throw new Error(bad.join('\n  '))
})

check('索引指向的文件都存在', () => {
  const bad = []
  for (const idx of indexes) for (const t of idx.listed) if (!fs.existsSync(path.join(idx.base, t))) bad.push(`${idx.r} → ${t}`)
  if (bad.length) throw new Error(`悬空索引：\n  ${bad.join('\n  ')}`)
})

check('每个条目都被对应的索引登记（无孤儿）', () => {
  const bad = []
  for (const e of entries) {
    const isProject = e.r.startsWith(store.PROJECTS_DIR + '/')
    const wanted = isProject ? e.r.split('/').slice(0, 2).join('/') : null
    const idx = indexes.find((i) =>
      isProject ? i.isProject && rel(i.base) === wanted : !i.isProject
    )
    if (!idx) { bad.push(`${e.r} → 找不到对应索引`); continue }
    const target = path.relative(idx.base, e.p).split(path.sep).join('/')
    if (!idx.listed.includes(target)) bad.push(`${e.r} → 未登记在 ${idx.r}`)
  }
  if (bad.length) throw new Error(`孤儿条目：\n  ${bad.join('\n  ')}`)
})

check('行尾统一为 LF（不允许 CRLF）', () => {
  const bad = []
  for (const p of [...entries.map((e) => e.p), ...indexes.map((i) => i.p)]) {
    if (fs.readFileSync(p, 'utf8').includes('\r\n')) bad.push(rel(p))
  }
  if (bad.length) throw new Error(`存在 CRLF：\n  ${bad.join('\n  ')}`)
})

check('每个条目都有 updatedAt', () => {
  const bad = entries.filter((e) => !e.meta.updatedAt).map((e) => e.r)
  if (bad.length) throw new Error(`缺 updatedAt：\n  ${bad.join('\n  ')}`)
})

check('frontmatter 的 description 不折行（插件按行解析，续行会被静默吞掉）', () => {
  const bad = []
  for (const e of entries) {
    const lines = fs.readFileSync(e.p, 'utf8').split(/\r?\n/)
    const di = lines.findIndex((l, i) => i > 0 && /^description:/.test(l))
    if (di === -1) continue
    const end = lines.findIndex((l, i) => i > di && l.trim() === '---')
    if (end !== -1 && di + 1 < end && /^\s+\S/.test(lines[di + 1])) bad.push(e.r)
  }
  if (bad.length) throw new Error(`description 折行：\n  ${bad.join('\n  ')}`)
})

check('索引摘要与 frontmatter description 一致（同一事实不许有两套摘要）', () => {
  const norm = (x) => String(x || '').replace(/\s+/g, ' ').trim()
  const bad = []
  for (const idx of indexes) {
    for (const s of idx.sections) {
      for (const e of s.entries) {
        const abs = path.join(idx.base, e.target)
        if (!fs.existsSync(abs)) continue
        const meta = store.parseEntry(fs.readFileSync(abs, 'utf8')).meta
        if (norm(meta.description) !== norm(e.summary)) {
          bad.push(`${idx.r} → ${e.target}\n      索引: ${e.summary}\n      正文: ${meta.description}`)
        }
      }
    }
  }
  if (bad.length) throw new Error(`摘要漂移（把两处改成同一句）：\n  ${bad.join('\n  ')}`)
})

check('正文双链 [[…]] 都命中某个条目的 name', () => {
  const names = new Set(entries.map((e) => e.meta.name).filter(Boolean))
  const bad = []
  for (const e of entries) {
    for (const m of fs.readFileSync(e.p, 'utf8').matchAll(/\[\[([^\]\n]+)\]\]/g)) {
      const x = m[1].trim()
      if (x === '双链' || names.has(x)) continue
      bad.push(`${e.r} → [[${x}]]`)
    }
  }
  if (bad.length) throw new Error(
    '双链对不上（库里 name 命名不统一：路径式与叶子名混用——' +
    '用 `node namemap.cjs <关键词>` 查目标条目的真实 name）：\n  ' + bad.join('\n  ')
  )
})

check('索引标题是给人读的，不许直接是文件名（中英混排的源头）', () => {
  const bad = []
  for (const idx of indexes) {
    for (const s of idx.sections) {
      for (const e of s.entries) {
        const title = String(e.title || '').trim()
        if (!title) { bad.push(`${idx.r} → ${e.target}（标题为空）`); continue }
        if (title === e.target || /\.md$/.test(title)) {
          bad.push(`${idx.r} → ${e.target}\n      标题现在是文件名：${title}`)
        }
      }
    }
  }
  if (bad.length) {
    throw new Error(`索引标题被写成了文件名（人工标题以中文为主，改完跑一次 reindex 的兄弟脚本或手改 INDEX.md）：\n  ${bad.join('\n  ')}`)
  }
})


check('AGENTS.md 托管区块没被预算截断（且余量 > 10%）', () => {
  const agents = path.join(path.dirname(home), 'AGENTS.md')
  if (!fs.existsSync(agents)) return
  const t = fs.readFileSync(agents, 'utf8')
  const b = t.indexOf(store.BLOCK_BEGIN)
  const e2 = t.indexOf(store.BLOCK_END)
  if (b === -1 || e2 === -1) return
  const block = t.slice(b, e2 + store.BLOCK_END.length)
  if (/索引超预算/.test(block)) {
    throw new Error('托管区块已被截断（区块里出现「索引超预算」提示）——提高 maxBlockBytes 或精简条目摘要')
  }
  let budget = 32768
  const cfg = path.join(__dirname, 'cordis.patch.yml')
  if (fs.existsSync(cfg)) {
    const m = /maxBlockBytes:\s*(\d+)/.exec(fs.readFileSync(cfg, 'utf8'))
    if (m) budget = Number(m[1])
  }
  const bytes = Buffer.byteLength(block, 'utf8')
  const pct = (bytes / budget) * 100
  if (pct > 90) throw new Error(`托管区块 ${bytes}/${budget} 字节（${pct.toFixed(0)}%，>90%）——再加一条就会开始从末尾截断`)
  process.stdout.write(`        （区块 ${bytes}/${budget} 字节，用掉 ${pct.toFixed(0)}%）\n`)
})

check('常驻规则（always: true）必须有 digest，长度 6–60 字，且与 description 不同', () => {
  const always = entries.filter((e) => e.meta.always === 'true')
  const bad = []
  for (const e of always) {
    const d = e.meta.digest || ''
    if (!d) { bad.push(`${e.r}：标了 always 但没有 digest（注入区块里会整条消失）`); continue }
    const n = [...d].length
    if (n < 6 || n > 60) bad.push(`${e.r}：digest ${n} 字（要求 6–60）`)
    if (d === e.meta.description) bad.push(`${e.r}：digest 与 description 完全相同（没有精简，白占字节）`)
  }
  if (bad.length) throw new Error(`常驻规则不合规：\n  ${bad.join('\n  ')}`)
  process.stdout.write(`        （常驻规则 ${always.length} 条）\n`)
})
console.log(`\n${passed} 项通过，${failures.length} 项失败。\n`)
if (failures.length) {
  for (const f of failures) console.log(`FAILED: ${f.label}\n${(f.err && f.err.stack) || ''}\n`)
  process.exit(1)
}
