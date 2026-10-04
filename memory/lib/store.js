'use strict'

// dsh-memory — 记忆库的纯文件逻辑（不依赖任何 DSH 内部模块，可独立测试）
//
// 自检：`node selfcheck.cjs`（本文件）+ `node plugintest.cjs`（host.js）
//
// 磁盘布局与 Z code 的 global-memory 完全一致：
//
//   <home>/INDEX.md                 全局索引（人可读、可手改）
//   <home>/<section>/<name>.md      全局条目（name 可含子目录）
//   <home>/projects/<key>/MEMORY.md 项目索引
//   <home>/projects/<key>/<name>.md 项目条目
//
// 条目格式：
//   ---
//   name: <slug>
//   description: <一句话>
//   metadata:
//     node_type: memory
//     type: reference|feedback|project|workflow
//     scope: global|project
//     originSessionId: <id>
//     createdAt: <ISO>
//     updatedAt: <ISO>
//   ---
//   <正文>
//
// 索引条目格式：- [标题](相对路径.md) — 摘要

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const os = require('node:os')

const BLOCK_BEGIN = '<!-- dsh-memory:begin -->'
const BLOCK_END = '<!-- dsh-memory:end -->'
const INDEX_FILE = 'INDEX.md'
const PROJECT_INDEX_FILE = 'MEMORY.md'
const PROJECTS_DIR = 'projects'
const ENTRY_TYPES = ['reference', 'feedback', 'project', 'workflow', 'fact']
const SCOPES = ['global', 'project']
const DEFAULT_SECTION = '其他'

/** 解析 DSH home：显式 config > $DSH_HOME > ~/.dsh */
function resolveDshHome(explicit) {
  if (explicit && String(explicit).trim()) return path.resolve(String(explicit).trim())
  const env = process.env.DSH_HOME
  if (env && env.trim()) return path.resolve(env.trim())
  return path.join(os.homedir(), '.dsh')
}

/** 把任意标题压成安全的文件名/路径片段。保留 `/` 以支持子目录。 */
const SLUG_KEEP = /[^a-z0-9\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff._-]+/gi
function slugify(name) {
  const raw = String(name == null ? '' : name).trim()
  if (!raw) throw new Error('memory: name 不能为空')
  const parts = raw
    .replace(/\\/g, '/')
    .split('/')
    .map((seg) => seg.trim())
    .filter((seg) => seg && seg !== '.')
  if (parts.length === 0 || parts.includes('..')) {
    throw new Error(`memory: name ${JSON.stringify(raw)} 不是合法路径（不允许 ".." 与空路径）`)
  }
  return parts
    .map((seg) =>
      seg
        .replace(/\.md$/i, '')
        .replace(SLUG_KEEP, '-')
        .replace(/-+/g, '-')
        .replace(/-+\./g, '.')
        .replace(/^-|-$/g, '')
        .toLowerCase()
    )
    .filter(Boolean)
    .join('/')
}

/** 与 Z code 相同的项目键：<目录名 slug>-<cwd 归一化后的 16 位 sha1> */
function projectKey(cwd) {
  const raw = String(cwd == null ? '' : cwd).trim()
  if (!raw) return null
  const norm = path.resolve(raw).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const base = norm.split('/').filter(Boolean).pop() || 'workspace'
  const slug = base
    .replace(/[^a-z0-9\u4e00-\u9fa5._-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase() || 'workspace'
  const hash = crypto.createHash('sha1').update(norm).digest('hex').slice(0, 16)
  return `${slug}-${hash}`
}

const PROJECT_KEY_RE = /^[^\s/\\]+-[0-9a-f]{16}$/

/**
 * 项目作用域既可以按会话 cwd 寻址，也可以直接给一个已存在的项目键
 * （设置页管理历史项目记忆时走后者）。
 */
function keyFrom(cwdOrKey) {
  const raw = String(cwdOrKey == null ? '' : cwdOrKey).trim()
  if (!raw) return null
  if (PROJECT_KEY_RE.test(raw)) return raw
  return projectKey(raw)
}

function sha1(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex')
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return null
    throw err
  }
}

function writeTextAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, text, 'utf8')
  try {
    fs.renameSync(tmp, file)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch (_) { /* best effort */ }
    throw err
  }
}

// ---------------------------------------------------------------- frontmatter

function oneLine(value) {
  return String(value == null ? '' : value).replace(/\r?\n/g, ' ').trim()
}

