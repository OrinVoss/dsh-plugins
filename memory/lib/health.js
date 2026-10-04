'use strict'

// 记忆库体检（只读）。
//
// 为什么要有它：`lintmemory.cjs` 守的是**机械一致性**（字段、索引、摘要、双链、预算），
// 但「同一事实散在多条」「项目/全局放错」「久未更新」这些**语义问题**它守不住——
// 那些只能靠定期体检把「该动哪几条」列出来给人判断。
//
// 同一份计算同时服务两处：`memcheck.cjs`（CLI 体检报告）与宿主 `/memory-api/health`
// （设置页顶部的健康度卡片）。所以这里只做纯计算，不写盘、不打印。

const fs = require('node:fs')
const path = require('node:path')
const store = require('./store')

const DEFAULT_STALE_DAYS = 180
const DEFAULT_LIMIT = 12
// 阈值是实测校准过的：把同一段正文写成两条（真重复）时包含度 ≈ 0.95；
// 而"相关但该分开"的条目（machine-env 与它的几个专题条、qwen3.6 与 perf 条）≤ 0.25。
// 两带之间是空的，取 0.5 落在中间——既能抓到真重复，又不会把交叉引用误报成待合并。
const DEFAULT_THRESHOLD = 0.5

/** 归一化正文并切成 4-gram 集合（按字符，对中文友好）。 */
function signature(text, cap) {
  const s = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/[#>*|\-—–:：，。、；;（）()【】[\]{}!！?？"'“”‘’\s]+/g, ' ')
  const chars = Array.from(s).slice(0, cap || 4000)
  const set = new Set()
  for (let i = 0; i + 4 <= chars.length; i++) set.add(chars[i] + chars[i + 1] + chars[i + 2] + chars[i + 3])
  return set
}

/** 包含度 = |A∩B| / min(|A|,|B|)——"短的那条有多少被长的那条覆盖"。 */
function containment(a, b) {
  if (!a.size || !b.size) return 0
  const small = a.size <= b.size ? a : b
  const big = a.size <= b.size ? b : a
  let hit = 0
  for (const g of small) if (big.has(g)) hit++
  return hit / small.size
}

function readEntry(p, home) {
  const raw = fs.readFileSync(p, 'utf8')
  const { meta, body } = store.parseEntry(raw)
  const rel = path.relative(home, p).split(path.sep).join('/')
  return { file: p, rel, meta, body, bytes: Buffer.byteLength(raw, 'utf8') }
}

function walk(dir, out) {
  let items
  try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) { return out }
  for (const item of items) {
    const full = path.join(dir, item.name)
    if (item.isDirectory()) walk(full, out)
    else if (item.isFile() && item.name.endsWith('.md')) out.push(full)
  }
  return out
}

