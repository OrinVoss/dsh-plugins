'use strict'

// dsh-memory — host 半边。
//
// 只依赖 ctx.tools、可选的 ctx.webServer 与 Node 内置模块，不 import 任何
// @deepseek-ai/* 包，因此不依赖 DSH 的模块解析拦截层，加载失败的风险最低。
// 浏览器半边在 client.js（设置 → 记忆，注册进 settings.section 插槽），
// 宿主接口是 /memory-api/*（设置页的数据源，共七个路由）。
//
// 开发循环：HMR 只跟踪本入口文件，改完 lib/store.js 后碰一下本文件
// （或在 cordis.patch.yml 里动一下 memory 的配置）即可重挂载；
// 记忆的磁盘格式、索引维护、AGENTS.md 托管区块等全部逻辑在 lib/store.js，
// 那部分可以脱离 DSH 单独跑（见 selfcheck.cjs 与 plugintest.cjs）。
//
// v0.3.1（2026-10-01）：lib/store.js 修掉「overwrite 漏传 section → 索引同 target 重复登记」
// （根因与修复见 README §7.1），新增 reindex.cjs 修已写脏的库；本行同时让 HMR 重挂载入口。

// 加载期兜底：DSH 的 fiber 失败信息在界面上不易取到，这里把真实异常落盘，
// 便于安装期诊断。成功加载后这个文件会被清掉。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
function dshHomeDir() {
  const env = process.env.DSH_HOME
  if (env && env.trim()) return env.trim()
  return path.join(os.homedir(), '.dsh')
}
function reportLoadError(err) {
  try {
    const file = path.join(dshHomeDir(), 'memory', '.dsh-memory-load-error.log')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      file,
      `[${new Date().toISOString()}] dsh-memory 加载失败\n${(err && err.stack) || String(err)}\n` +
        `\n配置：${JSON.stringify(globalThis.__dshMemoryConfig || null)}\n`,
      'utf8'
    )
  } catch (_) { /* 诊断失败不能再抛 */ }
}
function clearLoadError() {
  try { fs.unlinkSync(path.join(dshHomeDir(), 'memory', '.dsh-memory-load-error.log')) } catch (_) { /* 不存在就算了 */ }
}

let storeLib
let healthLib
try {
  // DSH 重挂载只重新导入本入口文件，经 CommonJS require 进来的 lib/*.js
  // 会留在 require.cache 里；显式清掉，保证改完立刻生效，不必为此重启桌面端。
  try {
    delete require.cache[require.resolve('./lib/store')]
    delete require.cache[require.resolve('./lib/health')]
  } catch (_) { /* 首次加载时缓存里本来就没有 */ }
  storeLib = require('./lib/store')
  healthLib = require('./lib/health')
} catch (err) {
  reportLoadError(err)
  throw err
}
const { createStore, ENTRY_TYPES, DEFAULT_SECTION, PROJECT_KEY_RE } = storeLib

const SCOPES = ['global', 'project', 'auto']

const SCOPE_PARAM = {
  type: 'string',
  enum: SCOPES,
  description:
    'global = 跨工作区通用的长期记忆；project = 只对当前工作区成立；auto = 先项目后全局（search/read/forget 默认）'
}

function textResult(text) {
  return { type: 'text', text }
}

/** 组装一个 registry-ready 的工具定义（不使用 defineTool，避免额外依赖）。 */
function defineTool(spec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    timeoutMs: spec.timeoutMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string' } }
      },
      render: (_args, value) => [textResult(value.text)]
    },
    execute: spec.execute
  }
}

function cwdOf(exec) {
  const session = exec && exec.agent && exec.agent.session
  if (!session) return null
  return (session.header && session.header.cwd) || null
}

function sessionIdOf(exec) {
  const session = exec && exec.agent && exec.agent.session
  if (!session) return null
  return (session.header && session.header.id) || session.id || null
}

function resolveScope(store, wanted, name, cwd) {
  if (wanted && wanted !== 'auto') return wanted
  if (wanted === 'global') return 'global'
  // auto：先项目，再全局
  try {
    const hit = store.read('project', name, cwd)
    if (hit.found) return 'project'
  } catch (_) { /* 无 cwd 时项目作用域不可用 */ }
  return 'global'
}

/** 把 store 抛出的错误转成模型可读的文本，而不是让整个工具调用失败。 */
function attempt(toolName, fn) {
  try {
    return fn()
  } catch (err) {
    return { text: `${toolName} 失败：${String((err && err.message) || err)}` }
  }
}

