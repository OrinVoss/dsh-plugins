#!/usr/bin/env node
/**
 * 编程助手侧（dsh-xiaoxing-bridge）纯逻辑的回归测试。
 *
 *     node C:\Users\17040\.dsh\plugins\dsh-xiaoxing-bridge\test-bridge.mjs
 *
 * 不需要 DSH、不需要另一个实例 —— `bridge-core.js` 只依赖 node: 内置。
 * 假总线目录 + 假时钟 + 假事件流，把跑一条任务要经过的每一步都走一遍。
 *
 * ## 为什么这几条最该测
 *
 * 这一侧错了，后果是**别人的会话被污染**：
 *   · 认错回合 → 把用户自己那轮的回答当成任务结果回传给小星
 *   · 不认会话 → 别的会话的工具调用写进 outbox，进度看着像在动，其实不是这条任务
 *   · 不节流   → 每次工具调用都写盘，对面每 3 秒看到一次"变化"
 *   · 不串行   → 两条任务的正文缠在一起，最后一段正文到底是谁的都说不清
 */

import { mkdtempSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  approvalState,
  assistantTextOf,
  composeTaskMessage,
  createOutbox,
  createRunner,
  ensureDirs,
  normalizeTask,
  pathsOf,
  progressLine,
  readJsonFile,
  scanInbox,
  truncateText,
  writeJsonAtomic,
} from './bridge-core.js'

let passed = 0
const failed = []

function check(label, ok, detail = '') {
  if (ok) passed++
  else failed.push(label)
  process.stdout.write(`  ${ok ? '✅' : '❌'} ${label}${detail ? `  ${detail}` : ''}\n`)
}

const SID = 'session-331d9500-d50b-489c-8fec-e367cd210377'
const NOW = Date.parse('2026-10-22T23:00:00+08:00')

function makeBridge() {
  const root = mkdtempSync(join(tmpdir(), 'bridge-test-'))
  const dirs = pathsOf(join(root, '_bridge'))
  ensureDirs(dirs)
  return { root, dirs, cleanup: () => removeTree(root) }
}

/**
 * 删临时目录。
 *
 * ⚠️ 本机 Node 24.12 的 `fs.rmSync(..., {recursive:true})` 会**静默不删**
 * （不抛异常，文件还在），所以测试自己用 readdir + unlink + rmdir 收拾。
 * 插件代码只用 rename/unlink，不受影响。
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

/** 严格按协议形状造一条 inbox 任务（和小星侧 buildInboxTask 输出一致）。 */
function taskOf(taskId, patch = {}) {
  return {
    taskId,
    createdAt: NOW,
    title: '数据结构期中备考系统',
    why: '他 10-24 有期中考试，群文件里有老师发的资料',
    what: '把群文件里的资料整理成一份分章节的复习清单 + 自测题',
    deliverable: '一个单文件 HTML，放 D:\\桌面\\自主工作空间\\',
    deadline: '2026-10-23T22:00:00+08:00',
    from: 'xiaoxing',
    ...patch,
  }
}

function writeInbox(dirs, task) {
  writeJsonAtomic(join(dirs.inboxDir, `${task.taskId}.json`), task)
}

function approve(dirs, taskId, state = 'approved') {
  writeJsonAtomic(join(dirs.approvalsDir, `${taskId}.json`), {
    taskId,
    state,
    requestedAt: new Date(NOW).toISOString(),
    decidedAt: new Date(NOW + 1000).toISOString(),
    note: null,
  })
}

function outboxOf(dirs, taskId) {
  const read = readJsonFile(join(dirs.outboxDir, `${taskId}.json`))
  return read.ok ? read.value : null
}

function harness(dirs, opts = {}) {
  const clock = { t: 1000 }
  const dispatched = []
  const logs = []
  const runner = createRunner({
    dirs,
    sessionId: SID,
    now: () => clock.t,
    log: (line) => logs.push(line),
    dispatch: async (task) => {
      dispatched.push(task.taskId)
    },
    ...opts,
  })
  return { runner, clock, dispatched, logs }
}

