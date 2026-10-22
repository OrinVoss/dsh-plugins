#!/usr/bin/env node
/**
 * 端到端联调：**两个插件的真 host.js** 跑在同一个进程里，中间只隔一个假总线目录。
 *
 *     node C:\Users\17040\.dsh\plugins\dsh-xiaoxing-bridge\test-e2e.mjs
 *
 * 这不是"再测一遍纯逻辑"——它测的是 host.js 的接线：
 *   · 工具能不能注册、参数能不能进、返回文本对不对
 *   · 定时器会不会真的每 N 毫秒扫一次目录
 *   · 批准前是不是真的不投递
 *   · `resolveAgent → followup → flush` 这条链抛出/正常时，outbox 会不会跟着变
 *   · 桌面侧的 `session/event` 订阅能不能喂到 outbox，小星侧能不能认出来并注入
 *
 * ## 为什么要复制一份到临时目录
 *
 * 两个 host.js 都 `import { createUserMessage } from '@deepseek-ai/dsh-llm'`，
 * 在 DSH 进程外面解析不了。临时目录里放一个**只有一行导出**的桩模块就绕开了；
 * 复制而不原地 import，是为了**绝不往真插件目录里塞 node_modules**。
 *
 * ## 找小星侧插件
 *
 * 默认 `D:\桌面\编程作品\study-kit\plugins\dsh-xiaoxing-handoff`，
 * 可用环境变量 `HANDOFF_PLUGIN_DIR` 覆盖。找不到就明确跳过（不算通过）。
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const HANDOFF_DIR = process.env.HANDOFF_PLUGIN_DIR || 'D:\\桌面\\编程作品\\study-kit\\plugins\\dsh-xiaoxing-handoff'

const DESKTOP_SID = 'session-331d9500-d50b-489c-8fec-e367cd210377'
const STUDY_SID = 'session-76dabe2a-1cf9-43eb-a54f-e85f297162cc'

let passed = 0
const failed = []

function check(label, ok, detail = '') {
  if (ok) passed++
  else failed.push(label)
  process.stdout.write(`  ${ok ? '✅' : '❌'} ${label}${detail ? `  ${detail}` : ''}\n`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 等到条件成立或超时（不是固定 sleep，慢了就多等一会，快了立刻过）。 */
async function until(predicate, { timeoutMs = 3000, stepMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(stepMs)
  }
  return predicate()
}

if (!existsSync(join(HANDOFF_DIR, 'host.js'))) {
  process.stdout.write(
    `⚠️ 跳过：找不到小星侧插件（${HANDOFF_DIR}）。\n` +
      '   这个测试要两个插件都在场才能跑；设 HANDOFF_PLUGIN_DIR 指向 dsh-xiaoxing-handoff 目录后重试。\n' +
      '   （跳过不等于通过 —— 基础逻辑仍由 test-handoff.mjs / test-bridge.mjs 覆盖。）\n',
  )
  process.exit(0)
}

// ── 搭临时环境 ───────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), 'handoff-e2e-'))
const bridgeDir = join(root, '_bridge')

