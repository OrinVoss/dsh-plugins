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
 *  replace 事件，把 [目标 … 末尾] 换成一个遮蔽节点。
 *
 * 遮蔽节点为什么必须是 `user/message`（2026-10-10 修正，旧版是致命 bug）：
 *    - format v4 的 STEP_EVENT_TYPES = {system/message, developer/message,
 *      assistant/attempt}，这三类事件的 `data.turn/step` **必须等于当前打开的
 *      turn+step**（dsh-session-format-v3-to-v4 的 Relationships.requireStep）。
 *      撤回/编辑发生在**空闲**（两轮之间）时没有任何打开的 step，所以旧版
 *      「空 content 的 system/message」写进日志后，**整条会话下次加载必被判为
 *      corrupt**（system/message does not match an open turn and step）。
 *    - assistant/message、tool/result 同样要求打开的 step，且 assistant/message
 *      禁止携带 sourceEventSeqs；developer/message 会被渲染成"注入上下文"。
 *    - user/message 是唯一的**非 step 表面类型**：任何位置都能携带
 *      surfaceOp:replace + sourceEventSeqs（DSH 自己的压缩就是用它当替换节点：
 *      `user/message` + source.kind = 'compact-checkpoint'）。
 *    - 代价是 `deriveEventMessage()` 对 user/message 一律返回消息本身，所以遮蔽
 *      节点会被模型看到一行占位文本（见 RECALL_TEXT）。这是"合法且可加载"与
 *      "模型完全看不到"之间的取舍——DSH 没有给插件留"自定义隐藏事件"的口子：
 *      新事件类型会被 validateStoredEvents 以 unknown event type 拒绝，只有内核
 *      名单里的 image/offload 能挂 message projection。
 *
 *  注意：客户端的对话记录是**原始日志视图**，替换事件本身不会让旧气泡消失
 *  （压缩也一样，只影响模型上下文）。所以界面侧的隐藏由客户端半边负责：
 *  本文件在 state 路由里返回「被遮蔽的轮次」，客户端据此隐藏那些轮次的行。
 *
 * 标记自己的替换事件：`message.id` 写成 `dsh-recall:<uuid>`、`source.kind` 写成
 *  `message-edit`（两个都是格式允许的取值），用于稳定识别，不需要额外状态。
 *  兼容旧日志里 content 为空的 `system/message` 遮蔽事件（那批已由
 *  `_sessdiag/repair_logs.py` 挪到打开的 step 里修好，这里只负责仍能识别它们）。
 *
 * 对外 HTTP 路由（与 btw / sysmon 同一套 webServer 约定）：
 *   GET  /message-edit-api/state?sessionId=      → 会话状态：是否在跑、可编辑的尾部消息、已遮蔽的轮次
 *   POST /message-edit-api/apply                 → { sessionId, seq, action:'retract'|'edit', text? }
 *   POST /message-edit-api/selftest              → 在**临时会话**上验证替换机制（不碰真实会话）
 */

const os = require('node:os')
const { randomUUID } = require('node:crypto')

const NAME = 'dsh-message-edit'

/** 遮蔽事件的 message.id 前缀 + source.kind：用来把自己的事件和别的事件区分开。 */
const MARK = 'dsh-recall:'
const RECALL_SOURCE = 'message-edit'

/** 遮蔽节点对模型可见的占位文本（user/message 一定会投影成消息）。 */
/**
 * 遮蔽节点的折叠摘要。官方 Chat 的注入行（ContextInjectionRow）在 source 上读
 * `form`（已知取值："instructions" / "catalog" / "snapshot" / "notice" / "relay" / "recall"）
 * 和 notice 形态的 `summary`：form 不写只会退化成一层"opaque"原始文本，写了 notice + summary
 * 就能在**折叠状态**下讲清发生了什么（这才是原生注入行的样子）。
 */
const RECALL_NOTICE = {
  retract: '已撤回这条消息及其之后的对话，不再进入模型上下文',
  edit: '已改写这条消息，并从这条起重新生成',
}

const RECALL_TEXT = {
  retract: '（用户撤回了一段对话，其中内容已不再可见，请不要再引用它。）',
  edit: '（用户撤回并改写了下面这条消息。）',
}

/** 单次替换允许遮蔽的最大表面节点数（防御性上限）。 */
const MAX_SHADOW_NODES = 4000

/** 自检报告里的检查版本号：宿主热更后从这里确认新代码真的在跑。 */
const CHECKS_VERSION = 2

/**
 * `sourceEventSeqs` 是区间编码（seq 或 [start,end]），摊平后才能查轮次。
 * @param value - 事件上的 sourceEventSeqs。
 * @returns 升序去重的 seq 数组。
 */
