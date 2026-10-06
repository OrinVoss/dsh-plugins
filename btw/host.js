/**
 * dsh-btw — 「临时提问」(/btw) 的宿主半边。
 *
 * 语义与 Claude Code 的 /btw 对齐：
 *  - 回答**不写入会话日志**：本插件只读 `session.deriveMessages()`，从不 append 任何事件；
 *  - **无工具**：请求里不带 `tools`，模型不可能发起工具调用；
 *  - **单次响应**：不走 agent loop，只发一次 `ctx.llm.stream()`；
 *  - 看得到"到目前为止"的对话，但看不到正在生成的那条回复——chunk 事件不是 surface 节点，
 *    `deriveMessages()` 天然不含未完成的 assistant 消息，这一条不用额外代码；
 *  - 线程只活在宿主内存里（每会话最多 THREAD_LIMIT 轮），进程退出即消失，不落盘。
 *
 * 与主回合的隔离：不占 turn/step、不碰 goal/todo/compaction、不发布任何 session 事件，
 * 因此不会影响主回合的 signal、上下文占用口径与轨迹。
 *
 * 对外只提供三个本地 HTTP 路由（与 sysmon 同一套 webServer 约定）：
 *   POST /btw-api/ask    { sessionId, question }  → SSE 流
 *   GET  /btw-api/thread ?sessionId=              → 内存线程快照
 *   POST /btw-api/stop   { sessionId }            → 中止当前临时提问
 *   POST /btw-api/clear  { sessionId }            → 清空线程
 */

const NAME = 'dsh-btw'

/** 每个会话保留的临时提问轮数上限（与 Claude Code 的"最近 20 次"对齐）。 */
const THREAD_LIMIT = 20

/** 旁支提问的输出上限：够长到能解释，又不至于把主回合的额度吃掉。 */
/** 会话没给出上限时的默认输出上限（思考 + 正文合计）。 */
const ANSWER_MAX_TOKENS = 8192

/**
 * 旁支提问的引导词。
 *
 * 为什么需要这么重：请求复用的是主会话的完整前缀（含大量工具调用与"接下来我要执行…"），
 * 模型极容易把自己当主会话继续干活。这里用四条例外声明直接掐掉三类失败模式：
 * 输出工具调用标记、声称/暗示要执行动作、把上面的转录当成自己的待办。
 *
 * 做法照社区 dsh-btw（author iluluyu, MIT）：**不复用会话历史**，而是把最近一段对话
 * 压成纯文本放进一条 user 消息的 <conversation> 标签里，再给一个真正的 system 提示词。
 * 旧做法（replay `deriveMessages()` 当自己的历史）必然失败：上下文里全是工具调用样例，
 * 模型只会照着模仿 DSML，还把自己当成主会话继续干活。
 */
const GUIDANCE = [
  'You answer quick side questions about an ongoing coding session.',
  'The recent conversation is provided as reference inside <conversation> tags; the question follows inside <question> tags.',
  'That transcript is reference material only. Its tool calls were made by the main agent, not by you: you are not the main agent, and you are not continuing its work.',
  'You have no tools. Never emit tool calls or tool-call syntax in any form, and never claim to have run, read, edited, or checked anything. If an action seems necessary, describe it in plain prose instead.',
  'Answer directly and concisely, in the language of the question. Quote exact paths, names, and decisions from the context when they matter.',
  'If the context does not contain the answer, say so plainly in one line — do not invent, do not ask follow-up questions, and do not ask for permission to act.',
].join(' ')

/** 转录上限（字符）：只带最近一段，请求因此从 ~190k token 降到 ~12k。 */
const TRANSCRIPT_MAX = 48_000

/** 每会话一个内存线程：`{ question, answer }` 按时间升序。 */
const threads = new Map()
/** 每会话至多一个进行中的临时提问。 */
const inflight = new Map()

/** 读取（必要时创建）一个会话的线程。 */
function threadOf(sessionId) {
  let thread = threads.get(sessionId)
  if (thread === undefined) {
    thread = []
    threads.set(sessionId, thread)
  }
  return thread
}