const ev = (type, data = {}) => ({ type, data })
const handoff = (taskId) =>
  ev('user/message', {
    content: [{ type: 'text', text: `【跨实例协作请求】任务编号：${taskId}` }],
    source: { kind: 'handoff' },
  })
const textMsg = (text) => ev('assistant/message', { message: { content: [{ type: 'text', text }] } })

// ───────────────────────────────────────────────────────── 协议
process.stdout.write('── inbox 形状与校验\n')

{
  const bridge = makeBridge()
  try {
    // ★ 硬性要求①：inbox 写入 → 被读到
    writeInbox(bridge.dirs, taskOf('task_a'))
    writeInbox(bridge.dirs, taskOf('task_b', { createdAt: NOW + 5000, title: '第二件事' }))
    const scanned = scanInbox(bridge.dirs)
    check('扫到两条', scanned.length === 2)
    check('按 createdAt 升序（先来先做）', scanned[0].task.taskId === 'task_a' && scanned[1].task.taskId === 'task_b')
    check('字段读全', scanned[0].task.deliverable.includes('单文件 HTML') && scanned[0].task.from === 'xiaoxing')
    check('宽进来历不明字段不影响', normalizeTask({ taskId: 'task_c', title: 't', 乱入: 1 }).taskId === 'task_c')

    // 坏文件 / 非法 id / 空标题
    writeFileSync(join(bridge.dirs.inboxDir, 'task_bad.json'), '{oops', 'utf8')
    writeFileSync(join(bridge.dirs.inboxDir, '..evil.json'), JSON.stringify(taskOf('task_x')), 'utf8')
    writeInbox(bridge.dirs, taskOf('task_empty', { title: '   ' }))
    check('坏 JSON 不影响其他任务', scanInbox(bridge.dirs).length === 2)
    check('空标题不算任务', scanInbox(bridge.dirs).every((row) => row.task.title.trim() !== ''))
    check('路径穿越的文件名被忽略', scanInbox(bridge.dirs).every((row) => row.task.taskId !== '..evil' && !row.task.taskId.includes('..')))

    check('没有批准记录 → missing', approvalState(bridge.dirs, 'task_a') === 'missing')
    approve(bridge.dirs, 'task_a', 'pending')
    check('待批准 → pending', approvalState(bridge.dirs, 'task_a') === 'pending')
    approve(bridge.dirs, 'task_a')
    check('批准 → approved', approvalState(bridge.dirs, 'task_a') === 'approved')

    const fresh = createOutbox('task_a', NOW)
    check('outbox 字段顺序与协议一致', JSON.stringify(Object.keys(fresh)) === JSON.stringify([
      'taskId', 'status', 'updatedAt', 'steps', 'lastTool', 'progressText', 'result', 'error',
    ]))
    check('初始状态是 queued', fresh.status === 'queued')
  } finally {
    bridge.cleanup()
  }
}

// ───────────────────────────────────────────────────────── 文案
process.stdout.write('── 投递正文与正文抽取\n')

{
  const message = composeTaskMessage(taskOf('task_a'))
  check('正文带任务编号（认领回合靠它）', message.includes('task_a'))
  check('正文带交付物', message.includes('单文件 HTML'))
  check('正文说清"最终正文会原样回传"', message.includes('最终助手正文'))
  check('正文说清"不是用户打的字"', message.includes('不是你用户在这里打的字'))

  // ★ 手机通道踩过的坑：reasoning 片段也有 text 字段
  const withThinking = ev('assistant/message', {
    message: {
      content: [
        { type: 'reasoning', text: '内心独白：他想要一个复习清单' },
        { type: 'text', text: '做好了，放在 index.html。' },
      ],
    },
  })
  check('只取 type=text，不把 reasoning 当正文', assistantTextOf(withThinking) === '做好了，放在 index.html。')
  check('content 是字符串时也能取', assistantTextOf(ev('assistant/message', { message: { content: '直接一段话' } })) === '直接一段话')
  check('没有 message → 空串', assistantTextOf(ev('assistant/message', {})) === '')

  check('进度行带文件名', progressLine('write', { file_path: 'D:\\x\\index.html' }, 7).includes('index.html'))
  check('进度行带步数', progressLine('write', { file_path: 'D:\\x\\index.html' }, 7).includes('第 7 步'))
  check('无参数时也给得出进度行', progressLine('bash', {}, 2) === '正在调用 bash（第 2 步）')
  check('truncateText 短文本不标脏', truncateText('abc', 10).truncated === false)
}

