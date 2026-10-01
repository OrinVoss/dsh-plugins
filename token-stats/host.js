'use strict'

// ---------------------------------------------------------------- dsh-token-stats
//
// DSH 的 Token 用量统计报表插件（宿主半边）。
//
// 数据来源：`$DSH_HOME/sessions/**/session*.jsonl.zstd`。每个模型调用步都会落一条
// `assistant/message`，其中 `data.usage` 记着 inputTokens / outputTokens /
// cacheReadTokens，`data.message.source` 记着 provider / model。这个插件把它们
// 汇总成「按天 × 按模型」的矩阵，供客户端报表页画热力图、趋势图和环形图。
//
// 设计取舍：
// - **全量扫一遍约 6 秒**（483 个会话、13k+ 步）。所以结果落盘缓存
//   （`$DSH_HOME/token-stats/cache.json`），启动/首屏先给缓存，再后台刷新。
// - 扫描本身是异步分批的（见 lib/scan.js），不会长时间占住宿主事件循环。
// - HTTP 只读；报表是纯展示，不写任何会话数据。

const fs = require('fs')
const os = require('os')
const path = require('path')

const { scanSessions } = require('./lib/scan')

const DEFAULT_TTL_MS = 5 * 60 * 1000

// 聚合逻辑的版本号。改动 aggregate / 别名规则时 +1 —— 否则插件升级后
// 磁盘上那份用旧逻辑算出来的缓存仍然"新鲜"，会继续端出没归并的数据。
const CACHE_VERSION = 2

function resolveHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

// ---------------------------------------------------------------- 聚合

function emptyBucket() {
  return { input: 0, output: 0, cache: 0, total: 0, steps: 0 }
}

function addStep(bucket, step) {
  bucket.input += step.input
  bucket.output += step.output
  bucket.cache += step.cache
  bucket.total += step.input + step.output + step.cache
  bucket.steps += 1
}