function serializeEntry(meta, body) {
  const lines = ['---', `name: ${oneLine(meta.name)}`, `description: ${oneLine(meta.description)}`, 'metadata:', `  node_type: memory`, `  type: ${oneLine(meta.type)}`, `  scope: ${oneLine(meta.scope)}`]
  if (meta.originSessionId) lines.push(`  originSessionId: ${oneLine(meta.originSessionId)}`)
  lines.push(`  createdAt: ${oneLine(meta.createdAt)}`)
  lines.push(`  updatedAt: ${oneLine(meta.updatedAt)}`)
  lines.push('---', '')
  return `${lines.join('\n')}\n${String(body || '').replace(/^\n+/, '').replace(/\s+$/, '')}\n`
}

function parseEntry(text) {
  // 统一行尾：否则 head 的最后一行会残留 \r，正则末端的 $ 匹配不上，frontmatter 最后一条
  // 元数据（常见是 scope / updatedAt）会被静默丢掉——CRLF 条目实测踩到。
  const src = String(text || '').replace(/\r\n/g, '\n')
  if (!src.startsWith('---')) return { meta: {}, body: src.trim() }
  const end = src.indexOf('\n---', 3)
  if (end === -1) return { meta: {}, body: src.trim() }
  const head = src.slice(3, end).replace(/^\n/, '')
  const body = src.slice(end + 4).replace(/^\n/, '').trim()
  const meta = {}
  let inMetadata = false
  for (const line of head.split(/\r?\n/)) {
    if (!line.trim()) continue
    const indent = /^\s/.test(line)
    const m = /^\s*([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    if (!indent) {
      inMetadata = m[1] === 'metadata'
      if (!inMetadata) meta[m[1]] = m[2].trim()
      continue
    }
    if (inMetadata) meta[m[1]] = m[2].trim()
  }
  return { meta, body }
}

// ---------------------------------------------------------------- index

/** 索引文本里的 `## 分组` 区间（标题行号 + [start, end)，end 不含下一个标题）。 */
function sectionRanges(lines) {
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^##\s+(.*)$/.exec(lines[i])
    if (!m) continue
    if (out.length) out[out.length - 1].end = i
    out.push({ title: m[1].trim(), start: i, end: lines.length })
  }
  return out
}

/**
 * 索引里所有条目的**登记处**：{ section, target, line, start, end }，
 * start/end 是 bullet 行到它折行续行结束的区间。
 *
 * 返回"全部"而不是"第一条"：索引是人可读、可手改的，同一 target 完全可能
 * 被登记两次（历史写入 bug、手工编辑、两个 agent 系统共用同一个库）。
 */
function allIndexOccurrences(lines) {
  const out = []
  for (const range of sectionRanges(lines)) {
    for (let i = range.start + 1; i < range.end; i++) {
      const b = /^-\s+\[([^\]]*)\]\(([^)]+)\)/.exec(lines[i])
      if (!b) continue
      let end = i + 1
      while (end < range.end) {
        const cont = lines[end].trim()
        if (!cont || /^[>#|]/.test(cont) || /^-\s/.test(cont)) break
        end++
      }
      out.push({ section: range.title, target: b[2].trim(), line: lines[i], start: i, end })
      i = end - 1
    }
  }
  return out
}

/** 索引里某个 target 的全部登记处。 */
function findIndexOccurrences(lines, target) {
  const want = String(target == null ? '' : target).trim()
  return allIndexOccurrences(lines).filter((h) => h.target === want)
}

/** 渲染索引：去掉尾部空行后补一个换行（幂等，不会每写一次就多攒一个空行）。 */
function renderIndex(lines) {
  const out = lines.slice()
  while (out.length && out[out.length - 1].trim() === '') out.pop()
  return `${out.join('\n')}\n`
}

/** 解析索引文本 → { sections: [{ title, entries: [{title,target,summary}] }] } */
function parseIndex(text) {
  const sections = []
  let current = null
  let last = null
  const preamble = []
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw
    const heading = /^##\s+(.*)$/.exec(line)
    if (heading) {
      current = { title: heading[1].trim(), entries: [] }
      sections.push(current)
      last = null
      continue
    }
    const bullet = /^-\s+\[([^\]]*)\]\(([^)]+)\)\s*(?:[—–-]\s*(.*))?$/.exec(line)
    if (bullet && current) {
      last = {
        title: bullet[1].trim(),
        target: bullet[2].trim(),
        summary: (bullet[3] || '').trim()
      }
      current.entries.push(last)
      continue
    }
    if (!current) {
      if (line.trim()) preamble.push(line)
      continue
    }
    // 索引条目常常折行书写；续行不是新条目而是上一条摘要的一部分。
    const trimmed = line.trim()
    if (last && trimmed && !/^[>#|]/.test(trimmed) && !/^-\s/.test(trimmed)) {
      last.summary = last.summary ? `${last.summary} ${trimmed}` : trimmed
    }
  }
  return { sections, preamble }
}