// ───────────────────────────────────────────────────────── 主流程
process.stdout.write('── 主流程：批准 → queued → running → 进度 → done\n')

{
  const bridge = makeBridge()
  try {
    writeInbox(bridge.dirs, taskOf('task_a'))
    const { runner, clock, dispatched } = harness(bridge.dirs)

    await runner.tick()
    check('没批准 → 一条都不投', dispatched.length === 0)
    check('没批准 → 连 outbox 都不写（不制造假象）', outboxOf(bridge.dirs, 'task_a') === null)

    approve(bridge.dirs, 'task_a')
    await runner.tick()
    check('批准后投了一次', dispatched.length === 1 && dispatched[0] === 'task_a')
    const running = outboxOf(bridge.dirs, 'task_a')
    check('outbox 状态 running', running?.status === 'running')
    check('outbox 写清了"等它开口"', String(running?.progressText).includes('等它开口'))

    // 回合 7 是用户自己开着的回合；我们那条消息被 step 边界捞进同一回合
    clock.t = 1500
    runner.onEvent(SID, ev('turn/start', { turn: 7 }))
    runner.onEvent(SID, textMsg('（用户自己的回答，先出现）'))
    runner.onEvent(SID, handoff('task_a'))
    runner.onEvent(SID, ev('tool/call', { turn: 7, step: 1, callId: 'c1', name: 'read', arguments: { file_path: 'D:\\x\\资料.md' } }))

    check('认领前不记步（那条 tool/call 属于用户自己的回合）', outboxOf(bridge.dirs, 'task_a')?.steps === 0)

    // 节流：连续工具调用在 3 秒内不该写盘
    clock.t = 1800
    runner.onEvent(SID, ev('tool/call', { turn: 7, step: 2, callId: 'c2', name: 'read', arguments: { file_path: 'D:\\x\\b.md' } }))
    clock.t = 2200
    runner.onEvent(SID, ev('tool/call', { turn: 7, step: 3, callId: 'c3', name: 'write', arguments: { file_path: 'D:\\x\\index.html' } }))
    check('节流：3 秒内的进度不写盘', outboxOf(bridge.dirs, 'task_a')?.steps === 0)

    clock.t = 5200
    runner.onEvent(SID, ev('tool/call', { turn: 7, step: 4, callId: 'c4', name: 'write', arguments: { file_path: 'D:\\x\\index.html' } }))
    const throttled = outboxOf(bridge.dirs, 'task_a')
    check('过了节流窗 → 一次写盘带上累计步数', throttled?.steps === 4)
    check('节流后的最近工具正确', throttled?.lastTool === 'write')
    check('进度文案带文件名', String(throttled?.progressText).includes('index.html'))
    check('进度文案带步数', String(throttled?.progressText).includes('第 4 步'))

    // 回合结束：assistant/message 里的 reasoning 不能被当正文
    clock.t = 7000
    runner.onEvent(SID, ev('assistant/message', {
      turn: 7,
      step: 5,
      message: {
        content: [
          { type: 'reasoning', text: '内心独白不该回传' },
          { type: 'text', text: '做好了：index.html 三章 20 题。' },
        ],
      },
    }))
    const settled = runner.onEvent(SID, ev('turn/end', { turn: 7, reason: { kind: 'completed' } }))
    check('turn/end 结算出快照', Boolean(settled))
    const done = outboxOf(bridge.dirs, 'task_a')
    check('状态变 done', done?.status === 'done')
    check('结果是要给用户的那段正文', done?.result === '做好了：index.html 三章 20 题。')
    check('结果里没有内心独白', !String(done?.result).includes('内心独白'))
    check('最终步数写进 outbox', done?.steps === 4)
    check('error 为 null', done?.error === null)
    check('结算后不再占着队列', runner.status().active === null)
    check('终态不受节流：立刻落盘', done?.updatedAt === 7000)
  } finally {
    bridge.cleanup()
  }
}