function expandEventSeqs(value) {
  const out = []
  for (const item of Array.isArray(value) ? value : []) {
    if (Array.isArray(item) && item.length === 2 && Number.isSafeInteger(item[0]) && Number.isSafeInteger(item[1])) {
      for (let seq = item[0]; seq <= item[1]; seq += 1) out.push(seq)
    } else if (Number.isSafeInteger(item)) out.push(item)
  }
  return [...new Set(out)].sort((a, b) => a - b)
}

/**
 * 日志自检：step 作用域事件（system/message、developer/message、assistant/attempt）
 * 的 turn/step 必须等于当时打开的 turn+step。旧版把遮蔽事件写成空闲处的
 * system/message，破坏的正是这条不变量，导致会话下次加载被判 corrupt。
 * @param events - 会话事件。
 * @returns 违规描述数组（空 = 合法）。
 */
function stepScopeViolations(events) {
  const stepTypes = new Set(['system/message', 'developer/message', 'assistant/attempt'])
  const problems = []
  let turn = null
  let step = null
  for (const event of events) {
    const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
    if (event.type === 'turn/start') { turn = data.turn; step = null }
    else if (event.type === 'turn/end') { turn = null; step = null }
    else if (event.type === 'step/start') { step = data.step }
    else if (event.type === 'step/end') { step = null }
    if (stepTypes.has(event.type) && !(turn !== null && step !== null && data.turn === turn && data.step === step)) {
      problems.push(`seq ${event.seq} ${event.type} turn=${data.turn} step=${data.step} vs open turn=${turn} step=${step}`)
    }
  }
  return problems
}

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

