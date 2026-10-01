// dsh-pet 宿主半边自检：用假 ctx 驱动，验证事件折叠与 /pet-api/activity 的输出。
//
//   node test/hosttest.cjs
const path = require('path')

const plugin = require(path.join(__dirname, '..', 'host.js'))
const I = plugin.petInternals

let passed = 0
const failures = []
function test(name, fn) {
  try {
    fn()
    passed++
    console.log('  ok   ' + name)
  } catch (error) {
    failures.push(name + ' :: ' + error.message)
    console.log('  FAIL ' + name + ' :: ' + error.message)
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed')
}

/** 假 ctx：收集监听与路由，并允许按事件名触发。 */
function makeContext() {
  const handlers = new Map()
  const routes = []
  const effects = []
  const ctx = {
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(fn)
      return () => handlers.delete(name)
    },
    effect(fn, label) {
      effects.push(label)
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      }
    }
  }
  const emit = function (name) {
    const args = Array.prototype.slice.call(arguments, 1)
    for (const fn of handlers.get(name) || []) fn.apply(null, args)
  }
  return { ctx: ctx, emit: emit, routes: routes, effects: effects, handlers: handlers }
}

console.log('\n[1] 装配')
const env = makeContext()
plugin.apply(env.ctx)

test('注入了 webServer', () => {
  assert(plugin.inject.indexOf('webServer') >= 0, 'inject 缺少 webServer')
})

test('挂上了五类只读监听', () => {
  for (const name of ['session/event', 'api-session/status', 'agent/error', 'subagent/start', 'subagent/end']) {
    assert(env.handlers.has(name), '缺少监听 ' + name)
  }
})

test('注册了 /pet-api/activity 路由', () => {
  assert(env.routes.length === 1, '路由数量应为 1，实际 ' + env.routes.length)
  assert(env.routes[0].path === '/pet-api/activity', '路径不对：' + env.routes[0].path)
  assert(typeof env.routes[0].handler === 'function', '缺少 handler')
})

function readSnapshot() {
  let body = null
  const headers = {}
  env.routes[0].handler({}, {
    setHeader: (key, value) => {
      headers[key] = value
    },
    end: (text) => {
      body = text
    }
  })
  assert(body !== null, '路由没有输出')
  assert(headers['Cache-Control'] === 'no-store', '缺少 no-store')
  return JSON.parse(body)
}

console.log('\n[2] 事件折叠')
test('空闲快照是干净的', () => {
  const snap = readSnapshot()
  assert(snap.running === false && snap.toolCalls === 0 && snap.turns === 0, '初始状态不干净')
  assert(Array.isArray(snap.recent) && snap.recent.length === 0, 'recent 应为空')
  assert(Array.isArray(snap.events) && snap.events.length === 5, 'events 应列出 5 个监听')
})

test('turn/start → turn/end 记一个回合', () => {
  env.emit('session/event', {}, { type: 'turn/start', data: { turn: 1 } })
  let snap = readSnapshot()
  assert(snap.lastTurnStartAt !== null, '没记住开始时间')
  assert(snap.turns === 0, '未结束时不该记回合')
  env.emit('session/event', {}, { type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } })
  snap = readSnapshot()
  assert(snap.turns === 1, '回合数应为 1，实际 ' + snap.turns)
  assert(snap.lastTurnEndAt !== null, '没记住收工时间')
})

test('tool/call → tool/result 维护活跃工具与最近工具', () => {
  env.emit('session/event', {}, { type: 'tool/call', data: { callId: 'c1', name: 'read' } })
  let snap = readSnapshot()
  assert(snap.activeTools === 1, '活跃工具应为 1')
  assert(snap.lastTool && snap.lastTool.name === 'read', '最近工具应为 read')
  assert(snap.toolCalls === 1, '工具调用计数应为 1')
  env.emit('session/event', {}, { type: 'tool/result', data: { message: { toolCallId: 'c1', isError: false } } })
  snap = readSnapshot()
  assert(snap.activeTools === 0, '工具结束后应为 0')
  assert(snap.lastError === null, '成功不该记错误')
})

test('工具报错会记进 lastError', () => {
  env.emit('session/event', {}, { type: 'tool/call', data: { callId: 'c2', name: 'pwsh' } })
  env.emit('session/event', {}, { type: 'tool/result', data: { message: { toolCallId: 'c2', isError: true } } })
  const snap = readSnapshot()
  assert(snap.lastError !== null, '应记下错误')
  assert(typeof snap.lastError.at === 'number', '错误应带时间戳')
})