// ───────────────────────────────────────────────────────── 串行
process.stdout.write('── 串行：一次只跑一条\n')

{
  const bridge = makeBridge()
  try {
    writeInbox(bridge.dirs, taskOf('task_a'))
    writeInbox(bridge.dirs, taskOf('task_b', { createdAt: NOW + 1000, title: '第二件' }))
    approve(bridge.dirs, 'task_a')
    approve(bridge.dirs, 'task_b')
    const { runner, dispatched } = harness(bridge.dirs)

    await runner.tick()
    check('先投先来的那条', dispatched.length === 1 && dispatched[0] === 'task_a')
    const queued = outboxOf(bridge.dirs, 'task_b')
    check('后面那条落了 queued（小星能看到"收到了，排队中"）', queued?.status === 'queued')

    await runner.tick()
    check('前一条没结束时不再投', dispatched.length === 1 && runner.status().stats.dispatched === 1)

    runner.onEvent(SID, ev('turn/start', { turn: 2 }))
    runner.onEvent(SID, handoff('task_a'))
    runner.onEvent(SID, ev('assistant/message', { turn: 2, message: { content: [{ type: 'text', text: '第一条完成' }] } }))
    runner.onEvent(SID, ev('turn/end', { turn: 2, reason: { kind: 'completed' } }))
    await runner.tick()
    check('前一条结束后自动投下一条', dispatched.length === 2 && dispatched[1] === 'task_b')
    check('第二条也进了 running', outboxOf(bridge.dirs, 'task_b')?.status === 'running')
    check('两条都没有重复投递', dispatched.filter((id) => id === 'task_a').length === 1)
  } finally {
    bridge.cleanup()
  }
}

// ───────────────────────────────────────────────────────── 失败与边界
process.stdout.write('── 失败、孤儿、错会话、错回合、超时\n')

