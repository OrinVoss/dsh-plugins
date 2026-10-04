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
const ANSWER_MAX_TOKENS = 4096

/** 追加在问题前的固定指令：告诉模型这是旁支提问、没有工具、只能依据已有上下文。 */
const INSTRUCTION = [
  'The following is a side question ("BTW") about the conversation above.',
  'It is not part of the conversation history, and no tools are available for it:',
  'answer from the conversation above alone, in the language of the question.',
  'If the context does not contain the answer, say so plainly instead of guessing.',
  'Do not emit tool calls.',
].join(' ')

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
    const maxTokens = typeof config.maxTokens === 'number' && config.maxTokens > 0
      ? Math.min(config.maxTokens, ANSWER_MAX_TOKENS)
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

/** 剥掉"写成文本的工具调用"标记：旁支提问没有工具，这类标记没有任何意义，
 *  重放回模型只会诱导它继续乱写。
 *  客户端渲染用的是同一套规则（client.js 的 sanitizeAnswer），两边各自保留一份，
 *  以免宿主半边为了一个正则去 require 客户端模块。 */
const TOOL_MARKUP_OPEN = /<(?:\|{1,2}|｜{1,2})?DSML(?:\|{1,2}|｜{1,2})?[^>]*>|<tool_call>|<tool_calls>|<function_call>/i
const TOOL_MARKUP_CLOSE = /<\/(?:\|{1,2}|｜{1,2})?DSML(?:\|{1,2}|｜{1,2})?[^>]*>|<\/tool_call>|<\/tool_calls>|<\/function_call>/i

/**
 * 剥掉写成文本的工具调用标记。
 * @param source - 模型输出。
 * @returns 清理后的文本。
 */
function stripToolMarkup(source) {
  let text = String(source)
  const open = new RegExp(TOOL_MARKUP_OPEN.source, 'i')
  const close = new RegExp(TOOL_MARKUP_CLOSE.source, 'i')
  for (;;) {
    const found = open.exec(text)
    if (found === null) break
    const rest = text.slice(found.index + found[0].length)
    const paired = close.exec(rest)
    if (paired === null) {
      text = text.slice(0, found.index)
      break
    }
    text = text.slice(0, found.index) + rest.slice(paired.index + paired[0].length)
  }
  return text.replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * 组装这一次临时提问请求的消息数组：完整前缀 + 已在内存里的历史问答 + 本次问题。
 *
 * 历史里那条 assistant 消息**必须带 `source`**：`ctx.llm.stream()` 内部会对每条
 * assistant 消息读 `message.source.replayState`（`forAdapter()`，用于剔除属于别的
 * 适配器的重放状态），缺 `source` 会直接抛
 * "Cannot read properties of undefined (reading 'replayState')"。
 * 这里按当前路由补一个不带 replayState 的 model source，语义上等于正常重放。
 */
function buildMessages(session, thread, question, config) {
  const messages = [...session.deriveMessages()]
  for (const item of thread) {
    messages.push({ role: 'user', content: [{ type: 'text', text: item.question }], source: { kind: 'user' } })
    messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: stripToolMarkup(item.answer) }],
      source: { kind: 'model', provider: config.provider, model: config.model },
    })
  }
  messages.push({ role: 'user', content: [{ type: 'text', text: `${INSTRUCTION}\n\n${question}` }], source: { kind: 'user' } })
  return messages
}

module.exports = {
  name: NAME,
  inject: ['webServer', 'agents', 'llm'],
  apply(ctx) {
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
      res.on('close', () => { controller.abort() })

      res.statusCode = 200
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('X-Accel-Buffering', 'no')
      if (typeof res.flushHeaders === 'function') res.flushHeaders()

      const thread = threadOf(sessionId)
      let answer = ''
      let reasoning = ''
      let failure
      try {
        const messages = buildMessages(agent.session, thread, question, config)
        const stream = ctx.llm.stream({
          ...config,
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
          } else if (chunk.type === 'finish') {
            const reason = chunk.reason || {}
            if (reason.kind === 'error' || reason.kind === 'aborted') {
              failure = (reason.failure && reason.failure.message) || reason.kind
            }
            send(res, { type: 'finish', reason: reason.kind || 'stop' })
          }
        }
      } catch (error) {
        failure = String(error && error.message ? error.message : error)
      } finally {
        inflight.delete(sessionId)
      }

      if (failure !== undefined) send(res, { type: 'error', message: failure })
      if (answer.trim().length > 0) {
        thread.push({ question, answer })
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