test('授权请求会挂起 awaitingApproval，决定后恢复', () => {
  env.emit('session/event', {}, { type: 'approval/asked', data: { id: 'a1', toolName: 'pwsh', reason: '升级沙箱' } })
  let snap = readSnapshot()
  assert(snap.awaitingApproval === true, '应处于等待授权')
  assert(snap.approvalReason === '升级沙箱', '应带原因')
  env.emit('session/event', {}, { type: 'approval/decided', data: { id: 'a1', outcome: 'allowed-once' } })
  snap = readSnapshot()
  assert(snap.awaitingApproval === false, '决定后应恢复')
  assert(snap.approvalReason === null, '原因应清空')
})

test('assistant/message 的 usage 累加成喂养值', () => {
  env.emit('session/event', {}, { type: 'assistant/message', data: { usage: { inputTokens: 1000, outputTokens: 200 } } })
  env.emit('session/event', {}, { type: 'assistant/message', data: { usage: { inputTokens: 300, outputTokens: 20 } } })
  const snap = readSnapshot()
  assert(snap.tokens === 1520, 'token 累计应为 1520，实际 ' + snap.tokens)
})

test('running 由 api-session/status 维护，可多会话同时跑', () => {
  env.emit('api-session/status', 's1', true, 0)
  env.emit('api-session/status', 's2', true, 0)
  let snap = readSnapshot()
  assert(snap.running === true && snap.runningSessions === 2, '应有两个会话在跑')
  env.emit('api-session/status', 's1', false, 0)
  snap = readSnapshot()
  assert(snap.runningSessions === 1, '停一个后应剩一个')
  env.emit('api-session/status', 's2', false, 0)
  snap = readSnapshot()
  assert(snap.running === false, '都停了应为 false')
})

test('agent/error 记错误，subagent/start|end 记小跟班', () => {
  env.emit('agent/error', { error: { message: '模型挂了' } }, 0)
  let snap = readSnapshot()
  assert(snap.lastError.message === '模型挂了', '应记下错误信息：' + JSON.stringify(snap.lastError))
  env.emit('subagent/start', {}, 0)
  env.emit('subagent/start', {}, 0)
  snap = readSnapshot()
  assert(snap.subagents === 2, '应有两个小跟班')
  env.emit('subagent/end', {}, 0)
  snap = readSnapshot()
  assert(snap.subagents === 1, '走一个后应剩一个')
  env.emit('subagent/end', {}, 0)
  env.emit('subagent/end', {}, 0)
  snap = readSnapshot()
  assert(snap.subagents === 0, '不应低于 0')
})

console.log('\n[3] recent 环形缓冲')
test('recent 最多 8 条且最新在前', () => {
  for (let i = 0; i < 20; i++) {
    env.emit('session/event', {}, { type: 'tool/call', data: { callId: 'x' + i, name: 'tool' + i } })
  }
  const snap = readSnapshot()
  assert(snap.recent.length === 8, 'recent 应被截到 8 条，实际 ' + snap.recent.length)
  assert(snap.recent[0].text === 'tool19', '最新一条应排最前，实际 ' + snap.recent[0].text)
})

test('快照可以安全 JSON 序列化（无循环、无 undefined 函数）', () => {
  const text = JSON.stringify(readSnapshot())
  assert(text.indexOf('undefined') < 0, '快照里不应出现 undefined')
})

console.log('\n[4] 纯函数边界')
test('reduceSessionEvent 对未知事件与坏输入不抛异常', () => {
  const state = I.createState(Date.now())
  assert(I.reduceSessionEvent(state, null, Date.now()) === false, 'null 事件应返回 false')
  assert(I.reduceSessionEvent(state, { type: 'unknown/type', data: {} }, Date.now()) === false, '未知事件应返回 false')
  assert(I.reduceSessionEvent(state, { type: 'tool/call', data: {} }, Date.now()) === true, '缺字段的 tool/call 也应被接受')
  assert(I.reduceSessionEvent(state, { type: 'tool/result', data: {} }, Date.now()) === true, '缺 toolCallId 的 result 也不该崩')
})

test('同一 callId 重复 call 不会叠加活跃数', () => {
  const state = I.createState(Date.now())
  I.reduceSessionEvent(state, { type: 'tool/call', data: { callId: 'same', name: 'read' } }, Date.now())
  I.reduceSessionEvent(state, { type: 'tool/call', data: { callId: 'same', name: 'read' } }, Date.now())
  assert(state.activeTools.size === 1, '同一 callId 应只占一个位')
  assert(state.toolCalls === 2, '调用次数仍应累加')
})

console.log('\n' + passed + ' 项通过，' + failures.length + ' 项失败')
if (failures.length > 0) {
  for (const failure of failures) console.log('  - ' + failure)
  process.exit(1)
}