{
  const bridge = makeBridge()
  try {
    // ① 回合被中断 → failed，但仍带走已有的正文
    writeInbox(bridge.dirs, taskOf('task_fail'))
    approve(bridge.dirs, 'task_fail')
    const { runner } = harness(bridge.dirs)
    await runner.tick()
    runner.onEvent(SID, ev('turn/start', { turn: 3 }))
    runner.onEvent(SID, handoff('task_fail'))
    runner.onEvent(SID, ev('assistant/message', { turn: 3, message: { content: [{ type: 'text', text: '先写了一半' }] } }))
    runner.onEvent(SID, ev('turn/end', { turn: 3, reason: { kind: 'aborted' } }))
    const aborted = outboxOf(bridge.dirs, 'task_fail')
    check('aborted → failed（不谎报完成）', aborted?.status === 'failed')
    check('失败原因写进 error', String(aborted?.error).includes('aborted'))
    check('失败也保留已产出的正文', aborted?.result === '先写了一半')

    // ② 对方实例重启 → 孤儿 running 标 failed
    writeInbox(bridge.dirs, taskOf('task_orphan'))
    approve(bridge.dirs, 'task_orphan')
    writeJsonAtomic(join(bridge.dirs.outboxDir, 'task_orphan.json'), {
      ...createOutbox('task_orphan', 1),
      status: 'running',
      progressText: '跑到一半',
    })
    const second = harness(bridge.dirs)
    await second.runner.tick()
    const orphan = outboxOf(bridge.dirs, 'task_orphan')
    check('孤儿 running → failed（不让小星干等）', orphan?.status === 'failed')
    check('孤儿失败原因说清是重启', String(orphan?.error).includes('重启'))

    // ③ 别的会话的事件不算
    writeInbox(bridge.dirs, taskOf('task_other'))
    approve(bridge.dirs, 'task_other')
    const third = harness(bridge.dirs)
    await third.runner.tick()
    third.runner.onEvent('session-别的会话', ev('turn/start', { turn: 4 }))
    third.runner.onEvent('session-别的会话', handoff('task_other'))
    third.runner.onEvent('session-别的会话', ev('tool/call', { turn: 4, name: 'write', arguments: {} }))
    third.runner.onEvent('session-别的会话', ev('turn/end', { turn: 4, reason: { kind: 'completed' } }))
    check('别的会话的事件完全不算', outboxOf(bridge.dirs, 'task_other')?.status === 'running')

    // ④ 目标会话里"我们进场之前"的回合不能算
    third.runner.onEvent(SID, ev('turn/start', { turn: 9 }))
    third.runner.onEvent(SID, ev('assistant/message', { turn: 9, message: { content: [{ type: 'text', text: '用户自己那一轮' }] } }))
    third.runner.onEvent(SID, ev('turn/end', { turn: 9, reason: { kind: 'completed' } }))
    check('没认领的回合结束不平账', outboxOf(bridge.dirs, 'task_other')?.status === 'running')
    check('用户那一轮的回答没被当结果', outboxOf(bridge.dirs, 'task_other')?.result === null)

    // ⑤ 认领之后正常完成
    third.runner.onEvent(SID, ev('turn/start', { turn: 10 }))
    third.runner.onEvent(SID, handoff('task_other'))
    third.runner.onEvent(SID, ev('assistant/message', { turn: 10, message: { content: [{ type: 'text', text: '这个任务做完了' }] } }))
    third.runner.onEvent(SID, ev('turn/end', { turn: 10, reason: { kind: 'completed' } }))
    check('认领后正常完成', outboxOf(bridge.dirs, 'task_other')?.status === 'done')
    check('结果只来自认领后的回合', outboxOf(bridge.dirs, 'task_other')?.result === '这个任务做完了')

    // ⑥ 超时
    writeInbox(bridge.dirs, taskOf('task_slow'))
    approve(bridge.dirs, 'task_slow')
    const slowClock = { t: 1000 }
    const slow = harness(bridge.dirs, { now: () => slowClock.t, staleActiveMs: 60_000 })
    await slow.runner.tick()
    slowClock.t = 1000 + 61_000
    await slow.runner.tick()
    const timedOut = outboxOf(bridge.dirs, 'task_slow')
    check('卡太久 → failed（队列才不会永久堵住）', timedOut?.status === 'failed')
    check('超时原因写清分钟数', String(timedOut?.error).includes('分钟'))

    // ⑦ 投递抛异常 → 先退回 queued 重试，连续 3 次才判失败
    writeInbox(bridge.dirs, taskOf('task_boom'))
    approve(bridge.dirs, 'task_boom')
    const boom = harness(bridge.dirs, {
      dispatch: async () => {
        throw new Error('resolveAgent 没给出 agent')
      },
    })
    await boom.runner.tick()
    check('第一次投递失败 → 退回 queued（不把瞬时失败写成任务失败）', outboxOf(bridge.dirs, 'task_boom')?.status === 'queued')
    check('重试提示写进进度', String(outboxOf(bridge.dirs, 'task_boom')?.progressText).includes('稍后重试'))
    await boom.runner.tick()
    await boom.runner.tick()
    const boomOutbox = outboxOf(bridge.dirs, 'task_boom')
    check('连续 3 次失败 → failed', boomOutbox?.status === 'failed')
    check('异常原因写进 error', String(boomOutbox?.error).includes('resolveAgent'))
    check('失败里写明试了几次', String(boomOutbox?.error).includes('3 次'))
  } finally {
    bridge.cleanup()
  }
}

// 极简配置校验：缺 sessionId 要立刻抛（静默不投是最糟的失败方式）
{
  const bridge = makeBridge()
  try {
    let threw = false
    try {
      createRunner({ dirs: bridge.dirs, sessionId: '', dispatch: async () => {} })
    } catch {
      threw = true
    }
    check('缺 sessionId → 构造时就抛', threw)
  } finally {
    bridge.cleanup()
  }
}

process.stdout.write(`\n${passed} 项通过`)
if (failed.length) {
  process.stdout.write(`，${failed.length} 项失败：\n${failed.map((f) => `  ❌ ${f}`).join('\n')}\n`)
  process.exit(1)
}
process.stdout.write('，0 项失败\n')