function applyInner(ctx, config) {
  const cfg = config || {}
  const store = createStore({
    home: cfg.home,
    dshHome: cfg.dshHome,
    agentsPath: cfg.agentsPath,
    maxBlockBytes: cfg.maxBlockBytes,
    autoCommit: cfg.autoCommit
  })
  const autoSync = cfg.autoAgentsSync !== false

  const sync = (cwd) => {
    if (!autoSync) return
    try {
      store.syncAgents(cwd)
    } catch (err) {
      ctx.logger.warn('dsh-memory: 同步 AGENTS.md 失败: %o', err)
    }
  }

  ctx.effect(() => defineRegister(ctx, defineTool({
    name: 'memory_write',
    description:
      '把一条长期记忆写进记忆库（自动生成 frontmatter、写正文、并把摘要挂到索引里）。' +
      '写之前先 memory_search 查重。scope=global 用于「换任何工作区都成立」的事实（机器环境、网络代理、工具链路径、用户偏好、踩过的坑）；' +
      'scope=project 用于只对当前工作区成立的决策与坑。name 是稳定的英文/拼音小写 slug，可用 "/" 分子目录（如 preferences/git-local-commit-only）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['scope', 'name', 'description', 'body'],
      properties: {
        scope: { type: 'string', enum: ['global', 'project'], description: 'global | project' },
        name: {
          type: 'string',
          description: '稳定 slug，kebab-case；可含 "/" 分目录，如 tools/dsh-desktop-app'
        },
        title: { type: 'string', description: '索引里显示的中文标题；省略则用 name 末段' },
        description: {
          type: 'string',
          description: '一句话摘要（≤80 字），会出现在索引条目里；这句话决定以后能不能被检索到'
        },
        type: {
          type: 'string',
          enum: ENTRY_TYPES,
          description: `条目类型：${ENTRY_TYPES.join(' | ')}（默认 reference）`
        },
        section: {
          type: 'string',
          description: `全局索引里的分组标题（如「本机与网络」「工具配置」）；省略则用 name 的首段目录或「${DEFAULT_SECTION}」`
        },
        body: {
          type: 'string',
          description: '正文 Markdown。建议写成「事实 → **Why:** 为什么 → **How to apply:** 怎么用」，并可用 [[other-memory-name]] 互链'
        },
        overwrite: { type: 'boolean', description: '条目已存在时是否整条替换（默认 false，会拒绝并提示）' }
      }
    },
    execute(args, exec) {
      const cwd = cwdOf(exec)
      return attempt('memory_write', () => {
        const res = store.write(args.scope === 'project' ? 'project' : 'global', {
          name: args.name,
          title: args.title,
          description: args.description,
          type: args.type,
          section: args.section,
          body: args.body,
          overwrite: args.overwrite === true,
          sessionId: sessionIdOf(exec)
        }, cwd)
        if (!res.ok) return { text: `memory_write 未写入：${res.message}` }
        sync(cwd)
        const where = res.scope === 'global' ? '全局记忆' : `工作区记忆（${res.key}）`
        return {
          text: [
            `${res.updated ? '已更新' : '已写入'}${where}：\`${res.target}\``,
            `索引：\`${res.indexFile}\`（分组「${res.section}」）`,
            autoSync ? `全局指令 \`${store.agentsPath}\` 的记忆索引区块已同步，下个会话自动可见。` : '',
            res.commit && res.commit.committed ? '记忆库已本地提交（未推送）。'
              : res.commit && res.commit.reason === 'not-a-repo' ? '（记忆库不是 git 仓库，未提交）'
                : res.commit && res.commit.reason === 'disabled' ? '' : ''
          ].filter(Boolean).join('\n')
        }
      })
    }
  })), 'dsh-memory: memory_write')

  ctx.effect(() => defineRegister(ctx, defineTool({
    name: 'memory_search',
    description:
      '按关键词检索长期记忆，直接返回命中的条目正文。任务涉及本机环境、网络代理、工具链、用户偏好、交付物制作技巧，或要新建管线/踩到似曾相识的坑时，先用它。' +
      'query 省略则返回索引（只有标题+摘要）。scope 默认 auto（项目 + 全局）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '关键词；支持中文子串。省略则只列索引' },
        scope: { ...SCOPE_PARAM },
        limit: { type: 'integer', description: '最多返回几条正文（默认 5，上限 12）' }
      }
    },
    execute(args, exec) {
      const cwd = cwdOf(exec)
      const wanted = args.scope || 'auto'
      const scopes = wanted === 'auto' ? ['project', 'global'] : [wanted]
      const limit = Math.min(Math.max(1, Number(args.limit) || 5), 12)
      const chunks = []
      const searched = []
      const perHitBudget = 6000
      let total = 0
      let budget = 24000
      for (const scope of scopes) {
        let res
        try {
          res = store.search(scope, args.query, cwd, limit)
        } catch (err) {
          if (scope === 'project' && wanted === 'auto') continue
          return { text: `memory_search 失败：${String((err && err.message) || err)}` }
        }
        searched.push(scope === 'global' ? '全局记忆' : '当前工作区记忆')
        total += res.total
        if (res.results.length === 0) continue
        const label = scope === 'global' ? '全局记忆' : '工作区记忆'
        const lines = [`## ${label}（命中 ${res.total} 条，显示 ${res.results.length} 条）`]
        res.results.forEach((hit, index) => {
          const head = `### ${hit.title}\n\`${hit.target}\`${hit.summary ? ` — ${hit.summary}` : ''}`
          const body = String(hit.body || '')
          // 命中多时按剩余条目均分预算，避免一条 8 KB 的大条目把上下文吃光
          const remaining = res.results.length - index
          const allowance = Math.min(perHitBudget, Math.max(1200, Math.floor(budget / remaining)))
          if (body.length <= allowance) {
            budget -= body.length
            lines.push(`${head}\n\n${body}`)
          } else {
            budget -= allowance
            lines.push(
              `${head}\n\n${body.slice(0, allowance)}\n\n…（正文共 ${body.length} 字，已截断；要用全文请 memory_read \`${hit.target.replace(/\.md$/, '')}\`）`
            )
          }
        })
        chunks.push(lines.join('\n\n'))
      }
      if (chunks.length === 0) {
        const where = searched.length ? searched.join(' + ') : '（没有可搜索的作用域）'
        return {
          text: args.query
            ? `没有命中「${args.query}」的记忆条目（已搜索：${where}）。若这是新学到且换项目也成立的事实，用 memory_write 记下来。`
            : '记忆库目前是空的。'
        }
      }
      return { text: chunks.join('\n\n') }
    }
  })), 'dsh-memory: memory_search')

  ctx.effect(() => defineRegister(ctx, defineTool({
    name: 'memory_read',
    description: '按名字精确读取一条记忆的完整正文（名字就是索引里那条的路径，去掉 .md）。scope 默认 auto：先找当前工作区，再找全局。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', description: '条目 slug，如 tools/dsh-desktop-app' },
        scope: { ...SCOPE_PARAM }
      }
    },
    execute(args, exec) {
      const cwd = cwdOf(exec)
      const wanted = args.scope || 'auto'
      return attempt('memory_read', () => {
        const scope = resolveScope(store, wanted, args.name, cwd)
        const res = store.read(scope, args.name, cwd)
        if (!res.found) {
          return {
            text: `没找到记忆条目 \`${args.name}\`（${scope === 'global' ? '全局' : '工作区'}）。可以用 memory_search 按关键词找，或 memory_search 不带 query 列索引。`
          }
        }
        return {
          text: `# ${res.meta.name || res.name}\n\n- 作用域：${res.scope}\n- 路径：\`${res.target}\`\n- 类型：${res.meta.type || 'reference'}\n- 更新时间：${res.meta.updatedAt || '未知'}\n\n---\n\n${res.body}`
        }
      })
    }
  })), 'dsh-memory: memory_read')

  ctx.effect(() => defineRegister(ctx, defineTool({
    name: 'memory_forget',
    description:
      '删除一条已经过时或写错的记忆（同时从索引里摘掉）。仅在内容确已被推翻、或用户明确要求删除时使用；只是需要更新就用 memory_write + overwrite: true。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', description: '要删除的条目 slug' },
        scope: { ...SCOPE_PARAM }
      }
    },
    execute(args, exec) {
      const cwd = cwdOf(exec)
      const wanted = args.scope || 'auto'
      return attempt('memory_forget', () => {
        const scope = resolveScope(store, wanted, args.name, cwd)
        const res = store.forget(scope, args.name, cwd)
        if (!res.removed && !res.deindexed) {
          return { text: `没有找到要删除的记忆条目 \`${args.name}\`。` }
        }
        sync(cwd)
        const pruned = (res.pruned || []).length ? `，并剪掉了变空的分组「${res.pruned.join('、')}」` : ''
        return {
          text: `已删除${scope === 'global' ? '全局' : '工作区'}记忆 \`${res.target}\`${res.deindexed ? '（并已从索引移除）' : ''}${pruned}。` +
          (res.commit && res.commit.committed ? '\n记忆库已本地提交（未推送）。' : '')
        }
      })
    }
  })), 'dsh-memory: memory_forget')

  // 设置页接口：webServer 是可选服务，用 ctx.inject 而不是写进 inject 数组，
  // 这样没有 Web 宿主的 profile 里插件照常提供记忆工具。
  if (cfg.settingsPage !== false) {
    ctx.inject(['webServer'], (httpCtx) => {
      try {
        applyHttp(httpCtx, store, cfg)
      } catch (err) {
        httpCtx.logger.warn('dsh-memory: 设置页接口注册失败（记忆工具不受影响）: %o', err)
      }
    })
  }

  // 启动时先同步一次，让 AGENTS.md 里的记忆索引立即生效
  if (autoSync && cfg.syncOnStartup !== false) sync(null)

  clearLoadError()
  ctx.logger.info(
    'dsh-memory: 记忆库 %s，全局指令 %s，工具 memory_write/memory_search/memory_read/memory_forget 已注册',
    store.home,
    store.agentsPath
  )
}