/** 把插件复制到临时目录，并塞一个 @deepseek-ai/dsh-llm 桩。 */
function stage(sourceDir, name, files) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  for (const file of files) cpSync(join(sourceDir, file), join(dir, file))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `staged-${name}`, type: 'module' }, null, 2), 'utf8')
  const stubDir = join(dir, 'node_modules', '@deepseek-ai', 'dsh-llm')
  mkdirSync(stubDir, { recursive: true })
  writeFileSync(join(stubDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm', type: 'module', main: 'index.js' }, null, 2), 'utf8')
  writeFileSync(
    join(stubDir, 'index.js'),
    // 真 createUserMessage 返回的就是 {role:'user', content, source} 这个形状；
    // 这里只留桥真正用到的部分
    'export function createUserMessage(input) {\n  return { role: "user", ...input }\n}\n',
    'utf8',
  )
  return dir
}

const studyDir = stage(HANDOFF_DIR, 'study', ['host.js', 'handoff-core.js'])
const desktopDir = stage(HERE, 'desktop', ['host.js', 'bridge-core.js'])

/** 假 ctx：把注册、事件、注入都记下来，别的什么都不做。 */
function makeCtx() {
  const tools = new Map()
  const disposers = []
  const handlers = []
  const injected = []
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    sessionController: {
      async resolveAgent(sessionId) {
        return {
          agent: {
            followup(message) {
              injected.push({ sessionId, message })
            },
            session: { id: sessionId },
          },
        }
      },
    },
    sessions: { async flush() {} },
    on(_event, handler) {
      handlers.push(handler)
      return () => {
        const index = handlers.indexOf(handler)
        if (index >= 0) handlers.splice(index, 1)
      }
    },
    effect(factory) {
      const disposer = factory()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    logger: { info() {}, warn() {}, error() {} },
  }
  return { ctx, tools, disposers, handlers, injected }
}

function disposeAll(env) {
  for (const dispose of env.disposers.reverse()) {
    try {
      dispose()
    } catch {
      /* 拆不干净不影响结论 */
    }
  }
}

/**
 * 删临时目录。
 *
 * ⚠️ 本机 Node 24.12 的 `fs.rmSync(..., {recursive:true})` 会**静默不删**，
 * 所以自己 readdir + unlink + rmdir。插件代码只用 rename/unlink。
 */
function removeTree(dir) {
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) removeTree(path)
    else {
      try {
        unlinkSync(path)
      } catch {
        /* 删不掉就算了 */
      }
    }
  }
  try {
    rmdirSync(dir)
  } catch {
    /* 同上 */
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

try {
  const study = makeCtx()
  const desktop = makeCtx()

  const studyHost = await import(pathToFileURL(join(studyDir, 'host.js')).href)
  const desktopHost = await import(pathToFileURL(join(desktopDir, 'host.js')).href)

  process.stdout.write('── 装载\n')

  studyHost.apply(study.ctx, {
    bridgeDir,
    sessionId: STUDY_SID,
    pollIntervalMs: 50,
    injectCooldownMs: 0,
    logFile: join(root, 'study.log'),
    stateFile: join(root, 'study-state.json'),
  })
  desktopHost.apply(desktop.ctx, {
    bridgeDir,
    sessionId: DESKTOP_SID,
    pollIntervalMs: 40,
    throttleMs: 0,
    requireApproval: true,
    logFile: join(root, 'desktop.log'),
    heartbeatFile: join(root, 'desktop.heartbeat'),
  })

  check('小星侧注册了 3 个工具', ['request_help', 'request_help_approve', 'request_help_status'].every((n) => study.tools.has(n)))
  check('桌面侧订阅了 session/event', desktop.handlers.length === 1)

  // ── 投递申请 ─────────────────────────────────────────────────
  process.stdout.write('── 申请（未批准不应投递）\n')

  const requestHelp = study.tools.get('request_help')
  const applied = await requestHelp.execute(
    {
      title: '数据结构期中备考系统',
      why: '他 10-24 有期中考试，群文件里有老师发的资料',
      what: '把群文件里的资料整理成一份分章节的复习清单 + 自测题',
      deliverable: '一个单文件 HTML，放 D:\\桌面\\自主工作空间\\',
      deadline: '2026-10-23T22:00:00+08:00',
    },
    { agent: { session: { header: { id: STUDY_SID } } } },
  )
  const taskId = (applied.text.match(/task_[0-9a-z]+/) ?? [''])[0]
  check('返回文本里有 taskId', Boolean(taskId), taskId)
  check('返回文本明确说"还没投递"', applied.text.includes('还没投递'))
  check('返回文本给了批准工具调用样例', applied.text.includes('request_help_approve'))

  const inboxFile = join(bridgeDir, 'inbox', `${taskId}.json`)
  const inboxTask = readJson(inboxFile)
  check('inbox 文件真的写出来了', Boolean(inboxTask))
  check('inbox 带中文标题（UTF-8 没坏）', inboxTask?.title === '数据结构期中备考系统')
  check('inbox 的 taskId 与返回一致', inboxTask?.taskId === taskId)
  check('inbox 的 from 是 xiaoxing', inboxTask?.from === 'xiaoxing')

  await sleep(250)
  check('未批准 → 桌面侧一条都没投', desktop.injected.length === 0)
  check('未批准 → 连 outbox 都没有', !existsSync(join(bridgeDir, 'outbox', `${taskId}.json`)))

  // ── 批准 → 投递 ─────────────────────────────────────────────
  process.stdout.write('── 批准与投递\n')

  const approveTool = study.tools.get('request_help_approve')
  await approveTool.execute({ taskId, approved: true }, {})
  check('批准记录落盘', readJson(join(bridgeDir, 'approvals', `${taskId}.json`))?.state === 'approved')

  const dispatched = await until(() => desktop.injected.length === 1)
  check('批准后桌面侧投递了一次', dispatched && desktop.injected.length === 1)
  const injectedMessage = desktop.injected[0]?.message
  check('投给了配置里的目标会话', desktop.injected[0]?.sessionId === DESKTOP_SID)
  check('消息 source.kind 是 handoff', injectedMessage?.source?.kind === 'handoff')
  const messageText = injectedMessage?.content?.[0]?.text ?? ''
  check('正文带任务编号', messageText.includes(taskId))
  check('正文带交付物', messageText.includes('单文件 HTML'))

  await until(() => readJson(join(bridgeDir, 'outbox', `${taskId}.json`))?.status === 'running')
  check('outbox 变 running', readJson(join(bridgeDir, 'outbox', `${taskId}.json`))?.status === 'running')

  // ── 进度 ────────────────────────────────────────────────────
  process.stdout.write('── 进度回传\n')

  const emit = (event) => {
    for (const handler of desktop.handlers) handler({ id: DESKTOP_SID }, event)
  }

  emit({ type: 'turn/start', data: { turn: 1 } })
  // 真会话里这条是我们 followup 进去的消息被 step 收下时 append 的
  emit({ type: 'user/message', data: injectedMessage })
  emit({ type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: { file_path: 'D:\\桌面\\自主工作空间\\群文件\\资料.md' } } })
  emit({ type: 'tool/call', data: { turn: 1, step: 2, callId: 'c2', name: 'write', arguments: { file_path: 'D:\\桌面\\自主工作空间\\index.html' } } })

  await until(() => (readJson(join(bridgeDir, 'outbox', `${taskId}.json`))?.steps ?? 0) >= 2)
  const progressOutbox = readJson(join(bridgeDir, 'outbox', `${taskId}.json`))
  check('outbox 记下步数', progressOutbox?.steps === 2)
  check('outbox 记下最近工具', progressOutbox?.lastTool === 'write')
  check('outbox 进度文案带文件名', String(progressOutbox?.progressText).includes('index.html'))

  // 小星侧应该已经把"进度"注入回自己的会话
  const sawProgress = await until(() => study.injected.some((row) => row.message.content?.[0]?.text.includes('状态：running')))
  check('小星侧把 running 进度注入回自己的会话', sawProgress)
  check('注入目标是记录下来的调用方会话', study.injected.every((row) => row.sessionId === STUDY_SID))

  // ── 结算 ────────────────────────────────────────────────────
  process.stdout.write('── 完成\n')

  emit({
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 3,
      message: {
        content: [
          { type: 'reasoning', text: '这段内心独白不该回传' },
          { type: 'text', text: '做好了：index.html 已放在 D:\\桌面\\自主工作空间\\，三章 + 20 道自测题。' },
        ],
      },
    },
  })
  emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

  await until(() => readJson(join(bridgeDir, 'outbox', `${taskId}.json`))?.status === 'done')
  const doneOutbox = readJson(join(bridgeDir, 'outbox', `${taskId}.json`))
  check('outbox 变 done', doneOutbox?.status === 'done')
  check('结果是最终助手正文', String(doneOutbox?.result).includes('三章 + 20 道自测题'))
  check('结果里没有 reasoning 片段', !String(doneOutbox?.result).includes('内心独白'))

  const sawDone = await until(() =>
    study.injected.some((row) => row.message.content?.[0]?.text.includes('状态：done')),
  )
  check('小星侧把最终结果注入回自己的会话', sawDone)
  const finalInjection = study.injected
    .map((row) => row.message.content?.[0]?.text ?? '')
    .find((text) => text.includes('状态：done'))
  check('注入正文里带完整结果', String(finalInjection).includes('三章 + 20 道自测题'))
  check('注入正文说明是桥自动注入', String(finalInjection).includes('自动注入'))

  // 终态只递一次
  const before = study.injected.length
  await sleep(300)
  check('终态不会反复注入', study.injected.length === before)

  // ── 状态查询 ────────────────────────────────────────────────
  process.stdout.write('── 状态查询\n')

  const statusTool = study.tools.get('request_help_status')
  const statusText = (await statusTool.execute({ taskId }, {})).text
  check('状态工具能查到 done', statusText.includes('done'))
  check('状态工具带结果正文', statusText.includes('三章 + 20 道自测题'))
  check('状态工具显示已批准', statusText.includes('approved'))
  const allText = (await statusTool.execute({}, {})).text
  check('不带 taskId 能列出全部', allText.includes(taskId))

  // ── 心跳与日志 ──────────────────────────────────────────────
  process.stdout.write('── 心跳与日志\n')

  await sleep(200)
  const heartbeat = readJson(join(root, 'desktop.heartbeat'))
  check('桌面侧写了心跳', Boolean(heartbeat))
  check('心跳里会话 id 正确', heartbeat?.sessionId === DESKTOP_SID)
  check('心跳里没有正在跑的任务', heartbeat?.active === null)
  check('桌面侧日志有投递记录', readFileSync(join(root, 'desktop.log'), 'utf8').includes('已投递'))
  check('小星侧日志有注入记录', readFileSync(join(root, 'study.log'), 'utf8').includes('注入'))

  disposeAll(study)
  disposeAll(desktop)
} catch (error) {
  check(`端到端跑挂了：${error?.stack ?? error}`, false)
} finally {
  removeTree(root)
}

process.stdout.write(`\n${passed} 项通过`)
if (failed.length) {
  process.stdout.write(`，${failed.length} 项失败：\n${failed.map((f) => `  ❌ ${f}`).join('\n')}\n`)
  process.exit(1)
}
process.stdout.write('，0 项失败\n')