function dayKeyFromTime(ms) {
  const d = new Date(ms)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** 把 from..to 之间的日期补全成连续序列（画图不能跳日）。 */
function enumerateDays(fromDay, toDay) {
  const out = []
  const start = new Date(`${fromDay}T00:00:00`)
  const end = new Date(`${toDay}T00:00:00`)
  for (let d = start; d.getTime() <= end.getTime(); d.setDate(d.getDate() + 1)) {
    out.push(dayKeyFromTime(d.getTime()))
  }
  return out
}

// 模型别名 / 归并。
//
// DSH 会给即将下线的模型加 `-expires-on-MMDD` 后缀，同一个模型因此会在日志里
// 留下前后两个名字。不归并的话，环形图与趋势图会把它拆成两条，看起来像两个
// 不同的模型在跑。
const DEFAULT_MODEL_ALIASES = {
  // DeepSeek-V4.1-Flash：9/8–9/9 用带过期日的临时名，9/10 起换成正式 id。
  // 实测两段首尾相接（9/9 结束、9/10 开始），就是同一个模型。
  'deepseek-v4.1-flash-expires-on-0910': 'deepseek-v4.1-flash',
  'deepseek-flash': 'deepseek-v4.1-flash'
}

function canonicalModel(name, aliases) {
  if (aliases !== undefined && Object.prototype.hasOwnProperty.call(aliases, name)) return aliases[name]
  // 兜底：任何 `<name>-expires-on-MMDD` 都归到 `<name>`
  const m = /^(.+)-expires-on-\d{4}$/.exec(name)
  return m === null ? name : m[1]
}

function aggregate(scan, aliases) {
  const steps = scan.steps
  const totals = emptyBucket()
  const modelMap = new Map()
  const dayMap = new Map()
  const sessionMap = new Map()
  const workspaceMap = new Map()

  const sessionMeta = new Map()
  for (const s of scan.sessions) {
    sessionMeta.set(s.id, s)
    sessionMap.set(s.id, { id: s.id, cwd: s.cwd, steps: 0, total: 0, first: null, last: null })
  }

  for (const step of steps) {
    addStep(totals, step)

    const modelName = canonicalModel(step.model, aliases)

    let bucket = modelMap.get(modelName)
    if (bucket === undefined) {
      bucket = { model: modelName, provider: step.provider, input: 0, output: 0, cache: 0, total: 0, steps: 0 }
      modelMap.set(modelName, bucket)
    }
    addStep(bucket, step)

    let day = dayMap.get(step.day)
    if (day === undefined) {
      day = emptyBucket()
      day.day = step.day
      day.models = {}
      dayMap.set(step.day, day)
    }
    addStep(day, step)
    // 每个模型在当天的完整明细（不只是总量）：客户端切换时间范围时要用它
    // 精确重算「按模型」的 input/output/cache/steps，而不是拿总量去按比例估。
    let modelDay = day.models[modelName]
    if (modelDay === undefined) {
      modelDay = emptyBucket()
      day.models[modelName] = modelDay
    }
    addStep(modelDay, step)

    const session = sessionMap.get(step.session)
    if (session !== undefined) {
      const stepTotal = step.input + step.output + step.cache
      session.steps += 1
      session.total += stepTotal
      if (session.first === null || step.t < session.first) session.first = step.t
      if (session.last === null || step.t > session.last) session.last = step.t
      const meta = sessionMeta.get(step.session)
      const cwd = (meta && meta.cwd) || '(未知工作区)'
      let ws = workspaceMap.get(cwd)
      if (ws === undefined) {
        ws = { cwd, label: path.basename(cwd) || cwd, sessions: 0, steps: 0, total: 0 }
        workspaceMap.set(cwd, ws)
      }
      ws.steps += 1
      ws.total += stepTotal
    }
  }

  // 工作区会话数单独数一遍（上面按步累加会重复计）
  for (const s of scan.sessions) {
    const cwd = s.cwd || '(未知工作区)'
    let ws = workspaceMap.get(cwd)
    if (ws === undefined) {
      ws = { cwd, label: path.basename(cwd) || cwd, sessions: 0, steps: 0, total: 0 }
      workspaceMap.set(cwd, ws)
    }
    ws.sessions += 1
  }

  const fromDay = scan.range.from === null ? null : dayKeyFromTime(scan.range.from)
  const toDay = scan.range.to === null ? null : dayKeyFromTime(scan.range.to)
  const allDays = fromDay !== null && toDay !== null ? enumerateDays(fromDay, toDay) : []
  const days = allDays.map((key) => {
    const found = dayMap.get(key)
    const bucket = found || Object.assign(emptyBucket(), { day: key, models: {} })
    return {
      day: key,
      input: bucket.input,
      output: bucket.output,
      cache: bucket.cache,
      total: bucket.total,
      steps: bucket.steps,
      models: bucket.models || {}
    }
  })

  const models = [...modelMap.values()].sort((a, b) => b.total - a.total)
  const workspaces = [...workspaceMap.values()].sort((a, b) => b.total - a.total)
  const sessionList = [...sessionMap.values()]
    .filter((s) => s.steps > 0)
    .sort((a, b) => b.total - a.total)

  return {
    generatedAt: Date.now(),
    scanMs: scan.scanMs,
    source: {
      sessions: scan.sessions.length,
      files: scan.files,
      failed: scan.failed,
      steps: scan.steps.length,
      from: scan.range.from,
      to: scan.range.to
    },
    totals: {
      input: totals.input,
      output: totals.output,
      cache: totals.cache,
      total: totals.total,
      steps: totals.steps,
      sessions: sessionList.length
    },
    models,
    days,
    workspaces,
    sessions: sessionList
  }
}

// ---------------------------------------------------------------- 扫描状态

function createScanner(cfg, logger) {
  const home = resolveHome()
  const cacheFile = path.join(home, 'token-stats', 'cache.json')
  const state = {
    data: null,
    scannedAt: 0,
    scanning: false,
    lastError: null,
    lastMs: 0
  }
  let inflight = null

  function readCache() {
    try {
      const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
      if (parsed === null || parsed.version !== CACHE_VERSION) return null
      const data = parsed.data
      if (data && data.totals && Array.isArray(data.days)) return data
    } catch (_) { /* 首次运行没有缓存，正常 */ }
    return null
  }

  function writeCache(data) {
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
      fs.writeFileSync(cacheFile, JSON.stringify({ version: CACHE_VERSION, data }), 'utf8')
    } catch (err) {
      logger.warn('dsh-token-stats: 缓存写入失败（不影响功能）: %o', err)
    }
  }

  async function runScan() {
    state.scanning = true
    const started = Date.now()
    try {
      const scan = await scanSessions(home)
      const data = aggregate(scan, cfg.modelAliases)
      state.data = data
      state.scannedAt = Date.now()
      state.lastMs = Date.now() - started
      state.lastError = null
      writeCache(data)
      logger.info(
        'dsh-token-stats: 扫描完成 %d 个会话 / %d 步 / %d 个模型，用时 %dms',
        scan.sessions.length, scan.steps.length, data.models.length, state.lastMs
      )
      return data
    } catch (err) {
      state.lastError = String((err && err.message) || err)
      logger.warn('dsh-token-stats: 扫描失败: %o', err)
      return state.data
    } finally {
      state.scanning = false
    }
  }

  function ensureScan() {
    if (inflight !== null) return inflight
    inflight = runScan().finally(() => { inflight = null })
    return inflight
  }

  /** 缓存新鲜度：TTL 之内直接给缓存，避免每次开页面都全量重扫。 */
  function isFresh() {
    return state.data !== null && Date.now() - state.scannedAt < cfg.cacheTtlMs
  }

  function loadCache() {
    const cached = readCache()
    if (cached !== null && state.data === null) {
      state.data = cached
      state.scannedAt = cached.generatedAt || 0
      logger.info('dsh-token-stats: 已载入磁盘缓存（%d 会话 / %d 步）',
        cached.source ? cached.source.sessions : 0, cached.source ? cached.source.steps : 0)
    }
    return cached
  }

  function status() {
    return {
      scanning: state.scanning,
      scannedAt: state.scannedAt,
      scanMs: state.lastMs,
      lastError: state.lastError,
      hasData: state.data !== null,
      cacheFile
    }
  }

  return { home, cacheFile, state, status, ensureScan, isFresh, loadCache, get data() { return state.data } }
}

