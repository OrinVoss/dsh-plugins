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
// 文件本身是**连续 zstd 帧**拼接（每帧一次追加写入）。Node 的 zstd 解压每次只吃一帧
// （sync 与 stream 实测都只解第一帧），所以只能自己切帧、一帧一次调用。
//
// 2026-11-04 性能重写（本机 1164 个会话 / 505MB / 66.5k 步 / ~17 万帧）：
//   1. **精确帧边界**：按 zstd 帧结构（Frame_Header_Descriptor → 块头 → 校验位）
//      直接算出每帧结尾，取代"扫魔数 + 逐个候选试解压"的试错法（切帧 143ms）。
//   2. **只解码命中的行**：不再整份拼字符串再 split('\n')，而是在解压后的 Buffer 上
//      indexOf 标记，只把那一行 toString('utf8') 出来 JSON.parse。
//   3. **单文件增量缓存**（`$DSH_HOME/token-stats/scan-cache.json`）：按 (size, mtimeMs)
//      判断，没变的会话直接复用上次结果——刷新面板是热路径，这条决定体验（139ms）。
//   4. **试过又撤掉的**：worker_threads 并行。实测 Node 的 zstd 解压在不同线程间互相争用
//      （4 个 worker 只有 ~1.2× 加速），而每帧一次调用的开销才是大头；加一池子只多了
//      130 行代码和失败面，已回退成「同步解析 + 每 8 个文件让出事件循环」。
//
// 本机实测（1164 会话 / 453MB / 66.5k 步）：**刷新 19.2s → 221ms**（全命中缓存；聊天中
// 只有当前会话文件变，仍是毫秒级）；冷扫描 ~17s（受 Node zstd 每帧调用开销限制）。

const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const zlib = require('zlib')

const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const LOG_NAME_RE = /^session(?:\.v(\d+))?\.jsonl\.zstd$/
/** 单文件解析缓存的格式版本（与宿主聚合缓存 cache.json 各管各的）。 */
const SCAN_CACHE_VERSION = 1

const SESSION_MARKER = Buffer.from('"type":"session"')
const ASSISTANT_MARKER = Buffer.from('"assistant/message"')

// ------------------------------------------------------------ zstd 帧边界

/**
 * 纯函数：按 zstd 帧结构算出从 `pos` 开始的这一帧的**结束偏移**（不含）。
 *
 * 为什么不"扫下一个魔数再试解压"：压缩数据内部也可能恰好出现魔数，只能靠逐个候选
 * 试解压来排除；于是每帧都可能白解压好几次。帧结构本身是自描述的，直接读完
 * 帧头（Frame_Header_Descriptor / Window_Descriptor / Dictionary_ID / Frame_Content_Size）
 * 与块头（3 字节：last / type / size）就能一步算出结尾 —— O(1)，零试错。
 *
 * @param {Buffer} buf - 缓冲区。
 * @param {number} pos - 帧起始（魔数位置）。
 * @returns {number} 结束偏移；结构不合法或数据不完整时返回 -1。
 */
function frameEnd(buf, pos) {
  if (pos < 0 || pos + 4 > buf.length) return -1
  for (let i = 0; i < 4; i++) if (buf[pos + i] !== FRAME_MAGIC[i]) return -1
  let p = pos + 4
  if (p >= buf.length) return -1
  const desc = buf[p]
  p += 1
  const fcsFlag = desc >> 6
  const singleSegment = (desc >> 5) & 1
  const hasChecksum = (desc >> 2) & 1
  const dictFlag = desc & 3
  if (!singleSegment) {
    if (p >= buf.length) return -1
    p += 1 // Window_Descriptor
  }
  const dictSize = [0, 1, 2, 4][dictFlag]
  if (p + dictSize > buf.length) return -1
  p += dictSize
  const fcsSize = fcsFlag === 0 ? (singleSegment ? 1 : 0) : (fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8)
  if (p + fcsSize > buf.length) return -1
  p += fcsSize
  for (;;) {
    if (p + 3 > buf.length) return -1
    const header = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16)
    p += 3
    const last = header & 1
    const type = (header >> 1) & 3
    const size = header >>> 3
    if (type === 3) return -1 // reserved block type ⇒ 不是合法帧
    const take = type === 1 ? 1 : size // RLE 块体只有 1 字节
    if (p + take > buf.length) return -1
    p += take
    if (last !== 0) break
  }
  if (hasChecksum !== 0) {
    if (p + 4 > buf.length) return -1
    p += 4
  }
  return p
}

/**
 * 纯函数：把「连续 zstd 帧」缓冲切成 `[start, end)` 区间列表。
 * 遇到坏帧就跳过它、从下一个魔数继续（尾部残缺帧自然被跳过）。
 */
