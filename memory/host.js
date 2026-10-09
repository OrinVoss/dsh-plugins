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
  storeLib = freshRequire('./lib/store')
  healthLib = freshRequire('./lib/health')
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

/**
 * 文件区块通道（AGENTS.md / AGENTS.local.md）是否生效。
 *
 * 新规则（2026-10-09）：能用系统提示词通道时**不再写文件** —— 文件是"插件关掉后仍留着、
 * 仍被官方加载器注入"的东西（内容里的 memory_search/memory_read 那时已不存在），
 * 而系统提示词段 / runtime context 都是作用域 effect，随插件销毁，内容与事实始终一致。
 *   · 显式 injectProjectBlock:false 关闭（老语义保留）
 *   · promptInjection.enabled:false 是回滚开关：恢复文件通道并在下次启动重写区块
 */
function fileBlocksEnabled(ctx, cfg) {
  const promptOn = !(cfg && cfg.promptInjection && cfg.promptInjection.enabled === false) && !!(ctx && ctx.systemPrompt)
  return (cfg ? cfg.injectProjectBlock !== false : true) && !promptOn
}

/**
 * 清掉 require 缓存后再加载插件自己的 lib 模块。
 * 为什么必须这样：DSH 的 HMR 只重挂载入口（host.js），**Node 的 require 缓存不会失效**，
 * 于是 applyInner 里 require('./lib/x') 一直拿到首次加载的旧版本 —— 实测表现为
 * 「改了 lib/retrieve.js 加了 seenWithin，运行时却报 retrieve.seenWithin is not a function」。
 * 代价只是每次重挂载重新求值一遍纯模块，可忽略。
 */
function freshRequire(rel) {
  const p = require.resolve(rel)
  delete require.cache[p]
  return require(p)
}
// 系统提示词注入的缓存失效钩子：由 applyInjection 赋值、applyInner 的 sync() 调用。
// 放模块级是必须的 —— 之前声明在 applyInner、赋值在 applyHttp（两个不同函数），
// 实测报 "invalidatePromptCache is not defined"。
let invalidatePromptCache = () => {}

