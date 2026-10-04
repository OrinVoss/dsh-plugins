'use strict'

// 记忆库体检（只读 CLI）：把「该维护了」的信号打成人能读的报告。
//
//   node memcheck.cjs [memoryHome] [--json] [--threshold 0.5] [--limit 12] [--stale-days 180] [--strict]
//
// 与 `lintmemory.cjs` 的分工：
//   lint     —— 机械一致性，**能判对错**，错了退出码 1（字段/索引/摘要/双链/预算）。
//   memcheck —— 语义信号，**只提示不动手**：待合并候选、陈旧条目、作用域可疑、孤岛条目。
//                默认退出码 0；带 `--strict` 时若有任何待办则退出 1（给"该维护了"当门禁用）。
//
// 记忆库不存在（换机器、未初始化）时跳过且退出码 0。

const fs = require('node:fs')
const path = require('node:path')
const store = require('./lib/store')
const health = require('./lib/health')

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const positional = args.filter((a) => !a.startsWith('--'))
function num(name, fallback) {
  const i = args.indexOf(name)
  if (i === -1 || !args[i + 1]) return fallback
  const n = Number(args[i + 1])
  return Number.isFinite(n) ? n : fallback
}

const home = path.resolve(
  positional[0] || process.env.DSH_MEMORY_HOME || path.join(store.resolveDshHome(), 'memory')
)
if (!fs.existsSync(home)) {
  console.log(`\n记忆库不存在，跳过体检：${home}\n`)
  process.exit(0)
}

const report = health.analyze({
  home,
  agentsPath: path.join(path.dirname(home), 'AGENTS.md'),
  maxBlockBytes: num('--max-block-bytes', 32768),
  threshold: num('--threshold', health.DEFAULT_THRESHOLD),
  limit: num('--limit', health.DEFAULT_LIMIT),
  staleDays: num('--stale-days', health.DEFAULT_STALE_DAYS)
})
const v = health.verdict(report)

if (flags.has('--json')) {
  console.log(JSON.stringify({ report, verdict: v }, null, 2))
} else {
  const pct = report.budget.pct
  console.log(`\n记忆库体检：${home}`)
  console.log(`  条目      ${report.counts.total}（全局 ${report.counts.global} / 工作区 ${report.counts.project}，${report.counts.projects} 个工作区）`)
  console.log(`  注入区块  ${report.budget.blockBytes} / ${report.budget.maxBlockBytes} 字节${pct === null ? '' : `（${pct}%）`}${report.budget.truncated ? '  ⚠ 已被截断' : ''}`)
  console.log(`  分组      ${report.counts.bySection.map((s) => `${s.title}(${s.count})`).join('  ')}`)
  console.log(`  类型      ${Object.entries(report.counts.byType).map(([k, n]) => `${k}(${n})`).join('  ')}`)
  console.log(`  上次索引改动  ${report.budget.indexUpdatedAt || '–'}`)

  console.log(`\n  待合并候选（正文包含度 ≥ ${report.mergeCandidates.threshold}）：${report.mergeCandidates.count} 对`)
  for (const p of report.mergeCandidates.pairs) {
    console.log(`    ${String(Math.round(p.containment * 100)).padStart(3)}%  ${p.a}  ↔  ${p.b}`)
  }
  if (!report.mergeCandidates.count) console.log('    （无）')

  console.log(`\n  ${report.stale.days} 天未更新：${report.stale.count} 条`)
  for (const e of report.stale.entries) console.log(`    ${e.updatedAt}  ${e.rel}`)

  console.log(`\n  作用域待确认：${report.boundarySuspects.length} 条`)
  for (const b of report.boundarySuspects) console.log(`    ${b.rel} —— ${b.why}`)

  if (report.stalePaths && report.stalePaths.length) {
    console.log('\n  参考（不算待办）：正文提到的文件路径在本机已测不到——多半是路径写错、已移动，' +
      '或是沙箱看不见的 MSIX/别名；用之前自己验一下')
    for (const s of report.stalePaths) console.log(`    ${s.rel} → ${s.path}`)
  }

  if (report.workspaceHeavy.length) {
    console.log('\n  参考（不算待办）：含工作区专有路径最多的几条，确认它们本来就该是全局条')
    for (const w of report.workspaceHeavy) console.log(`    ${w.rel}（${w.paths} 处路径）`)
  }

  console.log(`\n  没有任何双链的孤岛条目：${report.noLinks.count} 条`)
  for (const r of report.noLinks.entries) console.log(`    ${r}`)

  console.log(v.needsMaintenance ? `\n该维护了：${v.reasons.join('；')}\n` : '\n健康：没有需要处理的事项。\n')
}

if (flags.has('--strict') && v.needsMaintenance) process.exit(1)
