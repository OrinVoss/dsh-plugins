/**
 * dsh-message-edit — 「撤回 / 编辑已发送消息」的宿主半边。
 *
 * 语义（与 ChatGPT / 微信一致的"从这条起回退"）：
 *  - 撤回 = 把 [目标消息 … 当前表面末尾] 这段从模型上下文里遮蔽掉；
 *  - 编辑 = 同样遮蔽，然后把改后的文本作为一条**全新的**用户消息发出去，
 *           于是模型看到的是"改后的文本 + 新回答"，界面里是一条气泡一个回答。
 *
 * 实现方式（不改 DSH 本体）：
 *  会话日志是 append-only 的，模型历史由「表面投影」得出；表面事件带
 *  `surfaceOp`，取值 `'append'` 或 `{ op:'replace', startSeq, endSeq }`。
 *  压缩（compaction）就是用 replace 遮蔽一段范围。本插件同样追加一条
 *  replace 事件，把 [目标 … 末尾] 换成**一条 content 为空的 system/message**：
 *    - `deriveEventMessage()` 对空 content 的 system/developer/assistant 返回 null
 *      → 模型完全看不到（user/message 即使空 content 也会投影成消息，所以不能用）；
 *    - assistant/message 禁止携带 sourceEventSeqs，而替换事件必须带 → 不能用；
 *    - developer/message 会被客户端渲染成"注入上下文"一行 → 不干净；
 *    - 空的 system/message 在客户端只被 system-message 定义"认领"但 `buildViewNode`
 *      返回 null（非 append），因此界面天然不显示它；
 *    - 只要不覆盖表面节点 0（系统提示词），就不触发头部保护。
 *
 *  注意：客户端的对话记录是**原始日志视图**，替换事件本身不会让旧气泡消失
 *  （压缩也一样，只影响模型上下文）。所以界面侧的隐藏由客户端半边负责：
 *  本文件在 state 路由里返回「被遮蔽的轮次」，客户端据此隐藏那些轮次的行。
 *
 * 标记自己的替换事件：把空 system/message 的 `message.id` 写成 `dsh-recall:<uuid>`。
 *  每个校验器只要求 message.id 是非空字符串（见 dsh-session 的
 *  assertMessageEventShape），因此这是合法的、且可稳定识别的标记，不需要额外状态。
 *
 * 对外 HTTP 路由（与 btw / sysmon 同一套 webServer 约定）：
 *   GET  /message-edit-api/state?sessionId=      → 会话状态：是否在跑、可编辑的尾部消息、已遮蔽的轮次
 *   POST /message-edit-api/apply                 → { sessionId, seq, action:'retract'|'edit', text? }
 *   POST /message-edit-api/selftest              → 在**临时会话**上验证替换机制（不碰真实会话）
 */

const os = require('node:os')
const { randomUUID } = require('node:crypto')

const NAME = 'dsh-message-edit'

/** 空 system/message 替换事件的 message.id 前缀：用来把自己的事件和别的事件区分开。 */
const MARK = 'dsh-recall:'

/** 单次替换允许遮蔽的最大表面节点数（防御性上限）。 */
const MAX_SHADOW_NODES = 4000

// ----------------------------------------------------------------- 小工具

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(payload))
}

function fail(res, status, message, extra) {
  sendJson(res, status, { ok: false, error: { message: String(message), ...(extra ?? {}) } })
}