function applyInner(ctx, config) {
  const cfg = config || {}
  const store = createStore({
    home: cfg.home,
    dshHome: cfg.dshHome,
    agentsPath: cfg.agentsPath,
    maxBlockBytes: cfg.maxBlockBytes,
    autoCommit: cfg.autoCommit,
    injectProjectBlock: cfg.injectProjectBlock,
    projectBlockFile: cfg.projectBlockFile,
    maxProjectBlockBytes: cfg.maxProjectBlockBytes,
    blockMode: cfg.blockMode,
    sectionHints: cfg.sectionHints,
    triggerLines: cfg.triggerLines
  })
  const autoSync = cfg.autoAgentsSync !== false
  const fileBlocks = fileBlocksEnabled(ctx, cfg)

  const sync = (cwd) => {
    if (!autoSync) return
    try {
      if (fileBlocks) {
        store.syncAgents(cwd)
        // 有 cwd 时顺带把「工作区记忆」区块写进工作区自己的指令文件（默认 AGENTS.local.md）。
        // 全局区块进 ~/.dsh/AGENTS.md，两者互不影响；没有项目条目时这个调用是空操作。
        if (cwd) {
          const ws = store.syncWorkspaceAgents(cwd)
          if (ws && ws.changed) ctx.logger.info('dsh-memory: 已同步工作区记忆区块 → %s', ws.path)
        }
      } else {
        // 文件通道已退休（记忆索引改走系统提示词段 / runtime context）：顺手摘掉历史遗留的托管区块。
        const r = store.stripFileBlocks(cwd)
        if (r.global && r.global.changed) ctx.logger.info('dsh-memory: 已摘掉 AGENTS.md 托管区块（改走系统提示词通道）→ %s', r.global.path)
        if (r.project && r.project.changed) ctx.logger.info('dsh-memory: 已摘掉工作区记忆区块 → %s', r.project.path)
      }
      invalidatePromptCache()
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

  // 三条注入通道在主 ctx 上注册（**不依赖 webServer，也不受 settingsPage 开关影响**）：
  //   ① L1 检索注入  ② 压缩保护段  ③ 记忆索引（系统提示词段 + runtime context）
  try {
    applyInjection(ctx, store, cfg)
  } catch (err) {
    ctx.logger.warn('dsh-memory: 注入注册失败（记忆工具与文件区块不受影响）: %o', err)
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

/**
 * 记忆的三条注入通道（都注册在**主 ctx** 上，与设置页接口无关）：
 *   ① L1 检索注入：agent/pre-step，按当前用户消息检索记忆库
 *   ② 压缩保护段：system-prompt section，要求压缩摘要保留检索条目
 *   ③ 记忆索引注入：system-prompt section（全局 L0）+ context（工作区项目索引）
 *
 * 为什么单独抽成一个函数：它们原先被我追加在 applyHttp（设置页接口）末尾，而 applyHttp 只在
 * `settingsPage !== false` 且存在 webServer 时才被调用 ⇒ settingsPage:false 会误关这三样、
 * 没有 webServer 的 profile 里则永不注册；另外还造成过"声明在 applyInner、赋值在 applyHttp"
 * 的作用域错位（实测报 invalidatePromptCache is not defined）。
 */
function applyInjection(ctx, store, cfg) {
  const fileBlocks = fileBlocksEnabled(ctx, cfg)
  const strippedWorkspaces = new Set()   // 已摘过遗留文件区块的工作区（幂等，只做一次）
  // ---- L1：按当前用户消息检索记忆，只注入命中的几条（2026-10-09）
  // 依据：10 天实测 456 个被注入会话里 86.2% 从未用过记忆工具；48 条从未被读的条目里 41 条主题
  // 在会话里出现过（投递失败）。所以把"模型自己想起来搜"换成"相关记忆自动出现"。
  // 三条硬约束（只追加 / 确定性 / 会话内去重）见 lib/retrieve.js 顶部注释。
  const retrieveCfg = (cfg.retrieve && typeof cfg.retrieve === 'object') ? cfg.retrieve : {}
  const retrieveEnabled = retrieveCfg.enabled !== false
  const RETRIEVE = {
    k: Number.isFinite(retrieveCfg.k) && retrieveCfg.k > 0 ? Math.floor(retrieveCfg.k) : 3,
    minScore: Number.isFinite(retrieveCfg.minScore) ? retrieveCfg.minScore : 8,
    maxBytes: Number.isFinite(retrieveCfg.maxBytes) && retrieveCfg.maxBytes > 0 ? Math.floor(retrieveCfg.maxBytes) : 2000,
    // 同一条目多久之后允许再次注入（按 step 计）。会话内永久去重是错的：DSH 会压缩长会话，
    // 几十轮前注入的条目可能已不在上下文里，却仍被永久抑制（2026-10-09 实测遇到）。
    repeatAfterSteps: Number.isFinite(retrieveCfg.repeatAfterSteps) && retrieveCfg.repeatAfterSteps >= 0 ? Math.floor(retrieveCfg.repeatAfterSteps) : 60,
    // 查询有效长度（去标点空白）低于这个值就不注入 —— 「继续」「ok」这类短消息检索必出噪声
    minQueryChars: Number.isFinite(retrieveCfg.minQueryChars) && retrieveCfg.minQueryChars >= 0 ? Math.floor(retrieveCfg.minQueryChars) : 4
  }
  // 压缩后清空注入记账：压缩会把旧消息 shadow 掉（compaction/prune 的 shadowedSeqs），
  // 那些"我送过了"的内容可能已经不在上下文里 —— 这时必须允许重新送（2026-10-09 实测：
  // 本会话 15 个压缩事件、prune 落在 seq 23/29/36/48）。
  const clearOnCompaction = retrieveCfg.clearOnCompaction !== false
  const injectedBySession = new Map()   // sessionId → Map<target, 注入时的 step>
  // 精确版用：sessionId → [{seq, lines}]（自己注入过的消息及其日志 seq/原文），以及被压缩遮掉待补送的行
  const injectedSeqs = new Map()
  const lostLines = new Map()
  const pendingLines = []   // 刚注入、还没等到 session/event 回填 seq 的行
  const INJECT_LOG = require('node:path').join(require('node:os').tmpdir(), 'dsh-memory-l1.log')
  const logInject = (o) => {
    if (retrieveCfg.log === false) return
    try { require('node:fs').appendFileSync(INJECT_LOG, JSON.stringify(Object.assign({ t: new Date().toISOString() }, o)) + '\n') } catch (_) { /* 日志不许影响主流程 */ }
  }

  if (retrieveEnabled) {
    try {
      const retrieve = freshRequire('./lib/retrieve')
      // **只用 ctx 注册**（作用域绑定 → 插件关闭/卸载时 cordis 自动摘除监听器）。
      //
      // 这里曾经有一套"发射器回退链"（ctx.on → ctx.root.on → ctx.app.on → ctx.scope.on），
      // 起因是报 "ctx.on is not a function"。2026-10-09 用 apply 指纹探针测清楚后删掉了：
      //   · 正常重挂载 = **1 次 apply，ctx 完整**（有 .on / systemPrompt / agents / sessions / tools / root）
      //   · 报错的那几次来自**其他作用域的 apply**（受限 ctx，只有 logger/effect/inject/webServer/tools），
      //     那些作用域本来就注册不了东西，也不该注册
      //   · 回退链反而带来真隐患：一旦落到 `ctx.root`，监听器就绑在**根作用域**上、**不随插件销毁**
      // 所以现在：能注册就注册，不能就跳过（受限作用域属预期，降级为 info 日志）。
      if (typeof ctx.on !== 'function') {
        let shape = ''
        try { shape = Object.keys(ctx || {}).slice(0, 25).join(',') } catch (_) { shape = '(取键失败)' }
        logInject({ ev: 'l1-skipped', reason: 'no-event-api', ctxKeys: shape })
        throw new Error('本作用域没有事件 API（受限作用域，跳过 L1）')
      }
      const emitter = { label: 'ctx', t: ctx }
      emitter.t.on('agent/pre-step', async (payload, next) => {
        const decision = await next()
        try {
          const list = Array.isArray(payload && payload.messages) ? payload.messages : []
          logInject({ ev: 'enter', step: payload && payload.step, n: list.length })
          const query = retrieve.userTurnText(list)
          // 工具续跑步骤没有新用户消息 → 不注入（省 token，也让前缀保持稳定）
          if (!query) return decision
          // 太短的消息（「继续」「ok」）关键词检索必出噪声 → 直接跳过，别注入垃圾
          if (retrieve.effectiveLength(query) < RETRIEVE.minQueryChars) {
            logInject({ ev: 'skip-short-query', sessionId: (payload.agent && payload.agent.session && payload.agent.session.header && payload.agent.session.header.id) || 'default', query: query.slice(0, 40), len: retrieve.effectiveLength(query) })
            return decision
          }
          if (!decision || !Array.isArray(decision.messages)) return decision
          const header = (payload.agent && payload.agent.session && payload.agent.session.header) || {}
          const sessionId = header.id || 'default'
          const cwd = header.cwd || null
          // 文件通道已退休：本会话第一次拿到 cwd 时，摘掉该工作区历史遗留的托管区块（幂等，每 cwd 一次）
          if (!fileBlocks && cwd && !strippedWorkspaces.has(cwd)) {
            strippedWorkspaces.add(cwd)
            try {
              const r = store.stripFileBlocks(cwd)
              if (r.project && r.project.changed) {
                logInject({ ev: 'stripped-workspace-block', path: r.project.path, deleted: !!r.project.deleted })
              }
            } catch (_) { /* 摘不掉不影响注入 */ }
          }
          const stepNo = Number.isFinite(payload.step) ? payload.step : 0
          const injectedMap = injectedBySession.get(sessionId) || new Map()
          // 去重：主触发器是压缩（见下面的 session/event 监听，压缩会清空记账）；
          // 这里只是兜底窗口，防止"没有压缩但会话很长"时同一内容反复注入。
          const seen = retrieve.seenWithin(injectedMap, stepNo, RETRIEVE.repeatAfterSteps)
          const groups = []
          if (cwd) { try { groups.push(store.search('project', query, cwd, RETRIEVE.k)) } catch (_) { /* 无项目库 */ } }
          try { groups.push(store.search('global', query, null, RETRIEVE.k)) } catch (_) { /* 库不可用 */ }
          const picked = retrieve.pickHits(groups, { seen, k: RETRIEVE.k, minScore: RETRIEVE.minScore, maxBytes: RETRIEVE.maxBytes })
          // 精确版补送：上一轮被压缩遮掉的注入原文，原样再送一次（最多 k 条，且不与本轮挑选重复）
          const pending = lostLines.get(sessionId) || []
          if (pending.length) {
            const have = new Set(picked.picked.map((p) => p.target))
            for (const line of pending) {
              if (picked.picked.length >= RETRIEVE.k) break
              const m = /`([^`]+)`/.exec(line)
              const target = m ? m[1] : null
              if (target && have.has(target)) continue
              picked.picked.push({ target: target || line.slice(0, 40), title: line, summary: '', restored: true })
              picked.bytes += Buffer.byteLength(line, 'utf8') + 1
            }
            lostLines.delete(sessionId)
            logInject({ ev: 'restore-after-compaction', sessionId, restored: picked.picked.filter((p) => p.restored).length })
          }
          if (!picked.picked.length) {
            logInject({ ev: 'no-hit', sessionId, query: query.slice(0, 120), scores: groups.map((g) => ({ scope: g && g.scope, top: (g && g.results || []).slice(0, 3).map((x) => x.score) })) })
            return decision
          }
          for (const p of picked.picked) injectedMap.set(p.target, stepNo)
          if (injectedBySession.size > 50) injectedBySession.delete(injectedBySession.keys().next().value)
          injectedBySession.set(sessionId, injectedMap)
          const text = retrieve.renderInjection(picked.picked)
          const lines = picked.picked.map((p) => retrieve.line(p))
          // 消息形状：**必须带 source**。只给 {content:[...]} 会让框架在 message.source.kind 上
          // 抛 "Cannot read properties of undefined (reading 'kind')"，整轮崩掉（2026-10-09 实测，
          // 用户的提问因此没被收到）。形状依据：官方指令加载器构造的是 {content, source:{kind, form, changes}}；
          // 自定义 kind 在生产里可行（agent-team-plus 用 kind:"team-message"）。
          const source = { kind: 'dsh-memory-retrieval', form: 'retrieval', changes: [] }
          const injected = { content: [{ type: 'text', text }], source }
          const lastClaimed = decision.messages.findLastIndex((m) => list.includes(m))
          const at = lastClaimed < 0 ? 0 : lastClaimed + 1
          logInject({ ev: 'inject', sessionId, bytes: picked.bytes, targets: picked.picked.map((p) => p.target), scores: picked.picked.map((p) => p.score), query: query.slice(0, 120), sourceKind: source.kind, sourceKeys: Object.keys(source) })
          // 等 session/event 把这条消息的日志 seq 报回来（见下面的监听）
          pendingLines.push({ sessionId, lines })
          return Object.assign({}, decision, { messages: decision.messages.toSpliced(at, 0, injected) })
        } catch (err) {
          logInject({ ev: 'error', err: String((err && err.message) || err), stack: String((err && err.stack) || '').slice(0, 400) })
          try { ctx.logger.warn('dsh-memory: L1 注入失败（本轮跳过）: %o', err) } catch (_) { /* 降级 */ }
          return decision
        }
      })
      // 压缩事件 → 清空该会话的注入记账（下一次用户轮次重新可注入）
      if (clearOnCompaction) {
        emitter.t.on('session/event', (session, event) => {
          try {
            if (!event || typeof event.type !== 'string') return
            const sid = (session && (session.id || (session.header && session.header.id))) || null
            if (!sid) return
            // ① 自己的注入消息回来了 → 记下它的日志 seq 与原文（靠 source.kind 认出来，不用打标记）
            if (event.type === 'user/message' && event.data && event.data.source && event.data.source.kind === 'dsh-memory-retrieval') {
              const idx = pendingLines.findIndex((x) => x.sessionId === sid)
              if (idx >= 0) {
                const p = pendingLines.splice(idx, 1)[0]
                const arr = injectedSeqs.get(sid) || []
                arr.push({ seq: event.seq, lines: p.lines })
                injectedSeqs.set(sid, arr)
                logInject({ ev: 'injection-seq-recorded', sessionId: sid, seq: event.seq, n: p.lines.length })
              }
              return
            }
            if (!event.type.startsWith('compaction/')) return
            if (event.type !== 'compaction/end' && event.type !== 'compaction/prune') return
            // ② 压缩 prune：看有没有自己的注入消息被 shadow 掉 → 记进"待补送"（原文复用，确定性）
            if (event.type === 'compaction/prune' && event.data && Array.isArray(event.data.shadowedSeqs)) {
              const shadowed = new Set(event.data.shadowedSeqs)
              const rec = injectedSeqs.get(sid) || []
              const lost = []
              for (const r of rec) if (shadowed.has(r.seq)) lost.push(...r.lines)
              if (lost.length) {
                const merged = [...new Set([...(lostLines.get(sid) || []), ...lost])]
                lostLines.set(sid, merged)
                logInject({ ev: 'injection-shadowed', sessionId: sid, n: lost.length, totalPending: merged.length })
              }
            }
            const had = injectedBySession.get(sid)
            if (had && had.size) {
              injectedBySession.delete(sid)
              logInject({ ev: 'dedupe-cleared', sessionId: sid, reason: event.type, dropped: had.size })
            }
          } catch (_) { /* 清账失败不影响主流程 */ }
        })
      }
      ctx.logger.info('dsh-memory: L1 检索注入已启用（k=%d minScore=%d maxBytes=%d，压缩后清账=%s）', RETRIEVE.k, RETRIEVE.minScore, RETRIEVE.maxBytes, String(clearOnCompaction))
      logInject({ ev: 'hook-registered', via: emitter.label, retrieveV: retrieve.VERSION, k: RETRIEVE.k, minScore: RETRIEVE.minScore, repeatAfterSteps: RETRIEVE.repeatAfterSteps, clearOnCompaction })
    } catch (err) {
      logInject({ ev: 'l1-skipped', err: String((err && err.message) || err) })
      // 受限作用域属预期路径 → info 级（以前这里是 warn，于是每次全量重载刷一堆假警报）
      try { ctx.logger.info('dsh-memory: 本作用域跳过 L1 检索注入: %s', (err && err.message) || err) } catch (_) { /* 降级 */ }
    }
  }

  // 把"压缩时必须保留 dsh-memory 检索条目"注册进**系统提示词**。
  // 原理与依据见 lib/compaction-guard.js 顶部注释（摘要模型会逐字回放系统提示词，且它永不被遮蔽）。
  // 这是**软保证**（靠摘要模型照做）；硬保证是上面那套"压缩后比对 shadowedSeqs 再补送"。
  const guardCfg = (cfg.compactionGuard && typeof cfg.compactionGuard === 'object') ? cfg.compactionGuard : {}
  if (guardCfg.enabled !== false) {
    try {
      const guard = freshRequire('./lib/compaction-guard')
      const secText = (typeof guardCfg.text === 'string' && guardCfg.text.trim()) ? guardCfg.text : guard.TEXT
      const order = Number.isFinite(guardCfg.order) ? guardCfg.order : guard.DEFAULT_ORDER
      ctx.systemPrompt.section({ name: guard.SECTION_NAME, order, text: secText, interpolate: false })
      logInject({ ev: 'compaction-guard-registered', guardV: guard.VERSION, order, bytes: Buffer.byteLength(secText, 'utf8') })
    } catch (err) {
      logInject({ ev: 'compaction-guard-failed', err: String((err && err.message) || err) })
      try { ctx.logger.warn('dsh-memory: 注册压缩保护段失败: %o', err) } catch (_) { /* 降级 */ }
    }
  }

  // ---- 记忆注入改走插件自己的扩展点（2026-10-09，"根本方案"第一步：双通道并存）
  //
  // 为什么不再靠 AGENTS.md 托管区块：那是**文件写入**，插件关掉后区块仍留在文件里、仍被官方
  // 加载器注入，而区块里写的 memory_search/memory_read 那时已经不存在了（指令与事实不一致）。
  //
  // 改用两个都是**作用域 effect**（⇒ 随插件销毁）的扩展点：
  //   ① ctx.systemPrompt.section()：全局 L0（规则速查 + 专题地图）进**系统提示词** —— 顺带解决
  //      "注入内容会被压缩遮蔽"的问题（系统提示词永不被遮蔽）。
  //   ② ctx.systemPrompt.context()：工作区项目索引进 **runtime context**（与 time-context 同一通道，
  //      仍是每轮的 user 消息），text 传**函数** ⇒ 每次组装按 agent 的 cwd 现算。
  // 缓存：段文本每次组装都会求值，而 alwaysRules() 要扫全部条目文件 → 5 秒 TTL + 写库后立刻失效。
  const promptCfg = (cfg.promptInjection && typeof cfg.promptInjection === 'object') ? cfg.promptInjection : {}
  if (promptCfg.enabled !== false && ctx.systemPrompt && typeof ctx.systemPrompt === 'object') {
    try {
      const storeLib = freshRequire('./lib/store')
      const MARKERS = new Set([storeLib.BLOCK_BEGIN, storeLib.BLOCK_END, storeLib.PROJECT_BLOCK_BEGIN, storeLib.PROJECT_BLOCK_END])
      const stripMarkers = (t) => String(t || '').split('\n').filter((l) => !MARKERS.has(l.trim())).join('\n').trim()
      // 组装上下文是 { agent, scope, signal? }，**本身没有 cwd** —— 要从 agent 上取。
      // 多写几条路径兜底，并记一条（节流）诊断，确认到底取到没有。
      // 注意：**不要往上下文对象上写标记**（它可能是冻结的，写会抛错并被自己的 catch 吞掉）。
      let lastCtxProbe = 0
      const cwdOf = (c) => {
        try {
          const a = c && c.agent
          const cands = [
            a && a.session && a.session.header && a.session.header.cwd,
            a && a.session && a.session.cwd,
            a && a.cwd,
            a && a.options && a.options.cwd,
            c && c.cwd
          ]
          const hit = cands.find((x) => typeof x === 'string' && x)
          try {
            const now = Date.now()
            if (now - lastCtxProbe > 5000) {
              lastCtxProbe = now
              const safeKeys = (o) => { try { return o ? Object.keys(o).slice(0, 16).join(',') : '(none)' } catch (e) { return 'THROW' } }
              logInject({ ev: 'assembly-context-probe', ctxType: typeof c, keys: safeKeys(c), agentKeys: safeKeys(a), cwd: hit || '(none)' })
            }
          } catch (_) { /* 探针不许影响主流程 */ }
          return hit || null
        } catch (_) { return null }
      }
      const TTL = 5000
      let blockCache = { text: '', at: 0 }
      let projCache = new Map()
      const renderGlobal = (cwd) => {
        const now = Date.now()
        if (blockCache.text && now - blockCache.at < TTL) return blockCache.text
        blockCache = { text: stripMarkers(store.buildBlock(cwd)), at: now }
        return blockCache.text
      }
      const renderProject = (cwd) => {
        if (!cwd) return ''
        const now = Date.now()
        const hit = projCache.get(cwd)
        if (hit && now - hit.at < TTL) return hit.text
        let text = ''
        try { text = stripMarkers(store.buildProjectBlock(cwd)) } catch (_) { text = '' }
        projCache.set(cwd, { text, at: now })
        if (projCache.size > 20) projCache.clear()
        return text
      }
      invalidatePromptCache = () => { blockCache = { text: '', at: 0 }; projCache = new Map() }
      const sectionOrder = Number.isFinite(promptCfg.sectionOrder) ? promptCfg.sectionOrder : 10250
      const contextOrder = Number.isFinite(promptCfg.contextOrder) ? promptCfg.contextOrder : 200
      ctx.systemPrompt.section({
        name: 'dsh-memory:index',
        order: sectionOrder,
        interpolate: false,
        text: (c) => renderGlobal(cwdOf(c))
      })
      ctx.systemPrompt.context({
        name: 'dsh-memory:project',
        order: contextOrder,
        text: (c) => renderProject(cwdOf(c))
      })
      logInject({ ev: 'prompt-injection-registered', sectionOrder, contextOrder, bytes: Buffer.byteLength(renderGlobal(null), 'utf8') })
    } catch (err) {
      logInject({ ev: 'prompt-injection-failed', err: String((err && err.message) || err) })
      try { ctx.logger.warn('dsh-memory: 注册系统提示词注入失败（回落到文件区块）: %o', err) } catch (_) { /* 降级 */ }
    }
  }
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

  route('/memory-api/sync', guard(async (req) => {
    const res = store.syncAgents(null)
    const cwd = new URL(req.url, 'http://localhost').searchParams.get('cwd')
    const ws = cwd ? store.syncWorkspaceAgents(cwd) : null
    return { agentsPath: res.path, changed: res.changed, bytes: res.bytes, workspace: ws }
  }))

  ctx.logger.info('dsh-memory: 设置页接口已注册（/memory-api/*）')
}

module.exports = {
  name: 'dsh-memory',
  inject: ['tools', 'agents', 'sessions', 'sessionProjections', 'systemPrompt'],
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

// 2026-10-09：L0 分层注入（blockMode: layered）+ 工作区记忆区块 + L1 检索注入
// （agent/pre-step；需要 inject 里声明 'agents'）。改完 lib/*.js 后碰一下本文件即可重挂载。
// remount #11 (window dedupe)
// remount #12 (fix dup const)
// remount #13 (compaction trigger)
// remount #14 (brace fix)
// remount #15 (fix source field)
// remount #16 (explicit source shape)
// remount #17 (L1 diagnostics)
// remount #18 (ctx emitter fallback)
// remount #19 (inject sessions/sessionProjections)
// remount #20 (freshRequire)
// remount #21 (freshRequire fixed)
// remount #22 (all lib via freshRequire)
// remount #23 (shadow reinject)
// remount #24 (short query guard)
// remount #25 (compaction guard)
// remount #26 (apply fingerprint probe)
// remount #27 (drop emitter fallback)
// remount #28 (prompt injection)
// remount #29 (clean retry)
// remount #30 (injection extracted)
// remount #31 (cwd probe)
// remount #32 (throttled cwd probe)
// remount #33 (file channel retired)