/** 把线程裁剪到 THREAD_LIMIT 轮。 */
function trimThread(sessionId) {
  const thread = threadOf(sessionId)
  if (thread.length > THREAD_LIMIT) thread.splice(0, thread.length - THREAD_LIMIT)
}

/** 只接受 JSON 对象体。 */
function readJson(req, limitBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let body = ''
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limitBytes) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      body += chunk
    })
    req.on('end', () => {
      if (body.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(body))
      } catch (error) {
        reject(new Error('malformed JSON body'))
      }
    })
    req.on('error', reject)
  })
}

/** 发一个 SSE 帧。 */
function send(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

/** 统一写一个 JSON 错误响应。 */
function fail(res, status, message) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify({ error: message }))
}

/** 从 agent 的请求头解析本次要用的路由与采样参数。 */
function resolveCallConfig(ctx, agent) {
  const header = typeof agent.session.requestHeader === 'function' ? agent.session.requestHeader() : undefined
  const config = header && header.config ? header.config : undefined
  if (config && typeof config.provider === 'string' && typeof config.model === 'string') {
    // 跟随会话自己的输出上限，**不再压低**：思考 token 也算在这个预算里，
    // 早先压到 4096 会让"想一半就到顶"——流结束、没有正文，看起来像思考被中断。
    const maxTokens = typeof config.maxTokens === 'number' && config.maxTokens > 0
      ? config.maxTokens
      : ANSWER_MAX_TOKENS
    return {
      provider: config.provider,
      model: config.model,
      maxTokens,
      ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
    }
  }
  // 还没有发出过任何请求（新会话首轮之前）：退回默认模型选择。
  const selection = ctx.get('agentDefaultModel')
  const current = selection && typeof selection.currentSelection === 'function' ? selection.currentSelection() : undefined
  if (current && typeof current.provider === 'string' && typeof current.model === 'string') {
    return { provider: current.provider, model: current.model, maxTokens: ANSWER_MAX_TOKENS }
  }
  return undefined
}

/** 任何"工具调用标记"的开或闭标签（DSMlish 或通用 <tool_call> 家族）。 */
const TOOL_TAG = /<(?:\|{1,2}|｜{1,2})?DSML(?:\|{1,2}|｜{1,2})?[^>]*>|<\/(?:\|{1,2}|｜{1,2})?DSML(?:\|{1,2}|｜{1,2})?[^>]*>|<tool_call>|<tool_calls>|<function_call>|<\/tool_call>|<\/tool_calls>|<\/function_call>/gi

/**
 * 剥掉写成文本的工具调用标记：旁支提问没有工具，这类标记没有任何意义，
 * 重放回模型只会诱导它继续乱写。
 *
 * 单遍深度计数，和客户端 `sanitizeAnswer` 同一套规则：嵌套或名字不配对的标记
 * 不会落下孤立闭标记（`</｜｜DSML｜｜ invoke>` 会留在屏幕上）。
 * @param source - 模型输出。
 * @returns 清理后的文本。
 */