function splitFrames(buf) {
  const out = []
  let pos = buf.indexOf(FRAME_MAGIC)
  while (pos >= 0) {
    const end = frameEnd(buf, pos)
    if (end < 0) {
      const next = buf.indexOf(FRAME_MAGIC, pos + 4)
      if (next < 0) break
      pos = next
      continue
    }
    out.push([pos, end])
    pos = buf.indexOf(FRAME_MAGIC, end)
  }
  return out
}

/** 逐帧同步解压，返回拼起来的 Buffer（坏帧跳过）。 */
function inflateFramesBuffer(buf) {
  const parts = []
  for (const [start, end] of splitFrames(buf)) {
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(start, end)))
    } catch (_) { /* 跳过坏帧 */ }
  }
  return Buffer.concat(parts)
}

/** 逐帧同步解压并转成文本（保留的旧 API，自检与一次性脚本用）。 */
function inflateFrames(buf) {
  return inflateFramesBuffer(buf).toString('utf8')
}

// ------------------------------------------------------------ 行级抽取

/** 含 `at` 的那一行的 [start, end) 边界（不含换行符本身）。 */
function lineBounds(buf, at) {
  const start = buf.lastIndexOf(0x0a, at) + 1
  let end = buf.indexOf(0x0a, at)
  if (end < 0) end = buf.length
  return [start, end]
}

/**
 * 纯函数：从**解压后的缓冲**里抽会话头与所有 usage 步骤。
 *
 * 不把整份日志转成字符串再 split——本机 505MB 压缩数据解开后是 1.6GB 文本，
 * 全量 UTF-8 解码 + 逐行 split 是主要开销之一。这里只在 Buffer 上 indexOf 标记，
 * 命中才解码那一行。
 *
 * @param {Buffer} buf - 解压后的日志。
 * @returns {{ header: object|null, steps: Array<Array<number|string>> }}
 *   steps 每项是紧凑数组 `[time, model, provider, input, output, cache]`
 *   （缓存里也用这个形状，省体积）。
 */
function parseLogBuffer(buf) {
  let header = null
  const headerAt = buf.indexOf(SESSION_MARKER)
  if (headerAt >= 0) {
    const [start, end] = lineBounds(buf, headerAt)
    try {
      const obj = JSON.parse(buf.toString('utf8', start, end))
      if (obj && obj.type === 'session') header = obj
    } catch (_) { /* 坏行忽略 */ }
  }

  const steps = []
  let from = 0
  for (;;) {
    const at = buf.indexOf(ASSISTANT_MARKER, from)
    if (at < 0) break
    const [start, end] = lineBounds(buf, at)
    from = end + 1 // 同一行只处理一次
    if (start >= end || buf[start] !== 0x7b) continue // 只处理 '{' 开头的行
    let record
    try {
      record = JSON.parse(buf.toString('utf8', start, end))
    } catch (_) { continue }
    if (!record || record.type !== 'assistant/message') continue
    const data = record.data
    const usage = data && data.usage
    if (!usage) continue
    const source = (data.message && data.message.source) || {}
    const time = typeof record.time === 'number' ? record.time : (header && header.createdAt)
    if (typeof time !== 'number') continue
    steps.push([
      time,
      source.model || 'unknown',
      source.provider || 'unknown',
      usage.inputTokens || 0,
      usage.outputTokens || 0,
      usage.cacheReadTokens || 0
    ])
  }
  return { header, steps }
}

// ------------------------------------------------------------ 目录枚举

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

// ------------------------------------------------------------ 单文件缓存

function readScanCache(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed && parsed.version === SCAN_CACHE_VERSION && parsed.files && typeof parsed.files === 'object') return parsed
  } catch (_) { /* 首次运行没有缓存，正常 */ }
  return null
}

function writeScanCache(file, cache) {
  const text = JSON.stringify(cache)
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, text, 'utf8')
    fs.renameSync(tmp, file)
  } catch (_) {
    try { fs.unlinkSync(tmp) } catch (e) { /* best effort */ }
  }
}

// ------------------------------------------------------------ 解析执行

/** 单文件同步解析（扫描时逐文件调用）。 */
function parseOneFileSync(file) {
  const stat = fs.statSync(file)
  const plain = inflateFramesBuffer(fs.readFileSync(file))
  const parsed = parseLogBuffer(plain)
  return { file, size: stat.size, mtimeMs: Math.round(stat.mtimeMs), header: parsed.header, steps: parsed.steps }
}

// ------------------------------------------------------------ 扫描

/**
 * 扫描整个会话库。
 *
 * @param {string} home - DSH_HOME。
 * @param {object} [options]
 * @param {string|null} [options.cacheFile] - 单文件解析缓存路径
 *   （默认 `<home>/token-stats/scan-cache.json`；传 null 关闭缓存）。
 * @param {(done: number, total: number) => void} [options.onProgress]
 * @returns {Promise<object>} 同旧版字段，另加 `reused` / `parsed`（缓存命中数 / 真解析数）。
 */