/** 一条事件是不是本插件写下的遮蔽替换（新形态 user/message + 旧形态 system/message 都认）。 */
function isRecallCut(event) {
  const op = event.surfaceOp
  if (op === undefined || op === 'append') return false
  if (event.type === 'user/message') {
    const data = event.data
    return data !== null && typeof data === 'object'
      && typeof data.id === 'string' && data.id.startsWith(MARK)
      && data.source !== null && typeof data.source === 'object' && data.source.kind === RECALL_SOURCE
  }
  // 旧形态：content 为空的 system/message（已由 _sessdiag/repair_logs.py 挪进打开的 step）
  if (event.type !== 'system/message') return false
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
        const shadowed = expandEventSeqs(event.sourceEventSeqs)
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

      // 遮蔽节点必须是 user/message：只有它不是 step 作用域事件，才能在"空闲"
      // （没有打开的 turn/step）时合法携带 surfaceOp:replace。写成 system/message
      // 会让整条日志下次加载时报 "system/message does not match an open turn and step"。
      // 代价：user/message 一定会投影成消息，所以遮蔽节点对模型显示为一行占位文本。
      const cut = session.append(
        'user/message',
        {
          id: `${MARK}${randomUUID()}`,
          role: 'user',
          source: { kind: RECALL_SOURCE, form: 'notice', summary: RECALL_NOTICE[action] },
          content: [{ type: 'text', text: RECALL_TEXT[action] }],
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
            // ⚠️ signal 必须是**真的** AbortSignal：prompt 内部会调 signal.throwIfAborted()，
            // 传 undefined 会抛 "Cannot read properties of undefined (reading 'throwIfAborted')"。
            await controller.prompt(
              {
                requestId: randomUUID(),
                sessionId,
                mode: 'queue',
                content: [{ type: 'text', text }],
              },
              AbortSignal.timeout(60_000),
            )
            prompted = true
          } catch (error) {
            promptError = error && error.message ? error.message : String(error)
            ctx.logger?.warn?.(`[${NAME}] prompt 失败（session ${sessionId}）：${promptError}`)
            if (error && error.stack) ctx.logger?.warn?.(String(error.stack).slice(0, 800))
          }
        }
      }

      // 写完之后再验一遍日志合法性：这是旧 bug 的回归闸，任何一步退回旧写法都会在这里爆出来。
      const logProblems = stepScopeViolations(session.snapshotEvents())
      if (logProblems.length > 0) ctx.logger?.warn?.(`[${NAME}] 遮蔽后日志不合法（session ${sessionId}）：${logProblems[0]}`)

      const result = {
        ok: true,
        action,
        cutSeq: cut.seq,
        startSeq: seq,
        endSeq,
        shadowed: shadowed.length,
        hiddenTurns: opTurns,
        prompted,
        logProblems,
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
          const signal = AbortSignal.timeout(60_000)
          await attempt('direct', () => controller.prompt(request, signal))
          if (report.ok !== true && agents !== undefined) {
            const agent = agents.get(sessionId)
            if (agent !== undefined) {
              await attempt('withInitiator', () => agents.withInitiator(agent, () => controller.prompt(request, signal)))
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
     * 另含两条硬闸：① 写完遮蔽事件后日志必须仍通过 step 作用域校验；
     * ② 反向构造旧版非法日志，检查器必须能抓到（否则旧 bug 会静默复活）。
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
          step('prepare', { id: session.id, checks: CHECKS_VERSION })
          const now = Date.now()
          const mkUser = (id, text) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
          const mkAssistant = (id, text) => ({
            turn: 1,
            step: 1,
            message: { id, role: 'assistant', source: { kind: 'model', provider: 'test', model: 'test' }, content: [{ type: 'text', text }] },
            stream: [],
          })
          // 顺序要和真实日志一致：系统提示词落在第一个打开的 step 里（否则 step 作用域校验不过）。
          session.append('turn/start', { turn: 1 })
          session.append('step/start', { turn: 1, step: 1 })
          session.append('system/message', {
            turn: 1,
            step: 1,
            message: { id: 'sys-1', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'SYS' }] },
          }, { surfaceOp: 'append' })
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

          // 从 u2 起遮蔽到末尾；此刻两轮都已结束（无打开的 step），正是旧版把日志写坏的位置。
          const nodes = [...session.surface.nodes]
          const startIdx = nodes.indexOf(u2.seq)
          const shadowed = nodes.slice(startIdx)
          const cut = session.append('user/message', {
            id: `${MARK}${randomUUID()}`,
            role: 'user',
            source: { kind: RECALL_SOURCE, form: 'notice', summary: RECALL_NOTICE.retract },
            content: [{ type: 'text', text: RECALL_TEXT.retract }],
          }, { surfaceOp: { op: 'replace', startSeq: u2.seq, endSeq: nodes[nodes.length - 1] }, sourceEventSeqs: shadowed })
          step('replace', { cutSeq: cut.seq, startSeq: u2.seq, shadowed, type: cut.type })

          const after = session.deriveMessages().map((m) => `${m.role}:${messageText(m) || '(empty)'}`)
          step('derive-after', after)

          const afterSurface = [...session.surface.nodes]
          step('surface-after', afterSurface)

          // 断言：u2 与它的回答都不再出现在模型历史里；u1 与 a1 仍在。
          if (!after.includes('user:hello one')) report.failures.push('替换后 u1 丢了')
          if (!after.includes('assistant:answer one')) report.failures.push('替换后 a1 丢了')
          if (after.includes('user:hello two')) report.failures.push('替换后 u2 仍在模型历史里')
          if (after.includes('assistant:answer two')) report.failures.push('替换后 a2 仍在模型历史里')
          if (!after.some((line) => line.includes(RECALL_TEXT.retract))) report.failures.push('遮蔽节点没有投影到模型历史（user/message 必然会投影）')
          if (afterSurface.includes(u2.seq)) report.failures.push('u2 仍在当前表面上')
          if (afterSurface[afterSurface.length - 1] !== cut.seq) report.failures.push('替换节点没有落在范围起点上')

          // 硬闸 ①：写完遮蔽事件后，日志必须仍然通过 step 作用域校验（旧 bug 的回归）。
          const violations = stepScopeViolations(session.snapshotEvents())
          step('log-legal', { violations })
          if (violations.length > 0) report.failures.push(`遮蔽事件让日志不可加载：${violations[0]}`)

          // 硬闸 ②：反向构造旧版那种"空闲时写 system/message"的日志，检查器必须能抓到。
          const bad = ctx.sessions.prepare(undefined, { meta: { cwd: os.tmpdir() } })
          bad.append('turn/start', { turn: 1 })
          bad.append('step/start', { turn: 1, step: 1 })
          bad.append('system/message', { turn: 1, step: 1, message: { id: 'sys-2', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'S' }] } }, { surfaceOp: 'append' })
          const badUser = bad.append('user/message', mkUser('u-9', 'x'), { surfaceOp: 'append' })
          bad.append('step/end', { turn: 1, step: 1 })
          bad.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
          bad.append('system/message', { turn: 1, step: 1, message: { id: `${MARK}bad`, role: 'system', source: { kind: 'system-prompt' }, content: [] } }, { surfaceOp: { op: 'replace', startSeq: badUser.seq, endSeq: badUser.seq }, sourceEventSeqs: [badUser.seq] })
          const caught = stepScopeViolations(bad.snapshotEvents())
          step('detector-catches-old-bug', { caught })
          if (caught.length === 0) report.failures.push('检查器抓不到旧版那种非法日志，回归闸失效')

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