/** 体检主函数。返回结构化结果，字段都有兜底，客户端可直接渲染。 */
function analyze(options) {
  const opts = options || {}
  const home = opts.home
  const agentsPath = opts.agentsPath
  const maxBlockBytes = opts.maxBlockBytes || 0
  const staleDays = Number.isFinite(opts.staleDays) ? opts.staleDays : DEFAULT_STALE_DAYS
  const limit = Number.isFinite(opts.limit) ? opts.limit : DEFAULT_LIMIT
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : DEFAULT_THRESHOLD
  const now = opts.now ? new Date(opts.now) : new Date()

  const files = []
  for (const p of walk(home, [])) {
    const rel = path.relative(home, p).split(path.sep).join('/')
    if (rel === store.INDEX_FILE) continue
    if (/^projects\/[^/]+\/MEMORY\.md$/.test(rel)) continue
    files.push(p)
  }
  const entries = files.map((p) => readEntry(p, home))

  // 注入区块 / 同步状态
  let blockBytes = 0
  let agentsUpdatedAt = null
  let truncated = false
  try {
    const agents = fs.readFileSync(agentsPath, 'utf8')
    const b = agents.indexOf(store.BLOCK_BEGIN)
    const e = agents.indexOf(store.BLOCK_END)
    if (b !== -1 && e > b) {
      const block = agents.slice(b, e + store.BLOCK_END.length)
      blockBytes = Buffer.byteLength(block, 'utf8')
      truncated = /索引超预算/.test(block)
    }
    agentsUpdatedAt = fs.statSync(agentsPath).mtime.toISOString()
  } catch (_) { /* 没有 AGENTS.md 就是 0 */ }
  const budgetPct = maxBlockBytes > 0 ? Math.round((blockBytes / maxBlockBytes) * 100) : null

  // 索引分组统计
  let sectionCounts = []
  let indexUpdatedAt = null
  try {
    const indexPath = path.join(home, store.INDEX_FILE)
    indexUpdatedAt = fs.statSync(indexPath).mtime.toISOString()
    const parsed = store.parseIndex(fs.readFileSync(indexPath, 'utf8'))
    sectionCounts = parsed.sections.map((s) => ({ title: s.title, count: s.entries.length }))
  } catch (_) { /* 空库 */ }

  // 陈旧条目
  const staleBefore = new Date(now.getTime() - staleDays * 24 * 3600 * 1000)
  const stale = entries
    .filter((e) => e.meta.updatedAt && new Date(e.meta.updatedAt) < staleBefore)
    .sort((a, b) => String(a.meta.updatedAt).localeCompare(String(b.meta.updatedAt)))
    .map((e) => ({ rel: e.rel, updatedAt: e.meta.updatedAt }))

  // 没有任何出链的"孤岛"条目
  const noLinks = entries.filter((e) => !/\[\[[^\]]+\]\]/.test(e.body)).map((e) => e.rel)

  // 待合并候选：正文 4-gram 包含度。
  // 关键一步是先按**文档频率**滤掉"到处都是"的公共措辞（本机 / 路径 / 代理 / 记忆库…），
  // 否则中文条目之间随便共享几个高频词就会被误报成重复——实测不加过滤时 72 条里
  // 会报出 12 对，绝大多数只是互相引用（如 machine-env-and-network ↔ 它的几个专题条）。
  const rawSigs = entries.map((e) => signature(`${e.meta.description || ''} ${e.body}`))
  const df = new Map()
  for (const s of rawSigs) for (const g of s) df.set(g, (df.get(g) || 0) + 1)
  const maxDf = Math.max(2, Math.floor(entries.length * 0.25))
  const sigs = rawSigs.map((s) => {
    const out = new Set()
    for (const g of s) if (df.get(g) <= maxDf) out.add(g)
    return out
  })
  const pairs = []
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (sigs[i].size < 40 || sigs[j].size < 40) continue
      const c = containment(sigs[i], sigs[j])
      if (c >= threshold) {
        pairs.push({
          a: entries[i].rel,
          b: entries[j].rel,
          containment: Number(c.toFixed(3)),
          aBytes: entries[i].bytes,
          bBytes: entries[j].bytes
        })
      }
    }
  }
  pairs.sort((x, y) => y.containment - x.containment)

  // 作用域可疑：只把「项目条目里完全没有具体路径」当待办（精确、误报少）。
  // 反方向（全局条目里路径多）只作为参考信息给出来——实测按"路径数 ≥ 3"会把
  // machine-env-and-network、photoshop-com-automation 这类合法全局条全误伤。
  const boundary = []
  const workspaceHeavy = []
  const projectDirs = (() => {
    try {
      return fs.readdirSync(path.join(home, store.PROJECTS_DIR), { withFileTypes: true })
        .filter((d) => d.isDirectory()).map((d) => d.name)
    } catch (_) { return [] }
  })()
  for (const e of entries) {
    const isProject = e.rel.startsWith(store.PROJECTS_DIR + '/')
    const key = isProject ? e.rel.split('/')[1] : null
    const wsName = key ? key.replace(/-[0-9a-f]{16}$/, '') : null
    const paths = Array.from(new Set(e.body.match(/[A-Za-z]:[\\/][^\s`"'）)，,；;]+/g) || []))
    if (isProject) {
      // 项目库里的设计/决策子树天生就没有具体路径（讲的是取舍，不是环境），
      // 对它们做"有没有路径"的启发式永远报 1 条假警报——直接跳过。
      const sub = e.rel.split('/').slice(2, -1).join('/')
      if (/^(decisions|design)(\/|$)/.test(sub)) continue
      const own = wsName ? paths.some((p) => p.includes(wsName)) : paths.length > 0
      if (!own && paths.length === 0) {
        boundary.push({ rel: e.rel, why: '项目条目里没有任何具体路径，可能换工作区也成立（该升全局）' })
      }
    } else if (paths.length >= 5) {
      workspaceHeavy.push({ rel: e.rel, paths: paths.length })
    }
  }

  const byType = {}
  for (const e of entries) byType[e.meta.type || '(缺)'] = (byType[e.meta.type || '(缺)'] || 0) + 1
  const globalCount = entries.filter((e) => !e.rel.startsWith(store.PROJECTS_DIR + '/')).length

  return {
    checkedAt: now.toISOString(),
    home,
    counts: {
      total: entries.length,
      global: globalCount,
      project: entries.length - globalCount,
      projects: projectDirs.length,
      byType,
      bySection: sectionCounts
    },
    budget: { blockBytes, maxBlockBytes, pct: budgetPct, truncated, indexUpdatedAt, agentsUpdatedAt },
    stale: { days: staleDays, count: stale.length, entries: stale.slice(0, limit) },
    noLinks: { count: noLinks.length, entries: noLinks.slice(0, limit) },
    mergeCandidates: { threshold, count: pairs.length, pairs: pairs.slice(0, limit) },
    boundarySuspects: boundary.slice(0, limit),
    workspaceHeavy: workspaceHeavy.sort((a, b) => b.paths - a.paths).slice(0, limit)
  }
}

/**
 * 是否需要维护：给设置页一个红灯/绿灯。
 *
 * 只让**三类确定该动的事**点红灯：注入预算（截断 / >90%）、真重复候选、久未更新。
 * 作用域可疑与孤岛条目只列出来给人看，不点灯——它们是"待确认"，很多本来就对
 * （比如本工作区的两条决策记忆确实没有具体路径），点灯会变成永远消不掉的红点。
 */
function verdict(report) {
  const reasons = []
  if (report.budget.truncated) reasons.push('注入区块已被截断')
  else if (report.budget.pct !== null && report.budget.pct > 90) reasons.push(`注入区块已用 ${report.budget.pct}%`)
  if (report.mergeCandidates.count > 0) reasons.push(`${report.mergeCandidates.count} 对条目疑似重复`)
  if (report.stale.count > 0) reasons.push(`${report.stale.count} 条 ${report.stale.days} 天未更新`)
  return { needsMaintenance: reasons.length > 0, reasons }
}

module.exports = { analyze, verdict, signature, containment, DEFAULT_STALE_DAYS, DEFAULT_LIMIT, DEFAULT_THRESHOLD }