function stripToolMarkup(source) {
  const text = String(source)
  let out = ''
  let depth = 0
  let last = 0
  let regionStart = 0
  let stripped = false
  const pattern = new RegExp(TOOL_TAG.source, 'gi')
  let match
  while ((match = pattern.exec(text)) !== null) {
    const closing = match[0].charAt(1) === '/'
    if (depth === 0) {
      // 深度 0：前面的正文留下；开标记开启一个新区域，孤立的闭标记直接丢掉
      out += text.slice(last, match.index)
      stripped = true
      if (!closing) {
        depth = 1
        regionStart = match.index
      }
      last = match.index + match[0].length
      continue
    }
    // 区域内部：内容整段丢弃，只数深度
    stripped = true
    depth += closing ? -1 : 1
    last = match.index + match[0].length
  }
  if (depth > 0) {
    // 已完结的回答里仍不配对：把没配对的标记当孤立标签丢掉，保留其后的正文
    const tail = text.slice(regionStart).replace(new RegExp(TOOL_TAG.source, 'gi'), '')
    return (out + tail).replace(/\n{3,}/g, '\n\n').trim()
  }
  if (!stripped) return text
  out += text.slice(last)
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * 把一条消息的内容块压成纯文本：文本保留、工具调用变一行 `[tool call: name]`、
 * 图片标 `[image]`、思考（reasoning）不入转录。**绝不保留任何工具调用语法**，
 * 否则模型又会照着模仿。
 */
function blocksToText(content, toolArgChars = 200) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') parts.push(block.text)
    else if (block.type === 'tool-call') {
      const name = typeof block.name === 'string' && block.name !== '' ? block.name : 'tool'
      let args = ''
      if (typeof block.arguments === 'string') args = block.arguments
      else if (block.arguments !== undefined) {
        try { args = JSON.stringify(block.arguments) } catch { args = '' }
      }
      parts.push(`[tool call: ${name}]${args === '' ? '' : ` ${args.slice(0, toolArgChars)}`}`)
    } else if (block.type === 'image') parts.push('[image]')
  }
  return parts.join('\n').trim()
}

/**
 * 把会话压成一段转录文本（最近 TRANSCRIPT_MAX 字符），并在末尾附上本次线程里
 * 已经问过的旁支问答，让追问仍然连贯。
 */
function buildTranscript(session, thread) {
  const lines = []
  for (const message of session.deriveMessages()) {
    if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'tool') continue
    const text = blocksToText(message.content)
    if (text === '') continue
    const speaker = message.role === 'tool' ? 'tool result' : message.role
    lines.push(`${speaker}: ${text}`)
  }
  for (const item of thread) {
    lines.push(`user (earlier side question): ${item.question}`)
    lines.push(`you (earlier side answer): ${stripToolMarkup(item.answer)}`)
  }
  const transcript = lines.join('\n\n')
  return transcript.length > TRANSCRIPT_MAX ? transcript.slice(transcript.length - TRANSCRIPT_MAX) : transcript
}

/**
 * 组装这一次临时提问的请求：一条 user 消息（<conversation> + <question>）+ 系统引导词。
 * 无历史、无工具、无 API 层的工具语法 → 模型没有可模仿的样例，也不会以为自己是主会话。
 */
function buildMessages(session, thread, question) {
  const transcript = buildTranscript(session, thread)
  const body = transcript === ''
    ? `<question>\n${question}\n</question>`
    : `<conversation>\n${transcript}\n</conversation>\n\n<question>\n${question}\n</question>`
  return [{ role: 'user', content: [{ type: 'text', text: body }], source: { kind: 'user' } }]
}