function defineRegister(ctx, definition) {
  return ctx.tools.register(definition)
}

// ---------------------------------------------------------------- 设置页 HTTP 接口
//
// 设置页是浏览器里的客户端插件，与 sysmon 用同一套做法：宿主注册只读/只写
// `/memory-api/*` 路由，客户端 fetch。所有写入都被限制在记忆根目录内
// （条目名经 slugify，拒绝 ".."），作用域根目录固定。

function sendJson(res, code, payload) {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(payload))
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    let tooBig = false
    req.on('data', (chunk) => {
      if (tooBig) return
      body += chunk
      if (body.length > 2 * 1024 * 1024) {
        tooBig = true
        reject(new Error('请求体过大（>2MB）'))
      }
    })
    req.on('end', () => {
      if (tooBig) return
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch (_) {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function applyHttp(ctx, store, cfg) {
  const route = (path, handler) => ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path, handler }),
    `dsh-memory: ${path}`
  )
  const guard = (handler) => async (req, res) => {
    try {
      const result = await handler(req, res)
      if (result !== undefined) sendJson(res, 200, { ok: true, ...result })
    } catch (err) {
      sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
    }
  }
  /** 作用域寻址：scope=project 时必须带 key（设置页从 /projects 拿）。 */
  const target = (query) => {
    const scope = query.get('scope') === 'project' ? 'project' : 'global'
    const key = query.get('key') || null
    if (scope === 'project' && !key) throw new Error('scope=project 需要 key 参数')
    if (key !== null && !PROJECT_KEY_RE.test(key)) throw new Error('key 参数不是合法的项目键')
    return { scope, key }
  }

  /**
   * status 的工作区寻址：`?key=<项目键>` 或 `?cwd=<绝对路径>`（据此推出项目键）。
   * 两者都只用来定位 `home/projects/<键>/MEMORY.md`，不会读写记忆根之外的任何位置；
   * 仍然显式校验，避免把任意路径当探测入口。
   */
  const statusTarget = (query) => {
    const key = query.get('key')
    const cwd = query.get('cwd')
    if (key !== null && key !== '') {
      if (!PROJECT_KEY_RE.test(key)) throw new Error('key 参数不是合法的项目键')
      return { value: key, kind: 'key' }
    }
    if (cwd !== null && cwd !== '') {
      if (cwd.length > 1024 || cwd.includes('\0') || !path.isAbsolute(cwd)) {
        throw new Error('cwd 参数必须是长度合理的绝对路径')
      }
      return { value: cwd, kind: 'cwd' }
    }
    return { value: null, kind: null }
  }

  route('/memory-api/status', guard(async (req) => {
    const url = new URL(req.url, 'http://localhost')
    const t = statusTarget(url.searchParams)
    const s = store.status(t.value)
    return {
      ...s,
      project: s.project ? { ...s.project, source: t.kind ? `通过 ${t.kind} 定位` : null } : null
    }
  }))

  // 体检：设置页顶部的健康度卡片。相似度扫描是 O(N²) 的纯计算，按 INDEX.md 的
  // mtime + 60 秒双重条件缓存——写入会改 mtime，所以刚写完立刻刷新也能看到新结果。
  let healthCache = { at: 0, mtime: 0, data: null }
  route('/memory-api/health', guard(async () => {
    let mtime = 0
    try { mtime = fs.statSync(path.join(store.home, storeLib.INDEX_FILE)).mtimeMs } catch (_) { /* 空库 */ }
    const now = Date.now()
    if (healthCache.data && healthCache.mtime === mtime && now - healthCache.at < 60 * 1000) {
      return healthCache.data
    }
    const report = healthLib.analyze({
      home: store.home,
      agentsPath: store.agentsPath,
      maxBlockBytes: store.maxBlockBytes
    })
    const data = { report, verdict: healthLib.verdict(report) }
    healthCache = { at: now, mtime, data }
    return data
  }))

  route('/memory-api/projects', guard(async () => ({ projects: store.listProjects() })))

  route('/memory-api/list', guard(async (req) => {
    const url = new URL(req.url, 'http://localhost')
    const { scope, key } = target(url.searchParams)
    const idx = store.listIndex(scope, key)
    return {
      scope: idx.scope,
      key: idx.key ?? null,
      indexFile: idx.indexFile,
      exists: idx.exists,
      sections: idx.sections,
      entries: idx.entries
    }
  }))

  route('/memory-api/entry', guard(async (req) => {
    const url = new URL(req.url, 'http://localhost')
    const { scope, key } = target(url.searchParams)
    const name = url.searchParams.get('name')
    if (!name) throw new Error('缺少 name 参数')
    const res = store.read(scope, name, key)
    if (!res.found) return { found: false, name, target: res.target }
    return {
      found: true,
      scope: res.scope,
      name: res.name,
      target: res.target,
      meta: res.meta,
      body: res.body
    }
  }))

  /** 写入类路由的项目键校验：键必须合法（cwd 只由工具侧按会话 cwd 传入，不走 HTTP）。 */
  const projectKeyOf = (body) => {
    const key = body.key
    if (!key) throw new Error('scope=project 需要 key')
    if (!PROJECT_KEY_RE.test(String(key))) throw new Error('key 参数不是合法的项目键')
    return String(key)
  }

  route('/memory-api/save', guard(async (req) => {
    const body = await readJsonBody(req)
    const scope = body.scope === 'project' ? 'project' : 'global'
    const key = scope === 'project' ? projectKeyOf(body) : null
    const res = store.write(scope, {
      name: body.name,
      title: body.title,
      description: body.description,
      type: body.type,
      section: body.section,
      body: body.body,
      overwrite: body.overwrite === true,
      sessionId: body.sessionId || null
    }, key)
    if (!res.ok) throw new Error(res.message || `写入被拒绝（${res.reason}）`)
    store.syncAgents(null)
    return { scope: res.scope, key: res.key ?? null, target: res.target, updated: res.updated, indexFile: res.indexFile }
  }))

  route('/memory-api/delete', guard(async (req) => {
    const body = await readJsonBody(req)
    const scope = body.scope === 'project' ? 'project' : 'global'
    const key = scope === 'project' ? projectKeyOf(body) : null
    if (!body.name) throw new Error('缺少 name')
    const res = store.forget(scope, body.name, key)
    if (!res.removed && !res.deindexed) throw new Error(`没有找到条目 ${body.name}`)
    store.syncAgents(null)
    return { scope: res.scope, target: res.target, removed: res.removed, deindexed: res.deindexed, pruned: res.pruned || [] }
  }))

  route('/memory-api/sync', guard(async () => {
    const res = store.syncAgents(null)
    return { agentsPath: res.path, changed: res.changed, bytes: res.bytes }
  }))

  ctx.logger.info('dsh-memory: 设置页接口已注册（/memory-api/*）')
}

module.exports = {
  name: 'dsh-memory',
  inject: ['tools'],
  apply(ctx, config) {
    globalThis.__dshMemoryConfig = config
    try {
      return applyInner(ctx, config)
    } catch (err) {
      reportLoadError(err)
      throw err
    }
  },
  applyInner
}