function readJson(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw === '') return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error.message}`))
      }
    })
  })
}

/** 一条事件是不是本插件写下的遮蔽替换。 */
function isRecallCut(event) {
  if (event.type !== 'system/message') return false
  const op = event.surfaceOp
  if (op === undefined || op === 'append') return false
  const id = event.data && event.data.message && event.data.message.id
  return typeof id === 'string' && id.startsWith(MARK)
}

/**
 * 建立 seq → 轮次 的索引。
 * @param events - 会话事件（含日志事件）。
 * @returns Map<number, number>，值为该 seq 所属的 turn（turn/start 之前为 0）。
 */
function seqTurns(events) {
  const map = new Map()
  let turn = 0
  for (const event of events) {
    if (event.type === 'turn/start') turn = event.data.turn
    map.set(event.seq, turn)
  }
  return map
}

/** 日志末尾是否有未闭合的轮次（视为"正在跑"）。 */
function hasOpenTurn(events) {
  let open = false
  for (const event of events) {
    if (event.type === 'turn/start') open = true
    else if (event.type === 'turn/end') open = false
  }
  return open
}

/** 从被遮蔽的表面节点集合算出被遮蔽的轮次集合。 */
function hiddenTurnsOf(shadowedSeqs, turns) {
  const set = new Set()
  for (const seq of shadowedSeqs) {
    const turn = turns.get(seq)
    if (typeof turn === 'number') set.add(turn)
  }
  return [...set].sort((a, b) => a - b)
}

/** 读取一条用户消息里的纯文本（用于预填编辑框）。 */
function messageText(message) {
  const blocks = Array.isArray(message && message.content) ? message.content : []
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** 当前日志里最大的轮次编号。 */
function lastTurn(events) {
  let turn = 0
  for (const event of events) if (event.type === 'turn/start' && event.data.turn > turn) turn = event.data.turn
  return turn
}

// ----------------------------------------------------------------- 插件

module.exports = {
  name: NAME,
  inject: ['webServer', 'sessions'],
  apply(ctx, config = {}) {
    const allowRunning = config.allowRunning === true

    /** 取活着的会话；没有就返回 undefined。 */
    function liveSession(sessionId) {
      return typeof sessionId === 'string' && sessionId !== '' ? ctx.sessions.get(sessionId) : undefined
    }

    /** 组装某个会话的状态快照。 */
    function sessionState(sessionId) {
      const attached = liveSession(sessionId)
      if (attached === undefined) return { ok: true, live: false, idle: true, hiddenTurns: [], ops: [] }
      const events = attached.snapshotEvents()
      const turns = seqTurns(events)
      const ops = []
      const hidden = new Set()
      for (const event of events) {
        if (!isRecallCut(event)) continue
        const op = event.surfaceOp
        const shadowed = Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : []
        const opTurns = hiddenTurnsOf(shadowed, turns)
        for (const turn of opTurns) hidden.add(turn)
        ops.push({
          seq: event.seq,
          startSeq: op.startSeq,
          endSeq: op.endSeq,
          shadowed: shadowed.length,
          turns: opTurns,
          turn: turns.get(op.startSeq) ?? 0,
        })
      }
      // 可编辑/撤回的候选：表面上的 user/message 追加节点。
      const nodes = attached.surface.nodes
      const targets = []
      for (const seq of nodes) {
        const event = attached.eventAt(seq)
        if (event === undefined || event.type !== 'user/message') continue
        if (event.surfaceOp !== 'append') continue
        if (event.data.source && event.data.source.kind !== 'user') continue
        targets.push({
          seq,
          id: String(event.data.id),
          turn: turns.get(seq) ?? 0,
          text: messageText(event.data),
          last: seq === nodes[nodes.length - 1] || nodes.indexOf(seq) === nodes.length - 1,
        })
      }
      return {
        ok: true,
        live: true,
        idle: !hasOpenTurn(events),
        seq: events.length === 0 ? 0 : events[events.length - 1].seq,
        lastTurn: lastTurn(events),
        hiddenTurns: [...hidden].sort((a, b) => a - b),
        ops,
        targets,
      }
    }

    /** 真实执行一次撤回 / 编辑。 */
    async function applyRecall(sessionId, seq, action, text) {
      const session = liveSession(sessionId)
      if (session === undefined) throw Object.assign(new Error('session/not-live'), { status: 409 })

      const events = session.snapshotEvents()
      if (!allowRunning && hasOpenTurn(events)) {
        throw Object.assign(new Error('session/busy: 当前轮次还没结束，请等它跑完再撤回或编辑'), { status: 409 })
      }

      const target = session.eventAt(seq)
      if (target === undefined) throw Object.assign(new Error(`seq ${seq} 不存在`), { status: 400 })
      if (target.type !== 'user/message') throw Object.assign(new Error(`seq ${seq} 不是用户消息（${target.type}）`), { status: 400 })
      if (target.surfaceOp !== 'append') throw Object.assign(new Error(`seq ${seq} 不是追加型表面节点，不能作为撤回目标`), { status: 400 })

      const nodes = [...session.surface.nodes]
      const startIdx = nodes.indexOf(seq)
      if (startIdx === -1) throw Object.assign(new Error(`seq ${seq} 已不在当前表面上`), { status: 409 })
      const endSeq = nodes[nodes.length - 1]
      const shadowed = nodes.slice(startIdx)
      if (shadowed.length === 0) throw Object.assign(new Error('替换范围为空'), { status: 400 })
      if (shadowed.length > MAX_SHADOW_NODES) throw Object.assign(new Error(`遮蔽范围过大（${shadowed.length} 个表面节点）`), { status: 400 })

      // 节点 0 是系统提示词：只有同为 system/message 且只覆盖它自己时才能替换。
      const head = session.eventAt(nodes[0])
      if (startIdx === 0 && head !== undefined && head.type === 'system/message') {
        throw Object.assign(new Error('不能撤回/编辑表面节点 0（系统提示词）'), { status: 400 })
      }

      const turns = seqTurns(events)
      const opTurns = hiddenTurnsOf(shadowed, turns)
      const turn = turns.get(seq) ?? 0
      const step = 1

      // 用空 content 的 system/message 遮蔽整段：模型投影为 null，界面也不显示。
      const cut = session.append(
        'system/message',
        {
          turn,
          step,
          message: {
            id: `${MARK}${randomUUID()}`,
            role: 'system',
            source: { kind: 'system-prompt' },
            content: [],
          },
        },
        { surfaceOp: { op: 'replace', startSeq: seq, endSeq }, sourceEventSeqs: shadowed },
      )

      await ctx.sessions.flush(session)

      let prompted = false
      let promptError
      if (action === 'edit') {
        const controller = ctx.get('sessionController')
        if (controller === undefined) {
          promptError = 'sessionController 不可用：历史已改写，但没能自动重发，请手动发送。'
        } else {
          try {
            await controller.prompt(
              {
                requestId: randomUUID(),
                sessionId,
                mode: 'queue',
                content: [{ type: 'text', text }],
              },
              undefined,
            )
            prompted = true
          } catch (error) {
            promptError = error && error.message ? error.message : String(error)
            ctx.logger?.warn?.(`[${NAME}] prompt 失败（session ${sessionId}）：${promptError}`)
            if (error && error.stack) ctx.logger?.warn?.(String(error.stack).slice(0, 800))
          }
        }
      }

      const result = {
        ok: true,
        action,
        cutSeq: cut.seq,
        startSeq: seq,
        endSeq,
        shadowed: shadowed.length,
        hiddenTurns: opTurns,
        prompted,
        ...(promptError === undefined ? {} : { promptError }),
      }
      recentOps.push({ time: Date.now(), sessionId, action, seq, ...(promptError === undefined ? {} : { promptError }) })
      if (recentOps.length > 20) recentOps.shift()
      return result
    }

    // ----------------------------------------------------------- 路由

    /** 客户端上报的渲染错误（环形缓冲，方便真机排查）。 */
    const clientErrors = []
    /** 最近的 apply 记录（含 prompt 失败原因），供真机排查。 */
    const recentOps = []

    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/message-edit-api/client-error',
      handler: (req, res) => {
        if (req.method !== 'POST') return fail(res, 405, 'POST only')
        readJson(req).then((body) => {
          const entry = {
            time: Date.now(),
            where: typeof body.where === 'string' ? body.where : '?',
            message: typeof body.message === 'string' ? body.message : '?',
            stack: typeof body.stack === 'string' ? body.stack.slice(0, 2000) : undefined,
          }
          clientErrors.push(entry)
          if (clientErrors.length > 30) clientErrors.shift()
          ctx.logger?.warn?.(`[${NAME}] client error at ${entry.where}: ${entry.message}`)
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end('{"ok":true}')
        }, (error) => fail(res, 400, error && error.message ? error.message : error))
      },
    }), 'dsh-message-edit: client-error route')

    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/message-edit-api/debug/prompt',
      handler: (req, res) => {
        if (req.method !== 'POST') return fail(res, 405, 'POST only')
        readJson(req).then(async (body) => {
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
          const text = typeof body.text === 'string' ? body.text : 'ping'
          const controller = ctx.get('sessionController')
          const agents = ctx.get('agents')
          const report = {
            ok: false,
            sessionId,
            hasController: controller !== undefined,
            hasAgents: agents !== undefined,
            liveSession: liveSession(sessionId) !== undefined,
            liveAgent: agents === undefined ? null : agents.get(sessionId) !== undefined,
            attempts: [],
          }
          if (controller === undefined) return sendJson(res, 200, report)
          const request = { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }] }
          const attempt = async (label, run) => {
            try {
              const value = await run()
              report.attempts.push({ label, ok: true, value })
              report.ok = true
              return true
            } catch (error) {
              report.attempts.push({ label, ok: false, error: String(error && error.message ? error.message : error), code: error && error.code })
              return false
            }
          }
          await attempt('direct', () => controller.prompt(request, undefined))
          if (report.ok !== true && agents !== undefined) {
            const agent = agents.get(sessionId)
            if (agent !== undefined) {
              await attempt('withInitiator', () => agents.withInitiator(agent, () => controller.prompt(request, undefined)))
            }
          }
          sendJson(res, 200, report)
        }, (error) => fail(res, 400, error && error.message ? error.message : error))
      },
    }), 'dsh-message-edit: debug prompt route')

    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/message-edit-api/state',
      handler: (req, res) => {
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1')
          sendJson(res, 200, {
            ...sessionState(url.searchParams.get('sessionId') || ''),
            clientErrors,
            recentOps,
            liveSessions: ctx.sessions.list().map((item) => ({ id: item.id, createdAt: item.header?.createdAt, seq: item.seq })),
          })
        } catch (error) {
          fail(res, 500, error && error.message ? error.message : error)
        }
      },
    }), 'dsh-message-edit: state route')

    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/message-edit-api/apply',
      handler: (req, res) => {
        if (req.method !== 'POST') return fail(res, 405, 'POST only')
        readJson(req).then(async (body) => {
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
          const seq = Number(body.seq)
          const action = body.action === 'edit' ? 'edit' : body.action === 'retract' ? 'retract' : ''
          const text = typeof body.text === 'string' ? body.text : ''
          if (sessionId === '') return fail(res, 400, 'sessionId is required')
          if (!Number.isSafeInteger(seq) || seq < 0) return fail(res, 400, 'seq must be a non-negative integer')
          if (action === '') return fail(res, 400, "action must be 'retract' or 'edit'")
          if (action === 'edit' && text.trim() === '') return fail(res, 400, 'edit requires non-empty text')
          try {
            sendJson(res, 200, await applyRecall(sessionId, seq, action, text))
          } catch (error) {
            fail(res, (error && error.status) || 500, error && error.message ? error.message : error)
          }
        }, (error) => fail(res, 400, error && error.message ? error.message : error))
      },
    }), 'dsh-message-edit: apply route')

    /**
     * 自检：在**临时会话**（prepare 出来的、不进 store）上验证
     * 「追加 → 替换 → deriveMessages」这条链路，不碰任何真实会话。
     */
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/message-edit-api/selftest',
      handler: (req, res) => {
        if (req.method !== 'POST') return fail(res, 405, 'POST only')
        const report = { ok: false, steps: [], failures: [] }
        const step = (name, detail) => report.steps.push({ name, ...(detail === undefined ? {} : { detail }) })
        try {
          const session = ctx.sessions.prepare(undefined, { meta: { cwd: os.tmpdir() } })
          step('prepare', { id: session.id })
          const now = Date.now()
          const mkUser = (id, text) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
          const mkAssistant = (id, text) => ({
            turn: 1,
            step: 1,
            message: { id, role: 'assistant', source: { kind: 'model', provider: 'test', model: 'test' }, content: [{ type: 'text', text }] },
            stream: [],
          })
          session.append('system/message', {
            turn: 1,
            step: 1,
            message: { id: 'sys-1', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'SYS' }] },
          }, { surfaceOp: 'append' })
          session.append('turn/start', { turn: 1 })
          session.append('step/start', { turn: 1, step: 1 })
          const u1 = session.append('user/message', mkUser('u-1', 'hello one'), { surfaceOp: 'append' })
          session.append('assistant/message', mkAssistant('a-1', 'answer one'), { surfaceOp: 'append' })
          session.append('step/end', { turn: 1, step: 1 })
          session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
          session.append('turn/start', { turn: 2 })
          session.append('step/start', { turn: 2, step: 1 })
          const u2 = session.append('user/message', mkUser('u-2', 'hello two'), { surfaceOp: 'append' })
          session.append('assistant/message', mkAssistant('a-2', 'answer two'), { surfaceOp: 'append' })
          session.append('step/end', { turn: 2, step: 1 })
          session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
          step('seed', { seq: session.seq, surface: [...session.surface.nodes] })

          const before = session.deriveMessages().map((m) => `${m.role}:${messageText(m) || '(empty)'}`)
          step('derive-before', before)

          // 事件 12 是 u2。从 u2 起遮蔽到末尾。
          const nodes = [...session.surface.nodes]
          const startIdx = nodes.indexOf(u2.seq)
          const shadowed = nodes.slice(startIdx)
          const cut = session.append('system/message', {
            turn: 2,
            step: 1,
            message: { id: `${MARK}${randomUUID()}`, role: 'system', source: { kind: 'system-prompt' }, content: [] },
          }, { surfaceOp: { op: 'replace', startSeq: u2.seq, endSeq: nodes[nodes.length - 1] }, sourceEventSeqs: shadowed })
          step('replace', { cutSeq: cut.seq, startSeq: u2.seq, shadowed })

          const after = session.deriveMessages().map((m) => `${m.role}:${messageText(m) || '(empty)'}`)
          step('derive-after', after)

          const afterSurface = [...session.surface.nodes]
          step('surface-after', afterSurface)

          // 断言：u2 与它的回答都不再出现在模型历史里；u1 与 a1 仍在。
          if (!after.includes('user:hello one')) report.failures.push('替换后 u1 丢了')
          if (!after.includes('assistant:answer one')) report.failures.push('替换后 a1 丢了')
          if (after.includes('user:hello two')) report.failures.push('替换后 u2 仍在模型历史里')
          if (after.includes('assistant:answer two')) report.failures.push('替换后 a2 仍在模型历史里')
          if (after.some((line) => line.startsWith('system:(empty)'))) report.failures.push('空 system 节点泄漏到了模型历史')
          if (afterSurface.includes(u2.seq)) report.failures.push('u2 仍在当前表面上')
          if (afterSurface[afterSurface.length - 1] !== cut.seq) report.failures.push('替换节点没有落在范围起点上')

          // 再验一次：撤回第一条用户消息（含全部轮次）也只留系统提示词。
          report.ok = report.failures.length === 0
          report.ms = Date.now() - now
          sendJson(res, 200, report)
        } catch (error) {
          report.failures.push(error && error.stack ? error.stack : String(error))
          sendJson(res, 200, report)
        }
      },
    }), 'dsh-message-edit: selftest route')

    ctx.logger?.info?.(`[${NAME}] routes ready: /message-edit-api/{state,apply,selftest}`)
  },
}
