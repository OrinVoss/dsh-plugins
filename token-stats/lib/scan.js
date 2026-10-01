'use strict'

// ---------------------------------------------------------------- 会话日志解析
//
// DSH 把每个会话写在 `$DSH_HOME/sessions/<workspace-key>/<session-dir>/` 下：
//
//   session.jsonl.zstd      最老的格式（v0/v1/v2）
//   session.v3.jsonl.zstd   格式升级后的副本
//   session.v4.jsonl.zstd   当前格式
//
// 同一目录里可能同时存在多个版本（升级时写新文件、旧文件保留）。**取编号最高的
// 那个**，否则同一会话会被统计两遍。
//
// 目录名不一定是 `session-<uuid>`：实测有大量纯 UUID 目录，所以这里只按
// 「文件所在目录」分组，不依赖目录命名。
//
// 文件本身是**连续 zstd 帧**拼接（每帧一次追加写入）。Node 的
// `zstdDecompressSync` 只解第一帧，所以必须自己切帧：扫描帧魔数
// `28 B5 2F FD`，对每个候选边界尝试解压，成功者即为一帧。

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const FRAME_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const LOG_NAME_RE = /^session(?:\.v(\d+))?\.jsonl\.zstd$/

function findMagic(buf, from) {
  for (let i = from; i + 4 <= buf.length; i++) {
    if (buf[i] === FRAME_MAGIC[0] && buf[i + 1] === FRAME_MAGIC[1] &&
        buf[i + 2] === FRAME_MAGIC[2] && buf[i + 3] === FRAME_MAGIC[3]) return i
  }
  return -1
}

/** 逐帧解压一个「连续 zstd 帧」缓冲，返回拼起来的 UTF-8 文本。 */
function inflateFrames(buf) {
  let pos = findMagic(buf, 0)
  if (pos < 0) return ''
  const parts = []
  while (pos >= 0 && pos < buf.length) {
    let cand = findMagic(buf, pos + 4)
    let advanced = false
    // 压缩数据内部也可能偶然出现魔数，因此逐个候选边界试解压：
    // 只有真正能解出一个完整帧的边界才被接受。
    for (;;) {
      const sliceEnd = cand < 0 ? buf.length : cand
      try {
        parts.push(zlib.zstdDecompressSync(buf.subarray(pos, sliceEnd)))
        pos = cand
        advanced = true
        break
      } catch (err) {
        if (cand < 0) { pos = -1; break }
        cand = findMagic(buf, cand + 4)
        if (cand < 0) {
          try {
            parts.push(zlib.zstdDecompressSync(buf.subarray(pos)))
          } catch (_) { /* 尾部残帧，丢弃 */ }
          pos = -1
        }
      }
    }
    if (!advanced) break
  }
  return Buffer.concat(parts).toString('utf8')
}

/** 同一目录里选版本号最高的日志文件。 */
function pickLogFile(names) {
  let best = null
  let bestVersion = -1
  for (const name of names) {
    const m = LOG_NAME_RE.exec(name)
    if (!m) continue
    const version = m[1] === undefined ? 0 : Number(m[1])
    if (version > bestVersion) { bestVersion = version; best = name }
  }
  return best
}

function walkLogDirs(root) {
  const byDir = new Map()
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) { continue }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { stack.push(full); continue }
      if (!LOG_NAME_RE.test(entry.name)) continue
      let list = byDir.get(dir)
      if (list === undefined) { list = []; byDir.set(dir, list) }
      list.push(entry.name)
    }
  }
  return byDir
}

function localDayKey(ms) {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const YIELD_EVERY = 16

function yieldToLoop() {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * 扫描整个会话库。
 *
 * 全量扫描在本机约 6 秒，且解压是同步 CPU 活儿；宿主是单进程，整段跑完会让
 * Web 界面卡住，所以每处理十几个会话就 `setImmediate` 让出一次事件循环。
 *
 * @param {string} home DSH_HOME
 * @param {{ onProgress?: (done: number, total: number) => void }} [options]
 * @returns {Promise<{
 *   scannedAt: number, scanMs: number,
 *   roots: number, files: number, failed: number,
 *   sessions: Array<object>, steps: Array<object>,
 *   range: { from: number|null, to: number|null }
 * }>}
 */
async function scanSessions(home, options) {
  const started = Date.now()
  const root = path.join(home, 'sessions')
  const onProgress = (options && options.onProgress) || null
  const byDir = walkLogDirs(root)

  const sessions = []
  const steps = []
  let files = 0
  let failed = 0
  let from = null
  let to = null

  const dirs = [...byDir.keys()]
  for (let i = 0; i < dirs.length; i++) {
    const dir = dirs[i]
    const names = byDir.get(dir).slice().sort()
    const chosen = pickLogFile(names)
    if (chosen === null) continue
    const file = path.join(dir, chosen)
    files++
    let text
    try {
      text = inflateFrames(fs.readFileSync(file))
    } catch (_) {
      failed++
      continue
    }
    if (text === '') { failed++; continue }

    let header = null
    let sessionSteps = 0
    const lines = text.split('\n')
    for (const line of lines) {
      if (line === '' || line.charCodeAt(0) !== 0x7b) continue // 只处理 '{' 开头的行
      if (header === null && line.indexOf('"type":"session"') >= 0) {
        try {
          const o = JSON.parse(line)
          if (o.type === 'session') header = o
        } catch (_) { /* 忽略坏行 */ }
      }
      const at = line.indexOf('"assistant/message"')
      if (at < 0) continue
      let record
      try { record = JSON.parse(line) } catch (_) { continue }
      if (record.type !== 'assistant/message') continue
      const data = record.data
      const usage = data && data.usage
      if (!usage) continue
      const source = (data.message && data.message.source) || {}
      const input = usage.inputTokens || 0
      const output = usage.outputTokens || 0
      const cache = usage.cacheReadTokens || 0
      const time = typeof record.time === 'number' ? record.time : header && header.createdAt
      if (typeof time !== 'number') continue
      if (from === null || time < from) from = time
      if (to === null || time > to) to = time
      sessionSteps++
      steps.push({
        t: time,
        day: localDayKey(time),
        model: source.model || 'unknown',
        provider: source.provider || 'unknown',
        input,
        output,
        cache
      })
    }

    const fallbackId = path.basename(dir)
    const sessionId = (header && header.id) || fallbackId
    for (let k = steps.length - sessionSteps; k < steps.length; k++) steps[k].session = sessionId

    sessions.push({
      id: sessionId,
      dir,
      file: chosen,
      cwd: (header && header.cwd) || null,
      preset: (header && header.agentPreset) || null,
      version: (header && header.version) !== undefined ? header.version : null,
      createdAt: (header && header.createdAt) || null,
      steps: sessionSteps,
      bytes: 0
    })
    if (sessionSteps === 0) sessions[sessions.length - 1].empty = true

    if (onProgress !== null && (i % 25 === 0 || i === dirs.length - 1)) onProgress(i + 1, dirs.length)
    if (i % YIELD_EVERY === YIELD_EVERY - 1) await yieldToLoop()
  }

  return {
    scannedAt: Date.now(),
    scanMs: Date.now() - started,
    roots: dirs.length,
    files,
    failed,
    sessions,
    steps,
    range: { from, to }
  }
}

module.exports = { scanSessions, inflateFrames, pickLogFile, localDayKey, LOG_NAME_RE }
