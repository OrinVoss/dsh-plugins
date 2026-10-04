/**
 * dsh-btw 宿主半边的离线自检：用假的 ctx / req / res 跑一遍完整链路。
 *   node selftest.cjs
 * 覆盖：正常流、prompt 组装（含指令、无 tools）、线程累积、未知会话、缺参数、停止。
 */

const assert = require('node:assert/strict')
const plugin = require('./host.js')

/** 收集注册的路由处理器。 */
function harness(options = {}) {
  const routes = new Map()
  const calls = []
  const ctx = {
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    get: () => undefined,
    agents: {
      get: (id) => (options.live === false || id !== 's1' ? undefined : {
        session: {
          requestHeader: () => ({ config: options.config || { provider: 'test-provider', model: 'test-model', maxTokens: 128000 } }),
          deriveMessages: () => options.messages || [{ role: 'user', content: [{ type: 'text', text: 'earlier' }] }],
        },
      }),
    },
    llm: {
      async *stream(request) {
        calls.push(request)
        // 复刻 @deepseek-ai/dsh-llm 的 forAdapter()：它对每条 assistant 消息读
        // message.source.replayState，缺 source 就是线上那个 TypeError。
        for (const message of request.messages) {
          if (message.role === 'assistant') void message.source.replayState
        }
        if (options.throwOnStream) throw new Error('boom')
        if (options.markupAnswer) {
          yield { type: 'text-delta', index: 0, text: '先看：<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="pwsh">' }
          yield { type: 'text-delta', index: 0, text: '</｜｜DSML｜｜ calls>完了。' }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        yield { type: 'reasoning-delta', index: 0, text: '先想一下' }
        yield { type: 'text-delta', index: 0, text: '答案是' }
        yield { type: 'text-delta', index: 0, text: ' 42' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    webServer: {
      register: (route) => { routes.set(route.path, route.handler); return () => {} },
    },
  }
  plugin.apply(ctx)
  return { routes, calls, ctx }
}

/** 假的 Node 请求：把 body 推给它。 */
function fakeRequest(method, body) {
  const listeners = {}
  const req = {
    method,
    url: '/',
    on: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); return req },
    destroy: () => {},
  }
  setImmediate(() => {
    if (body !== undefined) {
      const text = typeof body === 'string' ? body : JSON.stringify(body)
      for (const fn of listeners.data || []) fn(Buffer.from(text))
    }
    for (const fn of listeners.end || []) fn()
  })
  return req
}

/** 假的 Node 响应：记录状态码、头与全部帧。 */
function fakeResponse() {
  const frames = []
  const listeners = {}
  const res = {
    statusCode: 200,
    headers: {},
    on: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); return res },
    setHeader: (name, value) => { res.headers[name] = value },
    flushHeaders: () => {},
    write: (chunk) => { frames.push(chunk) },
    end: (chunk) => {
      if (chunk !== undefined) frames.push(chunk)
      res.ended = true
      setImmediate(() => { for (const fn of listeners.close || []) fn() })
    },
  }
  res.frames = frames
  res.events = () => frames
    .filter((f) => f.startsWith('data:'))
    .map((f) => JSON.parse(f.slice(5).trim()))
  res.raw = () => frames.join('')
  return res
}