async function scanSessions(home, options) {
  const started = Date.now()
  const opts = options || {}
  const root = path.join(home, 'sessions')
  const onProgress = opts.onProgress || null
  const cacheFile = opts.cacheFile === null ? null : (opts.cacheFile || path.join(home, 'token-stats', 'scan-cache.json'))

  const byDir = walkLogDirs(root)
  const prev = cacheFile === null ? null : readScanCache(cacheFile)
  const next = { version: SCAN_CACHE_VERSION, files: {} }

  const dirs = [...byDir.keys()].sort()
  const tasks = []
  for (const dir of dirs) {
    const names = byDir.get(dir).slice().sort()
    const chosen = pickLogFile(names)
    if (chosen === null) continue
    tasks.push({ dir, chosen, file: path.join(dir, chosen) })
  }

  const entries = new Map() // file → 解析结果（来自缓存或本轮解析）
  let failed = 0
  let reused = 0
  let parsed = 0
  const todo = []

  // 先 stat 一遍（并发），命中的直接复用，其余进 todo
  let cursor = 0
  const CONCURRENCY = 16
  const statWorker = async () => {
    while (cursor < tasks.length) {
      const task = tasks[cursor]
      cursor += 1
      try {
        const stat = await fsp.stat(task.file)
        const cached = prev && prev.files[task.file]
        if (cached && cached.size === stat.size && cached.mtimeMs === Math.round(stat.mtimeMs)) {
          reused += 1
          entries.set(task.file, cached)
        } else {
          todo.push({ file: task.file, size: stat.size })
        }
      } catch (_) {
        failed += 1
      }
      if (onProgress !== null && (cursor % 50 === 0 || cursor === tasks.length)) onProgress(cursor, tasks.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length || 1) }, statWorker))

  // 真解析：同步解析 + 每 8 个让出一次事件循环（宿主是单进程，别让界面卡住）。
  //
  // 为什么不上 worker_threads 并行：实测 Node 的 zstd 解压在不同线程间**互相争用**
  // （4 个 worker 只有 ~1.2× 加速，而每帧一次调用的开销占大头），加一池子反而增加
  // 失败面与 130 行代码。真正决定体验的是下面的单文件缓存。
  const todoFiles = todo.map((t) => t.file)
  for (let i = 0; i < todoFiles.length; i++) {
    const file = todoFiles[i]
    try {
      const entry = parseOneFileSync(file)
      entries.set(file, entry)
      next.files[file] = entry
      parsed += 1
    } catch (_) {
      failed += 1
    }
    if (i % 8 === 7) await new Promise((resolve) => setImmediate(resolve))
  }
  for (const [file, entry] of entries) {
    if (next.files[file] === undefined) next.files[file] = entry // 缓存命中的也写回下一版
  }

  // 按目录序组装，保证同一份数据每次扫描顺序一致（"最近会话"等展示才稳定）
  const sessions = []
  const steps = []
  let from = null
  let to = null
  for (const dir of dirs) {
    const names = byDir.get(dir).slice().sort()
    const chosen = pickLogFile(names)
    if (chosen === null) continue
    const file = path.join(dir, chosen)
    const entry = entries.get(file)
    if (!entry) continue
    const header = entry.header || null
    const sessionId = (header && header.id) || path.basename(dir)
    for (const step of entry.steps || []) {
      const time = step[0]
      steps.push({
        t: time,
        day: localDayKey(time),
        model: step[1],
        provider: step[2],
        input: step[3],
        output: step[4],
        cache: step[5],
        session: sessionId
      })
      if (from === null || time < from) from = time
      if (to === null || time > to) to = time
    }
    const sessionSteps = (entry.steps || []).length
    sessions.push({
      id: sessionId,
      dir,
      file: chosen,
      cwd: (header && header.cwd) || null,
      preset: (header && header.agentPreset) || null,
      version: (header && header.version) !== undefined ? header.version : null,
      createdAt: (header && header.createdAt) || null,
      steps: sessionSteps,
      bytes: entry.size || 0,
      ...(sessionSteps === 0 ? { empty: true } : {})
    })
  }

  if (cacheFile !== null) {
    const prevCount = prev && prev.files ? Object.keys(prev.files).length : -1
    const nextCount = Object.keys(next.files).length
    if (parsed > 0 || prevCount !== nextCount) writeScanCache(cacheFile, next)
  }

  return {
    scannedAt: Date.now(),
    scanMs: Date.now() - started,
    roots: dirs.length,
    files: tasks.length,
    failed,
    reused,
    parsed,
    sessions,
    steps,
    range: { from, to }
  }
}

module.exports = {
  scanSessions,
  inflateFrames,
  inflateFramesBuffer,
  frameEnd,
  splitFrames,
  parseLogBuffer,
  parseOneFileSync,
  pickLogFile,
  localDayKey,
  LOG_NAME_RE,
  SCAN_CACHE_VERSION
}
