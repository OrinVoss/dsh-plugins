'use strict'
/* =====================================================================
 * dsh-pet —— 宿主半边
 *
 * 职责只有一个：把「Agent 现在在干什么」压成一个极小的活动快照，供浏览器端
 * 的宠物轮询（`GET /pet-api/activity`）。
 *
 *   session/event        → turn/start、turn/end、tool/call、tool/result、
 *                          approval/asked、approval/decided、assistant/message
 *   api-session/status   → 哪个会话正在跑
 *   agent/error          → 报错
 *   subagent/start|end   → 派了几个子代理（宠物身边的小跟班）
 *
 * 只读事件：不注册工具、不写任何会话数据、不拦截任何 waterfall（因此不可能
 * 拖慢或改变 Agent 的行为）。状态全在内存里，宿主进程重启即清零。
 * =================================================================== */

const RECENT_MAX = 8

/** 建一份空状态。`now` 只用来标记起点。 */
function createState(now) {
  return {
    startedAt: now,
    running: new Set(),        // 正在跑的会话 id
    activeTools: new Map(),    // callId → 工具名（已发出 call、还没 result）
    approvals: new Set(),      // 还没决定的授权请求 id
    approvalReason: null,
    lastTool: null,            // { name, at }
    lastError: null,           // { message, at }
    lastTurnStartAt: null,
    lastTurnEndAt: null,
    turns: 0,                  // 本次宿主启动以来完成的回合数
    toolCalls: 0,
    subagents: 0,
    tokens: 0,                 // 累计 input+output token（喂养值）
    recent: []                 // [{ kind, text, at }] 最近事件，给宠物气泡用
  }
}

function pushRecent(state, kind, text, at) {
  state.recent.unshift({ kind: kind, text: String(text || '').slice(0, 40), at: at })
  if (state.recent.length > RECENT_MAX) state.recent.length = RECENT_MAX
}

function errorMessage(error) {
  if (error === null || error === undefined) return '未知错误'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string' && error.message !== '') return error.message
  try {
    return JSON.stringify(error).slice(0, 200)
  } catch (e) {
    return String(error)
  }
}

/** 把一条会话事件折进状态（纯函数式：只改传入的 state，返回是否产生变化）。 */
function reduceSessionEvent(state, event, now) {
  if (event === null || typeof event !== 'object') return false
  const data = event.data || {}
  switch (event.type) {
    case 'turn/start':
      state.lastTurnStartAt = now
      pushRecent(state, 'turn', '回合 ' + String(data.turn || '') + ' 开始', now)
      return true
    case 'turn/end':
      state.turns += 1
      state.lastTurnEndAt = now
      pushRecent(state, 'done', '收工啦', now)
      return true
    case 'tool/call': {
      const callId = String(data.callId || '')
      const name = String(data.name || '工具')
      if (callId !== '') state.activeTools.set(callId, name)
      state.toolCalls += 1
      state.lastTool = { name: name, at: now }
      pushRecent(state, 'tool', name, now)
      return true
    }
    case 'tool/result': {
      const message = data.message || {}
      const callId = String(message.toolCallId || data.callId || '')
      if (callId !== '') state.activeTools.delete(callId)
      if (message.isError === true) {
        state.lastError = { message: '工具执行出错', at: now }
        pushRecent(state, 'error', '工具出错', now)
      }
      return true
    }
    case 'approval/asked': {
      const id = String(data.id || '')
      if (id !== '') state.approvals.add(id)
      state.approvalReason = typeof data.reason === 'string' ? data.reason : null
      pushRecent(state, 'ask', '等你点头', now)
      return true
    }
    case 'approval/decided': {
      const id = String(data.id || '')
      if (id !== '') state.approvals.delete(id)
      if (state.approvals.size === 0) state.approvalReason = null
      pushRecent(state, 'ok', '授权已决定', now)
      return true
    }
    case 'assistant/message': {
      const usage = data.usage || {}
      const input = Number(usage.inputTokens) || 0
      const output = Number(usage.outputTokens) || 0
      state.tokens += input + output
      return true
    }
    default:
      return false
  }
}

/** 会话是否在跑。 */
function reduceSessionStatus(state, sessionId, running, now) {
  const key = String(sessionId || 'unknown')
  if (running) state.running.add(key)
  else state.running.delete(key)
  return true
}

function reduceAgentError(state, payload, now) {
  const error = payload && typeof payload === 'object' ? payload.error : payload
  state.lastError = { message: errorMessage(error), at: now }
  pushRecent(state, 'error', errorMessage(error), now)
  return true
}

function reduceSubagent(state, delta, now) {
  state.subagents = Math.max(0, state.subagents + delta)
  pushRecent(state, delta > 0 ? 'sub' : 'ok', delta > 0 ? '小跟班来了' : '小跟班走了', now)
  return true
}

/** 快照：只带客户端需要的字段，全部 JSON 安全。 */
function snapshot(state, now) {
  return {
    startedAt: state.startedAt,
    now: now,
    running: state.running.size > 0,
    runningSessions: state.running.size,
    activeTools: state.activeTools.size,
    lastTool: state.lastTool,
    awaitingApproval: state.approvals.size > 0,
    approvalReason: state.approvals.size > 0 ? state.approvalReason : null,
    lastError: state.lastError,
    lastTurnStartAt: state.lastTurnStartAt,
    lastTurnEndAt: state.lastTurnEndAt,
    turns: state.turns,
    toolCalls: state.toolCalls,
    subagents: state.subagents,
    tokens: state.tokens,
    recent: state.recent
  }
}

module.exports = {
  inject: ['webServer'],
  apply(ctx) {
    const state = createState(Date.now())
    const attached = []
    const failed = []

    /** 挂一个只读监听；事件名在当前部署里不存在时只记一笔，不影响插件加载。 */
    function listen(name, handler) {
      try {
        const dispose = ctx.on(name, handler)
        attached.push(name)
        ctx.effect(() => dispose, 'dsh-pet: ' + name)
      } catch (error) {
        failed.push(name + ': ' + errorMessage(error))
      }
    }

    listen('session/event', (session, event) => {
      reduceSessionEvent(state, event, Date.now())
    })
    listen('api-session/status', (sessionId, running) => {
      reduceSessionStatus(state, sessionId, running, Date.now())
    })
    listen('agent/error', (payload) => {
      reduceAgentError(state, payload, Date.now())
    })
    listen('subagent/start', () => {
      reduceSubagent(state, 1, Date.now())
    })
    listen('subagent/end', () => {
      reduceSubagent(state, -1, Date.now())
    })

    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'exact',
          path: '/pet-api/activity',
          handler: (req, res) => {
            const body = JSON.stringify(
              Object.assign(snapshot(state, Date.now()), {
                events: attached,
                eventFailures: failed
              })
            )
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.setHeader('Cache-Control', 'no-store')
            res.end(body)
          }
        }),
      'dsh-pet: activity route'
    )
  },
  // 自检用的内部视图（不参与插件装配）。
  petInternals: {
    createState: createState,
    reduceSessionEvent: reduceSessionEvent,
    reduceSessionStatus: reduceSessionStatus,
    reduceAgentError: reduceAgentError,
    reduceSubagent: reduceSubagent,
    snapshot: snapshot
  }
}