/** 等一个 promise 化的事件循环回合，让 setImmediate 里的 body 送达。 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

async function main() {
  // 1. 正常流
  {
    const { routes, calls } = harness()
    const res = fakeResponse()
    routes.get('/btw-api/ask')(fakeRequest('POST', { sessionId: 's1', question: '第二个问题是什么？' }), res)
    await tick()
    const events = res.events()
    assert.equal(res.statusCode, 200, 'status')
    assert.equal(res.headers['Content-Type'], 'text/event-stream; charset=utf-8')
    assert.deepEqual(events.filter((e) => e.type === 'delta').map((e) => e.text), ['答案是', ' 42'])
    assert.deepEqual(events.filter((e) => e.type === 'reasoning').map((e) => e.text), ['先想一下'])
    assert.equal(events.filter((e) => e.type === 'finish').length, 1)

    // prompt 组装：完整历史 + 指令 + 问题；不带 tools；带 sessionId
    assert.equal(calls.length, 1)
    const request = calls[0]
    assert.equal(request.provider, 'test-provider')
    assert.equal(request.model, 'test-model')
    assert.equal(request.tools, undefined, 'no tools may be sent')
    assert.equal(request.sessionId, 's1')
    assert.equal(request.maxTokens, 4096, 'answer token cap clamps the request header value')
    const messages = request.messages
    assert.equal(messages.length, 2, 'history + instruction/question')
    assert.equal(messages[0].content[0].text, 'earlier')
    const prompt = messages[messages.length - 1]
    assert.equal(prompt.role, 'user')
    assert.ok(prompt.content[0].text.includes('side question'), 'carries the no-tools instruction')
    assert.ok(prompt.content[0].text.includes('第二个问题是什么？'), 'carries the question')

    // 线程累积后第二次追问会带上历史问答
    const res2 = fakeResponse()
    routes.get('/btw-api/ask')(fakeRequest('POST', { sessionId: 's1', question: '再问一次' }), res2)
    await tick()
    const second = calls[1].messages
    assert.equal(second.length, 4, 'history + 2 replay messages + new question')
    assert.equal(second[1].content[0].text, '第二个问题是什么？')
    assert.equal(second[2].role, 'assistant')
    assert.equal(second[2].content[0].text, '答案是 42')
    // 每条 assistant 消息都要能通过 llm 服务的 forAdapter() 检查（读 source.replayState）
    assert.equal(second[2].source.kind, 'model')
    assert.equal(second[2].source.provider, 'test-provider')
    assert.equal(second[2].source.replayState, undefined)
    for (const message of second) {
      if (message.role === 'assistant') assert.ok(message.source !== undefined, 'assistant messages need a source')
    }
    assert.equal(second[1].source.kind, 'user')
    assert.equal(second[3].source.kind, 'user')
  }

  // 2. 线程快照 / 清空
  {
    const { routes } = harness()
    // 模块级线程按会话存活于整个进程：先清掉上一段留下的两轮。
    routes.get('/btw-api/clear')(fakeRequest('POST', { sessionId: 's1' }), fakeResponse())
    await tick()
    const ask = fakeResponse()
    routes.get('/btw-api/ask')(fakeRequest('POST', { sessionId: 's1', question: 'q' }), ask)
    await tick()
    const thread = fakeResponse()
    const threadReq = fakeRequest('GET')
    threadReq.url = '/btw-api/thread?sessionId=s1'
    routes.get('/btw-api/thread')(threadReq, thread)
    const payload = JSON.parse(thread.frames.join(''))
    assert.equal(payload.items.length, 1)
    assert.equal(payload.items[0].answer, '答案是 42')

    const clear = fakeResponse()
    routes.get('/btw-api/clear')(fakeRequest('POST', { sessionId: 's1' }), clear)
    await tick()
    const after = fakeResponse()
    const afterReq = fakeRequest('GET')
    afterReq.url = '/btw-api/thread?sessionId=s1'
    routes.get('/btw-api/thread')(afterReq, after)
    assert.equal(JSON.parse(after.frames.join('')).items.length, 0)
  }

  // 3. 未知会话 → 409
  {
    const { routes } = harness({ live: false })
    const res = fakeResponse()
    routes.get('/btw-api/ask')(fakeRequest('POST', { sessionId: 'ghost', question: 'hi' }), res)
    await tick()
    assert.equal(res.statusCode, 409)
    assert.match(JSON.parse(res.frames.join('')).error, /not live/)
  }

  // 4. 缺参数 → 400
  {
    const { routes } = harness()
    const res = fakeResponse()
    routes.get('/btw-api/ask')(fakeRequest('POST', { sessionId: 's1' }), res)
    await tick()
    assert.equal(res.statusCode, 400)
  }

  // 5. 流内异常 → 以 error 帧收尾，且不残留 inflight（同一会话可再问）
  {
    const { routes } = harness({ throwOnStream: true })
    const res = fakeResponse()
    routes.get('/btw-api/ask')(fakeRequest('POST', { sessionId: 's1', question: 'hi' }), res)
    await tick()
    const events = res.events()
    assert.equal(events.filter((e) => e.type === 'error').length, 1)
    assert.match(events.find((e) => e.type === 'error').message, /boom/)

    const again = fakeResponse()
    routes.get('/btw-api/ask')(fakeRequest('POST', { sessionId: 's1', question: 'hi again' }), again)
    await tick()
    assert.equal(again.statusCode, 200, 'inflight must be released after a failed stream')
  }

  // 6. Markdown 解析（纯函数，从 client.js 的标记区间取出直接测）
  {
    const fs = require('node:fs')
    const path = require('node:path')
    const source = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8')
    const startMarker = '/* @btw-markdown:start */'
    const endMarker = '/* @btw-markdown:end */'
    const start = source.indexOf(startMarker)
    const end = source.indexOf(endMarker)
    assert.ok(start >= 0 && end > start, 'client.js must keep the markdown markers')
    const parseMarkdown = new Function(source.slice(start + startMarker.length, end) + '\n; return parseMarkdown')()

    assert.deepEqual(parseMarkdown(''), [], 'empty source has no blocks')

    const mixed = parseMarkdown([
      '# 标题',
      '',
      '正文 **粗** 与 *斜* 和 `code`。',
      '',
      '- a',
      '- b',
      '',
      '1. one',
      '2. two',
      '',
      '> 引用',
      '',
      '```js',
      'const a = 1',
      '```',
      '',
    ].join('\n'))
    assert.deepEqual(mixed.map((block) => block.type), ['heading', 'paragraph', 'list', 'list', 'quote', 'code'])
    assert.equal(mixed[0].level, 1)
    assert.deepEqual(mixed[1].spans.map((span) => span.type), ['text', 'strong', 'text', 'em', 'text', 'code', 'text'])
    assert.equal(mixed[2].ordered, false)
    assert.equal(mixed[2].items.length, 2)
    assert.equal(mixed[3].ordered, true)
    assert.equal(mixed[5].lang, 'js')
    assert.equal(mixed[5].text, 'const a = 1')

    // 流式：未闭合的围栏按代码块收尾，前面的段落照常成立
    const streaming = parseMarkdown('看代码：\n```python\nprint(1)')
    assert.deepEqual(streaming.map((block) => block.type), ['paragraph', 'code'])
    assert.equal(streaming[1].lang, 'python')
    assert.equal(streaming[1].text, 'print(1)')

    // 链接按文本渲染但保留 href
    const link = parseMarkdown('见 [文档](https://example.com/a)。')[0]
    assert.equal(link.spans.find((span) => span.type === 'link').text, '文档')
    assert.equal(link.spans.find((span) => span.type === 'link').href, 'https://example.com/a')

    // 单独的 ~~~ 围栏与 CRLF 也要能吃
    const tilde = parseMarkdown('~~~\r\nx = 1\r\n~~~')
    assert.equal(tilde[0].type, 'code')
    assert.equal(tilde[0].text, 'x = 1')
  }

  // 7. 工具调用文本清理（同样是纯函数，从标记区间取出）
  {
    const fs = require('node:fs')
    const path = require('node:path')
    const source = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8')
    const startMarker = '/* @btw-sanitize:start */'
    const endMarker = '/* @btw-sanitize:end */'
    const start = source.indexOf(startMarker)
    const end = source.indexOf(endMarker)
    assert.ok(start >= 0 && end > start, 'client.js must keep the sanitize markers')
    const sanitizeAnswer = new Function(source.slice(start + startMarker.length, end) + '\n; return sanitizeAnswer')()

    assert.deepEqual(sanitizeAnswer('普通答案，含 `code`。'), { text: '普通答案，含 `code`。', stripped: false })

    const paired = sanitizeAnswer('看这个：<｜｜DSML｜｜ calls></｜｜DSML｜｜ calls>就这些。')
    assert.equal(paired.stripped, true)
    assert.equal(paired.text, '看这个：就这些。')

    // 流式：未闭合的开标记一直吃到结尾，用户不会看到滚动的半截标记
    const open = sanitizeAnswer('答案前\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="pwsh">')
    assert.equal(open.stripped, true)
    assert.equal(open.text, '答案前')

    const generic = sanitizeAnswer('a<tool_call>{"n":1}</tool_call>b')
    assert.equal(generic.stripped, true)
    assert.equal(generic.text, 'ab')

    // 只有标记没有正文：清空且标记为剥离，调用方据此补"未执行"说明
    const onlyMarkup = sanitizeAnswer('<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="pwsh">')
    assert.equal(onlyMarkup.stripped, true)
    assert.equal(onlyMarkup.text, '')
  }

  // 6. 重放给模型的 assistant 文本要先剥掉伪工具调用标记
  {
    const { routes, calls } = harness({ markupAnswer: true })
    routes.get('/btw-api/clear')(fakeRequest('POST', { sessionId: 's1' }), fakeResponse())
    await tick()
    routes.get('/btw-api/ask')(fakeRequest('POST', { sessionId: 's1', question: '第一问' }), fakeResponse())
    await tick()
    routes.get('/btw-api/ask')(fakeRequest('POST', { sessionId: 's1', question: '第二问' }), fakeResponse())
    await tick()
    const replayed = calls[1].messages.find((message) => message.role === 'assistant')
    assert.equal(replayed.content[0].text, '先看：完了。')
    assert.ok(!replayed.content[0].text.includes('DSML'), 'markup must not be replayed to the model')
  }

  // 8. 思考行摘要（纯函数，从标记区间取出）
  {
    const fs = require('node:fs')
    const path = require('node:path')
    const source = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8')
    const startMarker = '/* @btw-reasoning:start */'
    const endMarker = '/* @btw-reasoning:end */'
    const start = source.indexOf(startMarker)
    const end = source.indexOf(endMarker)
    assert.ok(start >= 0 && end > start, 'client.js must keep the reasoning markers')
    const reasoningSummary = new Function(source.slice(start + startMarker.length, end) + '\n; return reasoningSummary')()

    assert.equal(reasoningSummary('', false), '')
    // 结束后取首行，并去掉粗体标记
    assert.equal(reasoningSummary('**第一行**\n第二行', false), '第一行')
    // 流式中：最后一个"已完成段落"的首行（末段还在写，不算）
    assert.equal(reasoningSummary('第一段首行\n第一段其余\n\n第二段刚开头', true), '第一段首行')
    // 段落已被空行封口：用最后一段
    assert.equal(reasoningSummary('第一段\n\n第二段首行\n\n', true), '第二段首行')
    // 只有一段且还在写：仍给它的首行，不至于空白
    assert.equal(reasoningSummary('唯一一段的首行', true), '唯一一段的首行')
  }

  console.log('selftest: all checks passed')
}

main().catch((error) => {
  console.error('selftest FAILED:', error && error.stack ? error.stack : error)
  process.exit(1)
})
