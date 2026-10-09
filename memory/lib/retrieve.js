'use strict'
// L1 的纯逻辑：从检索结果里挑要注入的条目、渲染成一段文本。
// 抽出来是为了可测（selfcheck），host.js 只负责挂钩子与搬运。
//
// 三条硬约束（都是为了不破坏前缀缓存，见 2026-10-09 的缓存实测）：
//   ① 只追加，绝不改写/删除已注入过的消息
//   ② 内容确定性：同一输入 + 同一 seen 集合 → 同一输出
//   ③ 会话内去重：同一条目只注入一次

/** 从会话消息里取"本轮用户说了什么"。工具续跑步骤没有新用户消息 → 返回空串（不注入）。 */
function userTurnText(messages) {
  const list = Array.isArray(messages) ? messages : []
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (!m || m.role !== 'user' || !Array.isArray(m.content)) continue
    const text = m.content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n')
      // 注入块（system-reminder / 指令文件）不该当成"用户说的话"，否则会自己命中自己
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
      .replace(/Instructions from:[\s\S]*$/m, ' ')
      .trim()
    if (text) return text
  }
  return ''
}

/**
 * 从「条目 → 注入时的步号」记账里算出当前哪些算"已见过"。
 *
 * 为什么是窗口而不是永久：DSH 会压缩长会话（compaction/prune 会把消息 shadow 掉），
 * 几十步前注入的内容可能已不在上下文里，永久去重会让知识静默消失。
 * 主触发器其实是压缩事件（host.js 收到 compaction 就清空记账）；这个窗口只是兜底。
 * @param {Map<string, number>} injected target → 注入时的步号
 * @param {number} stepNo 当前步号
 * @param {number} window 多少步内算"见过"；<=0 表示只看压缩、不看窗口
 * @returns {Set<string>}
 */
function seenWithin(injected, stepNo, window) {
  const out = new Set()
  if (!(injected instanceof Map)) return out
  const w = Number.isFinite(window) ? window : 60
  if (w <= 0) return out
  for (const [target, at] of injected) {
    if (Number.isFinite(at) && stepNo - at < w) out.add(target)
  }
  return out
}

/** 一条注入行的渲染（确定性：只依赖 hit 自身） */
function line(hit) {
  return `- ${hit.title || hit.target}（\`${hit.target}\`）—— ${hit.summary || ''}`
}

/**
 * 从多个作用域的检索结果里挑要注入的条目。
 * @param {Array<{scope:string, results:Array}>} groups 按优先级排好的检索结果
 * @param {{seen?:Set<string>, k?:number, minScore?:number, maxBytes?:number}} opts
 */
function pickHits(groups, opts) {
  const o = opts || {}
  const seen = o.seen instanceof Set ? o.seen : new Set()
  const k = Number.isFinite(o.k) && o.k > 0 ? Math.floor(o.k) : 3
  const minScore = Number.isFinite(o.minScore) ? o.minScore : 8
  const maxBytes = Number.isFinite(o.maxBytes) && o.maxBytes > 0 ? Math.floor(o.maxBytes) : 2000
  const picked = []
  let bytes = 0
  for (const g of Array.isArray(groups) ? groups : []) {
    if (!g || !Array.isArray(g.results)) continue
    for (const hit of g.results) {
      if (!hit || !hit.target) continue
      if (Number.isFinite(hit.score) && hit.score < minScore) continue
      if (seen.has(hit.target)) continue
      const size = Buffer.byteLength(line(hit), 'utf8') + 1
      if (bytes + size > maxBytes) continue
      picked.push({ target: hit.target, title: hit.title || hit.target, summary: hit.summary || '', scope: g.scope, score: hit.score })
      bytes += size
      if (picked.length >= k) return { picked, bytes }
    }
  }
  return { picked, bytes }
}

/** 把挑出来的条目渲染成注入文本 */
function renderInjection(picked) {
  if (!Array.isArray(picked) || !picked.length) return ''
  return [
    '（dsh-memory 自动检索：下面几条历史记忆与当前任务相关，供参考；要全文用 `memory_read` 读对应 name）',
    '',
    ...picked.map(line)
  ].join('\n')
}

module.exports = { userTurnText, pickHits, renderInjection, line, seenWithin }