// ---------------------------------------------------------------- HTTP

function sendJson(res, code, payload) {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(payload))
}

function applyHttp(ctx, scanner, cfg) {
  const route = (routePath, handler) => ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: routePath,
      handler: async (req, res) => {
        try {
          await handler(req, res)
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      }
    }),
    `dsh-token-stats: ${routePath}`
  )

  route('/token-stats-api/summary', async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const refresh = url.searchParams.get('refresh') === '1'
    const current = scanner.data

    if (refresh) {
      const data = await scanner.ensureScan()
      if (data === null) {
        sendJson(res, 503, { ok: false, error: scanner.state.lastError || '扫描失败', status: scanner.status() })
        return
      }
      sendJson(res, 200, { ok: true, stale: false, status: scanner.status(), data })
      return
    }

    if (current !== null && scanner.isFresh()) {
      sendJson(res, 200, { ok: true, stale: false, status: scanner.status(), data: current })
      return
    }

    if (current !== null) {
      // 有缓存但过期：先把缓存给出去保证秒开，再后台刷新。
      void scanner.ensureScan()
      sendJson(res, 200, { ok: true, stale: true, status: scanner.status(), data: current })
      return
    }

    // 连缓存都没有：等这次扫描。
    const data = await scanner.ensureScan()
    if (data === null) {
      sendJson(res, 503, { ok: false, error: scanner.state.lastError || '扫描失败', status: scanner.status() })
      return
    }
    sendJson(res, 200, { ok: true, stale: false, status: scanner.status(), data })
  })

  route('/token-stats-api/status', async (req, res) => {
    sendJson(res, 200, { ok: true, status: scanner.status() })
  })

  ctx.logger.info('dsh-token-stats: 接口已注册（/token-stats-api/*）')
}

// ---------------------------------------------------------------- 插件入口

module.exports = {
  name: 'dsh-token-stats',
  inject: [],
  apply(ctx, config) {
    const cfg = {
      cacheTtlMs: (config && Number(config.cacheTtlMs)) || DEFAULT_TTL_MS,
      warmupOnStartup: !config || config.warmupOnStartup !== false,
      // 用户配置的别名覆盖内置规则（同名以用户为准）
      modelAliases: Object.assign({}, DEFAULT_MODEL_ALIASES, (config && config.modelAliases) || {})
    }
    const scanner = createScanner(cfg, ctx.logger)
    const cached = scanner.loadCache()

    ctx.inject(['webServer'], (httpCtx) => {
      applyHttp(httpCtx, scanner, cfg)
    })

    if (cfg.warmupOnStartup) {
      if (cached === null) {
        void scanner.ensureScan()
      } else if (!scanner.isFresh()) {
        void scanner.ensureScan()
      }
    }

    ctx.logger.info(
      'dsh-token-stats: 会话库 %s，缓存 %s，模型别名 %d 条',
      scanner.home, scanner.cacheFile, Object.keys(cfg.modelAliases).length
    )
  },
  // 供自检脚本直接调用
  _internal: { aggregate, createScanner, resolveHome, canonicalModel, DEFAULT_MODEL_ALIASES }
}