module.exports = {
  name: NAME,
  inject: ['webServer', 'agents', 'llm'],
  apply(ctx, config = {}) {
    // 引导词可被组合包/用户 profile 的 config.guidance 覆盖（见本文件顶部说明）。
    const guidance = typeof config.guidance === 'string' && config.guidance.trim() !== ''
      ? config.guidance
      : GUIDANCE

    /** 处理一次临时提问，把回答以 SSE 流式写回。 */
    async function ask(req, res) {
      let body
      try {
        body = await readJson(req)
      } catch (error) {
        fail(res, 400, String(error && error.message ? error.message : error))
        return
      }
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
      const question = typeof body.question === 'string' ? body.question.trim() : ''
      if (sessionId === '') {
        fail(res, 400, 'sessionId is required')
        return
      }
      if (question === '') {
        fail(res, 400, 'question is required')
        return
      }
      const agent = ctx.agents.get(sessionId)
      if (agent === undefined) {
        fail(res, 409, 'this session is not live in the host process')
        return
      }
      const config = resolveCallConfig(ctx, agent)
      if (config === undefined) {
        fail(res, 409, 'no provider/model is available for this session yet')
        return
      }
      if (inflight.has(sessionId)) {
        fail(res, 409, 'a side question is already running for this session')
        return
      }

      const controller = new AbortController()
      inflight.set(sessionId, controller)
      // 客户端断开（Esc、关 tab、刷新）时立刻停掉模型调用。
      res.on('close', () => { if (!res.writableEnded) controller.abort() })

      res.statusCode = 200
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('X-Accel-Buffering', 'no')
      if (typeof res.flushHeaders === 'function') res.flushHeaders()

      const thread = threadOf(sessionId)
      let answer = ''
      let reasoning = ''
      let usage
      let failure
      let finishReason = 'stop'
      const startedAt = Date.now()
      try {
        const messages = buildMessages(agent.session, thread, question)
        const stream = ctx.llm.stream({
          ...config,
          system: guidance,
          messages,
          sessionId,
          signal: controller.signal,
        })
        for await (const chunk of stream) {
          if (chunk.type === 'text-delta') {
            answer += chunk.text
            send(res, { type: 'delta', text: chunk.text })
          } else if (chunk.type === 'reasoning-delta') {
            reasoning += chunk.text
            send(res, { type: 'reasoning', text: chunk.text })
          } else if (chunk.type === 'usage') {
            usage = chunk.usage
          } else if (chunk.type === 'finish') {
            const reason = chunk.reason || {}
            finishReason = reason.kind || 'stop'
            if (reason.kind === 'error' || reason.kind === 'aborted') {
              failure = (reason.failure && reason.failure.message) || reason.kind
            }
            send(res, { type: 'finish', reason: finishReason })
          }
        }
      } catch (error) {
        failure = String(error && error.message ? error.message : error)
      } finally {
        inflight.delete(sessionId)
      }
      const endedAt = Date.now()

      // 用量与起止时间一并回给客户端：面板那行"时间 + 用量"与主会话 turn tail 同一口径。
      send(res, { type: 'usage', usage, startedAt, endedAt })

      if (failure !== undefined) send(res, { type: 'error', message: failure })
      // 只要产生过正文或思考就留下这一轮：只出思考、没出正文时若丢弃，
      // 客户端 setLive(null) 之后整轮（提问 + 思考）会凭空消失。
      if (answer.trim().length > 0 || reasoning.trim().length > 0) {
        // 思考/用量一并留在内存线程里：否则一轮结束、思考行与用量行就从面板里消失了。
        // 重放给模型时只用 answer，不要把 reasoning 再喂回去。
        thread.push({ question, answer, reasoning, usage, startedAt, endedAt, finishReason })
        trimThread(sessionId)
      }
      res.end()
    }

    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/btw-api/ask',
      handler: (req, res) => {
        if (req.method !== 'POST') {
          fail(res, 405, 'POST only')
          return
        }
        void ask(req, res)
      },
    }), 'dsh-btw: ask route')

    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/btw-api/thread',
      handler: (req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const sessionId = url.searchParams.get('sessionId') || ''
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.end(JSON.stringify({ items: sessionId === '' ? [] : threadOf(sessionId).slice() }))
      },
    }), 'dsh-btw: thread route')

    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/btw-api/stop',
      handler: (req, res) => {
        if (req.method !== 'POST') {
          fail(res, 405, 'POST only')
          return
        }
        readJson(req).then((body) => {
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
          const controller = inflight.get(sessionId)
          if (controller !== undefined) controller.abort()
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ ok: true, stopped: controller !== undefined }))
        }, (error) => fail(res, 400, String(error && error.message ? error.message : error)))
      },
    }), 'dsh-btw: stop route')

    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/btw-api/clear',
      handler: (req, res) => {
        if (req.method !== 'POST') {
          fail(res, 405, 'POST only')
          return
        }
        readJson(req).then((body) => {
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
          if (sessionId !== '') threads.delete(sessionId)
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ ok: true }))
        }, (error) => fail(res, 400, String(error && error.message ? error.message : error)))
      },
    }), 'dsh-btw: clear route')
  },
}