function entryLine(entry) {
  const summary = entry.summary ? ` — ${oneLine(entry.summary)}` : ''
  return `- [${oneLine(entry.title)}](${entry.target})${summary}`
}

/**
 * 在指定分组插入/更新一条索引项；返回新的索引文本。
 *
 * 「这条记忆登记在哪个分组」由**索引自己**说了算，而不是由调用方给的分组名说了算：
 *   - 已经登记过（哪怕登记在别的分组）→ **原地更新**，绝不再追加一行；
 *   - 同时清掉同一 target 的其它重复登记（自愈）；
 *   - 只有 `options.forceSection === true`（调用方**显式**指定了分组）才把条目搬过去。
 *
 * 为什么必须这样：旧实现只在本分组里找同 target。凡是"写入时给的分组名与它现有分组不同"
 * 的覆盖写（典型：overwrite 时没传 section，回退成 name 首段目录 `preferences`），
 * 都会在文件末尾新开一组、再追加一行，旧分组里那行原样留着 —— 2026-10-01 实测
 * INDEX.md 因此出现两行同 target 的重复登记。
 */
function upsertIndexEntry(text, section, entry, options) {
  const opts = options || {}
  const src = String(text == null ? '' : text)
  let lines = src.length ? src.split(/\r?\n/) : []
  const sectionTitle = String(section || DEFAULT_SECTION).trim() || DEFAULT_SECTION

  const hits = findIndexOccurrences(lines, entry.target)
  if (hits.length) {
    const same = hits.filter((h) => h.section === sectionTitle)
    const keep = same.length ? same[same.length - 1] : opts.forceSection ? null : hits[0]
    const drop = hits.filter((h) => h !== keep)
    // 自下而上摘掉重复登记，避免行号位移
    for (const h of drop.slice().sort((a, b) => b.start - a.start)) lines.splice(h.start, h.end - h.start)
    if (keep) {
      const shift = drop.reduce((n, h) => (h.start < keep.start ? n + (h.end - h.start) : n), 0)
      lines.splice(keep.start - shift, keep.end - keep.start, entryLine(entry))
      return renderIndex(pruneEmptySections(lines.join('\n')).split('\n'))
    }
    // 显式换了分组：上面已把旧登记全部摘掉，剪掉可能变空的旧分组，再按"新条目"插进目标分组
    if (drop.length) lines = pruneEmptySections(lines.join('\n')).split('\n')
  }

  const ranges = sectionRanges(lines)
  const want = sectionTitle.toLowerCase()
  const range = ranges.find((r) => r.title === sectionTitle) || ranges.find((r) => r.title.toLowerCase() === want)

  if (!range) {
    // 新增分组：插到文件末尾（保留原有的尾注引用块）
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
    lines.push('', `## ${sectionTitle}`, entryLine(entry))
    return renderIndex(lines)
  }

  // 插在该分组最后一条 bullet 之后。
  // 注意要先跳过上一条的折行续行，否则新条目会插进别人摘要的中间。
  let lastBullet = range.start
  for (let i = range.start + 1; i < range.end; i++) if (/^-\s+\[/.test(lines[i])) lastBullet = i
  let insertAt
  if (lastBullet === range.start) {
    insertAt = range.start + 1
  } else {
    insertAt = lastBullet + 1
    while (insertAt < range.end) {
      const cont = lines[insertAt].trim()
      if (!cont || /^[>#|]/.test(cont) || /^-\s/.test(cont)) break
      insertAt++
    }
  }
  lines.splice(insertAt, 0, entryLine(entry))
  return renderIndex(lines)
}

/**
 * 一次性修复索引里同一 target 的重复登记：
 * **位置以第一次登记为准，行内容以最后一次登记为准**（重复行通常来自后来的追加写，
 * 标题/摘要更新；而首次登记的分组才是人工维护过的那个）。摘空的重复分组会被剪掉。
 *
 * 返回 { text, duplicates: [{ target, sections }], changed }。
 */
function repairIndex(text) {
  const src = String(text == null ? '' : text)
  const lines = src.split(/\r?\n/)
  const byTarget = new Map()
  for (const h of allIndexOccurrences(lines)) {
    const list = byTarget.get(h.target)
    if (list) list.push(h)
    else byTarget.set(h.target, [h])
  }

  // 保留"第一次登记"的位置、换成"最后一次登记"的整块文本（含它的折行续行），
  // 其余登记连折行续行一起删掉。自下而上 splice，避免行号位移。
  const ops = []
  const duplicates = []
  for (const [target, list] of byTarget) {
    if (list.length < 2) continue
    const first = list[0]
    const last = list[list.length - 1]
    duplicates.push({ target, sections: list.map((h) => h.section) })
    ops.push({ at: first.start, remove: first.end - first.start, insert: lines.slice(last.start, last.end) })
    for (const h of list.slice(1)) ops.push({ at: h.start, remove: h.end - h.start, insert: [] })
  }
  if (!duplicates.length) return { text: src, duplicates, changed: false }

  for (const op of ops.sort((a, b) => b.at - a.at)) lines.splice(op.at, op.remove, ...op.insert)
  return { text: renderIndex(pruneEmptySections(lines.join('\n')).split('\n')), duplicates, changed: true }
}

/**
 * 剪掉「下面直到下一个 `##` 之间没有任何条目」的空分组标题（连同它的空行）。
 * 只动 `##` 标题与紧随其后的空行，不碰文件头、正文段落和其它分组。
 */
function pruneEmptySections(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/)
  const drop = new Array(lines.length).fill(false)
  for (let i = 0; i < lines.length; i++) {
    if (!/^##\s+/.test(lines[i])) continue
    let end = i + 1
    let hasEntry = false
    for (; end < lines.length; end++) {
      if (/^##\s+/.test(lines[end])) break
      if (/^-\s+\[/.test(lines[end])) { hasEntry = true; break }
    }
    if (hasEntry) continue
    drop[i] = true
    for (let j = i + 1; j < end; j++) {
      if (lines[j].trim() === '') drop[j] = true
      else break
    }
  }
  const pruned = lines.filter((_, i) => !drop[i]).join('\n')
  // 顺带把剪出来的连续空行收成一个空行
  return pruned.replace(/\n{3,}/g, '\n\n')
}

/** 从索引中移除某个 target（含其折行续行），并剪掉因此变空的分组；返回 { text, removed, pruned }。 */
function removeIndexEntry(text, target) {
  const lines = String(text == null ? '' : text).split(/\r?\n/)
  let removed = false
  const kept = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const b = /^-\s+\[([^\]]*)\]\(([^)]+)\)/.exec(line)
    if (b && b[2].trim() === target) {
      removed = true
      while (i + 1 < lines.length) {
        const cont = lines[i + 1].trim()
        if (!cont || /^[>#|]/.test(cont) || /^-\s/.test(cont)) break
        i++
      }
      continue
    }
    kept.push(line)
  }
  if (!removed) return { text: `${kept.join('\n')}`, removed, pruned: [] }
  const before = parseIndex(kept.join('\n')).sections.map((s) => s.title)
  const prunedText = pruneEmptySections(kept.join('\n'))
  const after = new Set(parseIndex(prunedText).sections.map((s) => s.title))
  return { text: prunedText, removed, pruned: before.filter((t) => !after.has(t)) }
}

/** 索引里所有条目（不分 section）。 */
function indexEntries(text) {
  const out = []
  for (const section of parseIndex(text).sections) {
    for (const entry of section.entries) out.push({ ...entry, section: section.title })
  }
  return out
}

// ---------------------------------------------------------------- 检索切词

/** 词与词的分隔符：空白、全角空格与中英文标点。注意**不含** `.`，否则 `13.4`、`store.js` 会被切碎。 */
const TERM_SEPARATORS = /[\s\u3000,，;；:：!！?？()（）[\]【】{}<>《》"“”'‘’`~@#$%^&*+=|\\/…—–_-]+/
/** 一个词块：英文/数字串（允许内部含 `.` `_` `'` `+` `-`），或一整段 CJK。 */
const TERM_CHUNK = /[a-z0-9][a-z0-9_.'+-]*|[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]+/g
/** 词块两端的粘连标点（句末的 `.` 等）。 */
const TERM_TRIM = /^[.'+_-]+|[.'+_-]+$/g

/**
 * 把查询切成词。多词查询不再被当成一个整体子串——这是原来假阴性的根因。
 *
 * 刻意**不做 bigram 兜底**：试过，`不存在`、`关键` 这类常见二字词会让乱码查询
 * 也凑够票数产生假命中（「不存在的关键词xyzzy」曾命中 12 条）。代价是无空格的
 * 多词中文（「笔记本蓝屏」）不会自动切分——用空格分隔即可，见 README §10。
 */
function tokenize(query) {
  const raw = String(query == null ? '' : query).trim().toLowerCase()
  if (!raw) return []
  const terms = []
  for (const chunk of raw.split(TERM_SEPARATORS)) {
    if (!chunk) continue
    for (const rawPart of chunk.match(TERM_CHUNK) || []) {
      const part = rawPart.replace(TERM_TRIM, '')
      if (part) terms.push(part)
    }
  }
  return [...new Set(terms)]
}

// ---------------------------------------------------------------- store

function createStore(options) {
  const opts = options || {}
  const home = path.resolve(String(opts.home || path.join(resolveDshHome(opts.dshHome), 'memory')))
  const agentsPath = opts.agentsPath
    ? path.resolve(String(opts.agentsPath))
    : path.join(resolveDshHome(opts.dshHome), 'AGENTS.md')
  const maxBlockBytes = Number.isFinite(opts.maxBlockBytes) && opts.maxBlockBytes > 0
    ? Math.floor(opts.maxBlockBytes)
    : 20000

  /** 某个作用域对应的根目录与索引文件。cwd 也可以直接传项目键。 */
  function scopePaths(scope, cwdOrKey) {
    const s = SCOPES.includes(scope) ? scope : 'global'
    if (s === 'global') {
      return { scope: 'global', dir: home, indexFile: path.join(home, INDEX_FILE) }
    }
    const key = keyFrom(cwdOrKey)
    if (!key) throw new Error('memory: project 作用域需要一个工作目录或项目键')
    const dir = path.join(home, PROJECTS_DIR, key)
    return { scope: 'project', key, dir, indexFile: path.join(dir, PROJECT_INDEX_FILE) }
  }

  /** 列出现有的项目记忆目录（设置页用）。 */
  function listProjects() {
    const root = path.join(home, PROJECTS_DIR)
    let names
    try {
      names = fs.readdirSync(root, { withFileTypes: true })
    } catch (_) {
      return []
    }
    const out = []
    for (const item of names) {
      if (!item.isDirectory()) continue
      const dir = path.join(root, item.name)
      const indexFile = path.join(dir, PROJECT_INDEX_FILE)
      const text = readText(indexFile) || ''
      const entries = indexEntries(text)
      let updatedAt = null
      try { updatedAt = fs.statSync(indexFile).mtime.toISOString() } catch (_) { /* 可能只有条目没有索引 */ }
      out.push({
        key: item.name,
        dir,
        indexFile,
        exists: text.length > 0,
        entries: entries.length,
        bytes: Buffer.byteLength(text, 'utf8'),
        updatedAt
      })
    }
    out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    return out
  }

  /** 记忆库整体状态（设置页顶部用）。 */
  function status(cwdOrKey) {
    const global = listIndex('global')
    let project = null
    try {
      project = listIndex('project', cwdOrKey)
    } catch (_) { /* 无 cwd 时不给当前项目 */ }
    const indexPath = path.join(home, INDEX_FILE)
    let indexUpdatedAt = null
    try { indexUpdatedAt = fs.statSync(indexPath).mtime.toISOString() } catch (_) { /* 空库 */ }
    let blockBytes = 0
    try {
      const agents = readText(agentsPath)
      if (agents) {
        const begin = agents.indexOf(BLOCK_BEGIN)
        const end = agents.indexOf(BLOCK_END)
        if (begin !== -1 && end > begin) blockBytes = Buffer.byteLength(agents.slice(begin, end + BLOCK_END.length), 'utf8')
      }
    } catch (_) { /* 读不到就是 0 */ }
    return {
      home,
      agentsPath,
      indexFile: indexPath,
      maxBlockBytes,
      blockBytes,
      indexUpdatedAt,
      global: { count: global.entries.length, bytes: Buffer.byteLength(readText(indexPath) || '', 'utf8') },
      project: project ? { key: project.key, count: project.entries.length, exists: project.exists } : null,
      projects: listProjects().length
    }
  }

  function listIndex(scope, cwd) {
    const sp = scopePaths(scope, cwd)
    const text = readText(sp.indexFile) || ''
    const parsed = parseIndex(text)
    return {
      scope: sp.scope,
      key: sp.key,
      dir: sp.dir,
      indexFile: sp.indexFile,
      exists: text.length > 0,
      entries: indexEntries(text),
      sections: parsed.sections,
      preamble: parsed.preamble
    }
  }

  function entryPath(scope, name, cwd) {
    const sp = scopePaths(scope, cwd)
    const slug = slugify(name)
    if (!slug) throw new Error(`memory: 非法的 name ${JSON.stringify(name)}`)
    const file = path.join(sp.dir, `${slug}.md`)
    const rel = path.relative(sp.dir, file).replace(/\\/g, '/')
    return { sp, slug, file, rel, target: rel }
  }

  function read(scope, name, cwd) {
    const { sp, slug, file, target } = entryPath(scope, name, cwd)
    const text = readText(file)
    if (text === null) return { found: false, scope: sp.scope, name: slug, target }
    const { meta, body } = parseEntry(text)
    return { found: true, scope: sp.scope, name: slug, target, file, meta, body }
  }

  function write(scope, input, cwd) {
    const { sp, slug, file, target } = entryPath(scope, input.name, cwd)
    const existingText = readText(file)
    if (existingText !== null && input.overwrite !== true) {
      return {
        ok: false,
        reason: 'exists',
        scope: sp.scope,
        name: slug,
        target,
        message: `记忆条目 ${target} 已存在。若确认要整条替换，请带 overwrite: true 重写；只想补充内容，请把原正文合并进 body。`
      }
    }
    const now = new Date().toISOString()
    const prev = existingText !== null ? parseEntry(existingText) : null
    const meta = {
      name: slug,
      description: oneLine(input.description),
      type: ENTRY_TYPES.includes(input.type) ? input.type : 'reference',
      scope: sp.scope,
      originSessionId: input.sessionId ? String(input.sessionId) : (prev && prev.meta.originSessionId) || '',
      createdAt: prev && prev.meta.createdAt ? prev.meta.createdAt : now,
      updatedAt: now
    }
    const body = String(input.body == null ? '' : input.body).trim()
    if (!body) return { ok: false, reason: 'empty-body', message: 'memory_write: body 不能为空' }
    if (!meta.description) return { ok: false, reason: 'no-description', message: 'memory_write: description 不能为空（它是索引里那一行摘要）' }

    writeTextAtomic(file, serializeEntry(meta, body))

    // 分组：显式给了就用它（并允许把条目搬过去）；没给则**沿用索引里现有的分组**，
    // 只有全新条目才回退到 name 首段目录 / 默认分组 —— 否则 overwrite 时漏传 section
    // 会把条目"改判"到另一个分组，并在索引里留下一行重复登记。
    const explicitSection = input.section ? String(input.section).trim() : ''
    const fallbackSection = slug.includes('/') ? slug.split('/')[0] : DEFAULT_SECTION
    const requestedSection = explicitSection || fallbackSection
    const indexText = readText(sp.indexFile) || defaultIndexHeader(sp.scope)
    const nextIndex = upsertIndexEntry(
      indexText,
      requestedSection,
      {
        title: input.title ? String(input.title).trim() : slug.split('/').pop(),
        target,
        summary: meta.description
      },
      { forceSection: !!explicitSection }
    )
    writeTextAtomic(sp.indexFile, nextIndex)
    const landed = indexEntries(nextIndex).find((e) => e.target === target)

    return {
      ok: true,
      updated: existingText !== null,
      scope: sp.scope,
      key: sp.key,
      name: slug,
      target,
      file,
      section: landed ? landed.section : requestedSection,
      sectionRequested: requestedSection,
      indexFile: sp.indexFile
    }
  }

  function forget(scope, name, cwd) {
    const { sp, slug, file, target } = entryPath(scope, name, cwd)
    const existed = readText(file) !== null
    if (existed) fs.unlinkSync(file)
    const indexText = readText(sp.indexFile)
    let deindexed = false
    let pruned = []
    if (indexText !== null) {
      const res = removeIndexEntry(indexText, target)
      deindexed = res.removed
      pruned = res.pruned || []
      if (deindexed) writeTextAtomic(sp.indexFile, res.text)
    }
    // 清理空目录（只清 entry 自己的子目录，不动 scope 根）
    let dir = path.dirname(file)
    while (dir !== sp.dir && dir.startsWith(sp.dir)) {
      let empty = false
      try { empty = fs.readdirSync(dir).length === 0 } catch (_) { break }
      if (!empty) break
      try { fs.rmdirSync(dir) } catch (_) { break }
      dir = path.dirname(dir)
    }
    return { ok: existed || deindexed, removed: existed, deindexed, pruned, scope: sp.scope, name: slug, target }
  }

  function allEntryFiles(scope, cwd) {
    const sp = scopePaths(scope, cwd)
    const out = []
    const walk = (dir) => {
      let items
      try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) { return }
      for (const item of items) {
        const full = path.join(dir, item.name)
        if (item.isDirectory()) {
          if (dir === home && item.name === PROJECTS_DIR) continue
          walk(full)
        } else if (item.isFile() && item.name.endsWith('.md') && full !== sp.indexFile) {
          out.push(full)
        }
      }
    }
    walk(sp.dir)
    return out
  }

  /**
   * 检索。多词查询按词分别计分：整串命中权重最高，其次是标题 > 摘要/路径 > 正文；
   * 所有词都命中再加成。索引先打分（不读正文），只在候选不足或某个词在索引里
   * 完全没出现时才回落到正文全量扫描，保住召回。
   */
  function search(scope, query, cwd, limit) {
    const q = String(query == null ? '' : query).trim()
    const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 5
    const idx = listIndex(scope, cwd)
    const needle = q.toLowerCase()
    const terms = tokenize(q)

    const candidates = new Map()
    const bump = (target, entry, score) => {
      if (score <= 0) return
      const prev = candidates.get(target)
      if (prev === undefined) candidates.set(target, { score, entry })
      else prev.score += score
    }
    const indexHits = new Set()

    if (!needle) {
      // 空查询 = 列出索引
      for (const entry of idx.entries) candidates.set(entry.target, { score: 1, entry })
    } else {
      for (const entry of idx.entries) {
        const title = entry.title.toLowerCase()
        const hay = `${entry.summary} ${entry.target}`.toLowerCase()
        let score = 0
        let hit = 0
        if (title.includes(needle)) score += 60
        else if (hay.includes(needle)) score += 40
        for (const term of terms) {
          if (title.includes(term)) { score += 8; hit++; indexHits.add(term) }
          else if (hay.includes(term)) { score += 4; hit++; indexHits.add(term) }
        }
        if (terms.length > 1 && hit === terms.length) score += 12
        bump(entry.target, entry, score)
      }

      // 某个词在索引里完全没出现，或候选还不够 → 扫正文，否则会漏召回
      const missingTerm = terms.some((term) => !indexHits.has(term))
      if (missingTerm || candidates.size < cap) {
        for (const file of allEntryFiles(scope, cwd)) {
          const rel = path.relative(idx.dir, file).replace(/\\/g, '/')
          const text = readText(file) || ''
          const lower = text.toLowerCase()
          let score = 0
          let hit = 0
          if (lower.includes(needle)) score += 20
          for (const term of terms) if (lower.includes(term)) { score += 2; hit++ }
          if (terms.length > 1 && hit === terms.length) score += 6
          if (score <= 0) continue
          const existing = candidates.get(rel)
          if (existing) existing.score += score
          else {
            const { meta } = parseEntry(text)
            const known = indexEntries(text).find((x) => x.target === rel)
            candidates.set(rel, {
              score,
              entry: {
                title: (known && known.title) || meta.name || rel.replace(/\.md$/, ''),
                target: rel,
                summary: (known && known.summary) || meta.description || ''
              }
            })
          }
        }
      }
    }

    const scored = [...candidates.values()].sort(
      (a, b) => b.score - a.score || a.entry.target.localeCompare(b.entry.target)
    )
    const results = []
    // 标题与摘要一律以索引为**唯一事实源**：正文回落命中的条目也可能已经有索引登记，
    // 那里存的是人工维护的中文标题与摘要。meta.name 只在索引里确实没有它时兜底。
    const indexed = new Map(idx.entries.map((e) => [e.target, e]))
    for (const hit of scored.slice(0, cap)) {
      const full = read(scope, hit.entry.target.replace(/\.md$/, ''), cwd)
      const canon = indexed.get(hit.entry.target)
      results.push({
        title: (canon && canon.title) || hit.entry.title,
        target: hit.entry.target,
        summary: (canon && canon.summary) || hit.entry.summary,
        section: hit.entry.section,
        score: hit.score,
        body: full.found ? full.body : ''
      })
    }
    return { scope: idx.scope, query: q, terms, total: scored.length, results }
  }

  // ------------------------------------------------------------ AGENTS.md

  function buildBlock(cwd) {
    const g = listIndex('global')
    const lines = []
    lines.push(BLOCK_BEGIN)
    lines.push('## 长期记忆库（dsh-memory 自动维护，请勿手改本区块）')
    lines.push('')
    lines.push(`- 记忆根目录：\`${home}\``)
    lines.push('- 任务涉及本机环境 / 网络 / 工具链 / 用户偏好 / 交付物技巧时，先看下面的全局索引；')
    lines.push('  需要细节时用 `memory_search`（关键词检索，直接返回正文）或 `memory_read`（按名字精确读），')
    lines.push('  也可以直接 `read` 索引里给出的相对路径。**不要整库通读。**')
    lines.push('- 新学到「换项目也成立」的事实 → `memory_write` 且 `scope: "global"`；')
    lines.push('  只对当前工作区成立的 → `scope: "project"`（按会话 cwd 自动归档，不必手填路径）。')
    lines.push('  写入前先 `memory_search` 查重。')
    lines.push('')
    lines.push('### 全局记忆索引')
    lines.push('')
    const headerBytes = Buffer.byteLength(lines.join('\n'), 'utf8')
    const budget = Math.max(256, maxBlockBytes - headerBytes - 128)
    const bodyLines = g.entries.length
      ? g.entries.map((e) => `- [${e.title}](${e.target})${e.summary ? ` — ${e.summary}` : ''}` +
          (e.section && e.section !== DEFAULT_SECTION ? `　\`${e.section}\`` : ''))
      : ['（空——还没有任何记忆条目）']
    const kept = []
    let used = 0
    let truncated = false
    for (const line of bodyLines) {
      const size = Buffer.byteLength(line, 'utf8') + 1
      if (used + size > budget && kept.length > 0) {
        truncated = true
        break
      }
      kept.push(line)
      used += size
    }
    lines.push(kept.join('\n'))
    if (truncated) {
      lines.push(`（索引超预算，此处省略 ${bodyLines.length - kept.length} 条；完整内容见 \`${path.join(home, INDEX_FILE)}\`）`)
    }
    lines.push(BLOCK_END)
    return lines.join('\n')
  }

  function syncAgents(cwd) {
    const block = buildBlock(cwd)
    const current = readText(agentsPath)
    let next
    if (current === null || current.trim() === '') {
      next = `# 全局指令（对每个工作区生效）\n\n${block}\n`
    } else {
      const begin = current.indexOf(BLOCK_BEGIN)
      const end = current.indexOf(BLOCK_END)
      if (begin !== -1 && end !== -1 && end > begin) {
        next = `${current.slice(0, begin)}${block}${current.slice(end + BLOCK_END.length)}`
      } else {
        next = `${current.replace(/\s+$/, '')}\n\n${block}\n`
      }
    }
    if (next !== current) writeTextAtomic(agentsPath, next)
    return { path: agentsPath, changed: next !== current, bytes: Buffer.byteLength(next, 'utf8') }
  }

  return {
    home,
    agentsPath,
    maxBlockBytes,
    scopePaths,
    listIndex,
    listProjects,
    status,
    read,
    write,
    forget,
    search,
    buildBlock,
    syncAgents,
    allEntryFiles
  }
}

function defaultIndexHeader(scope) {
  return scope === 'global'
    ? '# 全局记忆库（跨工作区通用）\n\n这里的条目**与具体项目无关**：换到任何工作区都应该成立。\n\n维护约定：新学到「与机器/网络/工具/用户偏好有关、换项目也成立」的事写到这里。\n'
    : '# 工作区记忆索引\n\n这里只放**只对当前工作区成立**的事实、决策与坑。\n'
}

module.exports = {
  BLOCK_BEGIN,
  BLOCK_END,
  INDEX_FILE,
  PROJECT_INDEX_FILE,
  PROJECTS_DIR,
  PROJECT_KEY_RE,
  ENTRY_TYPES,
  SCOPES,
  DEFAULT_SECTION,
  resolveDshHome,
  slugify,
  projectKey,
  keyFrom,
  sha1,
  parseEntry,
  serializeEntry,
  parseIndex,
  indexEntries,
  sectionRanges,
  allIndexOccurrences,
  findIndexOccurrences,
  tokenize,
  pruneEmptySections,
  upsertIndexEntry,
  repairIndex,
  removeIndexEntry,
  createStore,
  defaultIndexHeader
}
