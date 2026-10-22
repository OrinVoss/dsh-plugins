/**
 * 跨实例任务投递桥 · 编程助手侧（desktop 实例）的纯逻辑。
 *
 * ## 为什么单独一个文件
 *
 * `host.js` 要 `import { createUserMessage } from '@deepseek-ai/dsh-llm'`、
 * 还要 `ctx.sessionController` —— 在 DSH 进程外面一行都跑不了。
 * 于是"什么样的任务能投""进度怎么写进 outbox""什么时候算完"这些
 * **真会出错的判断**全在这里，只依赖 node: 内置，可以用假目录 + 假事件流测。
 *
 * `host.js` 只剩三件事：把 `dispatch` 接到 `resolveAgent → followup → flush`、
 * 把 `session/event` 转给 `onEvent`、把定时器转给 `tick`。
 *
 * ## 状态机（一张图）
 *
 * ```
 * inbox/<id>.json
 *    │ tick() 扫（每 3 秒）
 *    ▼
 * queued ──dispatch()──▶ running ──turn/end(completed)──▶ done
 *                              └──turn/end(其他原因)──▶ failed
 * ```
 *
 * **一次只跑一条**：同一个会话里并发两条任务，两边的文字会缠在一起，
 * "最终答复"到底是谁的也说不清。所以排在后面的老老实实 queued。
 *
 * ## 认领回合：为什么不能只看 turn/end
 *
 * 目标会话是用户正在用的会话，我们投进去的消息可能：
 *   · 在**开着的回合**里被 step 边界捞进去（同一回合）
 *   · 也可能等这一回合结束、新开一回合
 * 所以靠"我们那条 user/message 出现在哪个回合"来认领：
 * 事件里 `source.kind === 'handoff'`，正文带着 taskId。
 * 只按 turn/end 判，会把用户自己那一轮的答复当成任务结果回传。
 */

import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** 协议版本，与 `dsh-xiaoxing-handoff/handoff-core.js` 的保持一致。 */
export const PROTOCOL_VERSION = 1

/** 任务编号的合法形状（同时是路径安全边界，见小星侧注释）。 */
export const TASK_ID_RE = /^task_[0-9a-z]+(?:-[0-9a-z]+)*$/

/** 终态。 */
export const TERMINAL_STATUSES = new Set(['done', 'failed'])

/** 共享总线的目录布局（必须与小星侧 `pathsOf` 一致）。 */
export function pathsOf(bridgeDir) {
  const root = String(bridgeDir ?? '').trim()
  return {
    root,
    inboxDir: join(root, 'inbox'),
    outboxDir: join(root, 'outbox'),
    approvalsDir: join(root, 'approvals'),
  }
}

/** 建目录（inbox 由对面写，outbox/approvals 由这边写；都建齐免得互相等）。 */
export function ensureDirs(dirs) {
  for (const dir of [dirs.inboxDir, dirs.outboxDir, dirs.approvalsDir]) mkdirSync(dir, { recursive: true })
}

/** 原子写（同 writeJsonAtomic，两侧各自实现，理由见文件头）。 */
export function writeJsonAtomic(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  writeFileSync(tmp, text, 'utf8')
  try {
    renameSync(tmp, file)
  } catch {
    writeFileSync(file, text, 'utf8')
    try {
      unlinkSync(tmp)
    } catch {
      /* 临时文件清不掉不影响正确性 */
    }
  }
  return file
}

/** 读 JSON，不抛异常（失败当数据返回）。 */
export function readJsonFile(file) {
  try {
    if (!existsSync(file)) return { ok: false, missing: true, error: null, value: null }
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    if (!raw.trim()) return { ok: false, missing: false, error: '空文件', value: null }
    return { ok: true, missing: false, error: null, value: JSON.parse(raw) }
  } catch (error) {
    return { ok: false, missing: false, error: error?.message ?? String(error), value: null }
  }
}

/** 列 `<taskId>.json`。 */
function listTaskIds(dir) {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .filter((taskId) => TASK_ID_RE.test(taskId))
      .sort()
  } catch {
    return []
  }
}

/**
 * 把 inbox 里的裸 JSON 规整成任务对象。
 *
 * 宽松策略：taskId 合法 + title 非空就算任务；其余字段缺了填空串。
 * 严格校验会把"对面版本略旧、少一个字段"变成静默不投递 ——
 * 而静默失败正是这个桥最不该有的失败方式。
 */
export function normalizeTask(raw, fallbackId = '') {
  if (!raw || typeof raw !== 'object') return null
  const taskId = String(raw.taskId ?? fallbackId ?? '').trim()
  if (!TASK_ID_RE.test(taskId)) return null
  const title = String(raw.title ?? '').trim()
  if (!title) return null
  return {
    taskId,
    createdAt: Number(raw.createdAt) || 0,
    title,
    why: String(raw.why ?? '').trim(),
    what: String(raw.what ?? '').trim(),
    deliverable: String(raw.deliverable ?? '').trim(),
    deadline: String(raw.deadline ?? '').trim(),
    from: String(raw.from ?? 'unknown').trim() || 'unknown',
  }
}

/** 扫 inbox，按 createdAt 升序（先来的先做）。坏文件跳过，不阻塞整条队列。 */
export function scanInbox(dirs) {
  const tasks = []
  for (const taskId of listTaskIds(dirs.inboxDir)) {
    const read = readJsonFile(join(dirs.inboxDir, `${taskId}.json`))
    if (!read.ok) continue
    const task = normalizeTask(read.value, taskId)
    if (task) tasks.push({ task, mtimeMs: mtimeOf(join(dirs.inboxDir, `${taskId}.json`)) })
  }
  tasks.sort((a, b) => a.task.createdAt - b.task.createdAt || a.task.taskId.localeCompare(b.task.taskId))
  return tasks
}

function mtimeOf(file) {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/** 读批准记录；没有就返回 null（= 没批准）。 */
export function readApproval(dirs, taskId) {
  const read = readJsonFile(join(dirs.approvalsDir, `${taskId}.json`))
  return read.ok ? read.value : null
}

/** 批准状态字符串：pending / approved / rejected / missing。 */
export function approvalState(dirs, taskId) {
  const record = readApproval(dirs, taskId)
  return String(record?.state ?? 'missing')
}

/** outbox 的初始形状（字段顺序按协议表）。 */
export function createOutbox(taskId, now) {
  return {
    taskId,
    status: 'queued',
    updatedAt: Number(now) || Date.now(),
    steps: 0,
    lastTool: null,
    progressText: '已排队，等编程助手接手',
    result: null,
    error: null,
  }
}

/**
 * 投进会话的那段正文。
 *
 * 必须自带 taskId：认领回合、排障、以及对方回话时引用都靠它。
 * 也要写清"你的最终正文会被原样回传" —— 否则它可能只回一句"好的"。
 */
export function composeTaskMessage(task) {
  const lines = [
    '【跨实例协作请求】这条消息由 dsh-xiaoxing-bridge 自动投递，来自学习监督助手「小星」（另一个 DSH 实例，study 侧）。',
    '不是你用户在这里打的字，但**它是真的在请你干活**，按用户请求对待。',
    '',
    `任务编号：${task.taskId}`,
    `标题：${task.title}`,
  ]
  if (task.why) lines.push(`为什么要你做：${task.why}`)
  lines.push(
    `要你做什么：${task.what || '（没写细节，按标题理解）'}`,
    `交付物：${task.deliverable || '（没写，就地交付即可）'}`,
    task.deadline ? `截止：${task.deadline}` : '截止：没定',
    '',
    '约定：',
    '- 你这一轮的**最终助手正文**会被原样回传给小星，不用另写汇报。',
    '- 进度（工具调用次数 / 最近一个工具）由宿主自动回传，也不用汇报。',
    '- 做不了或信息不够，就直接在这一轮里说清楚；这段说明同样会回传给小星。',
    `- 结束时把交付物放到上面的位置；这一轮结束即视为交付（任务编号 ${task.taskId}）。`,
  )
  return lines.join('\n')
}

/**
 * 从 `assistant/message` 事件里取**该回传的正文**。
 *
 * ⚠️ 判据只能是 `type === 'text'`。放宽成"有 text 字段就算"会把 reasoning
 * （思考片段）也捞进去 —— 手机通道 2026-10-22 就因此把内心独白发到了手机上。
 * 这里照抄那条已经修过的判据。
 */
export function assistantTextOf(event) {
  const message = event?.data?.message
  if (!message) return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
}

/** `user/message` 事件的正文（用来认"我们那条任务消息进了哪个回合"）。 */
export function messageTextOf(event) {
  const message = event?.data
  if (!message) return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
}

/** 事件里那条消息是不是我们投的（source.kind === 'handoff'）。 */
export function isHandoffMessage(event) {
  const source = event?.data?.source
  return Boolean(source && typeof source === 'object' && source.kind === 'handoff')
}

/** 从工具参数里挑一个"人看得懂的目标"（文件名优先）。 */
function pickTarget(args) {
  if (!args || typeof args !== 'object') return ''
  for (const key of ['file_path', 'filePath', 'path', 'target', 'filename', 'url']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return basename(value.trim())
  }
  for (const key of ['command', 'description', 'query', 'pattern', 'taskId']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 40)
  }
  return ''
}

/** 进度文案：`正在写 index.html（第 7 步）` 那种。 */
export function progressLine(toolName, args, steps) {
  const name = String(toolName ?? '').trim() || '工具'
  const target = pickTarget(args)
  return target ? `正在调用 ${name}（${target}，第 ${steps} 步）` : `正在调用 ${name}（第 ${steps} 步）`
}

/** 截断（超长结果不整段塞进 outbox，但要说清截了多少）。 */
export function truncateText(text, maxChars) {
  const raw = String(text ?? '')
  const limit = Math.max(0, Math.floor(Number(maxChars) || 0))
  if (!limit || raw.length <= limit) return { text: raw, truncated: false, originalLength: raw.length }
  return { text: raw.slice(0, limit), truncated: true, originalLength: raw.length }
}

/**
 * 造运行器。所有副作用（派发、写盘、时钟、日志）都是注入的，所以能测。
 *
 * @param {object} options
 * @param {ReturnType<typeof pathsOf>} options.dirs
 * @param {string} options.sessionId 目标会话（只认这个会话的事件）
 * @param {(task: object) => Promise<void>} options.dispatch 真正投进会话（日志/推送之外唯一的外部动作）
 * @param {boolean} [options.requireApproval] 没有 approved 批准记录就不投（默认 true）
 * @param {number} [options.throttleMs] outbox 写盘节流（规格：最多每 3 秒一次）
 * @param {number} [options.maxResultChars]
 * @param {() => number} [options.now]
 * @param {(line: string) => void} [options.log]
 * @param {() => boolean} [options.isKilled]
 * @param {number} [options.staleActiveMs] 卡死多久算超时（0 = 不判）
 * @param {number} [options.maxDispatchAttempts] 投递失败重试几次（默认 3）
 */
export function createRunner(options) {
  const {
    dirs,
    sessionId,
    dispatch,
    requireApproval = true,
    throttleMs = 3_000,
    maxResultChars = 8_000,
    now = () => Date.now(),
    log = () => {},
    isKilled = () => false,
    staleActiveMs = 30 * 60_000,
    maxDispatchAttempts = 3,
  } = options ?? {}

  if (!dirs || !dirs.root) throw new Error('createRunner 需要 dirs（pathsOf(bridgeDir)）')
  if (!String(sessionId ?? '').trim()) throw new Error('createRunner 需要 sessionId')
  if (typeof dispatch !== 'function') throw new Error('createRunner 需要 dispatch 回调')

  let active = null
  let openTurn = null
  let stopped = false
  const dispatchFailures = new Map()
  const stats = { dispatched: 0, done: 0, failed: 0, approvalsPending: 0, skipped: 0 }

  const outboxFile = (taskId) => join(dirs.outboxDir, `${taskId}.json`)
  const readOutbox = (taskId) => {
    const read = readJsonFile(outboxFile(taskId))
    return read.ok && read.value && typeof read.value === 'object' ? read.value : null
  }

  /** 写 outbox。force=true 绕过节流（状态跃迁必须立刻可见）。 */
  function writeOutbox(outbox, force = false) {
    outbox.updatedAt = now()
    if (!force && active && outbox.taskId === active.taskId && now() - active.lastWriteAt < throttleMs) {
      active.pendingWrite = true
      return false
    }
    try {
      writeJsonAtomic(outboxFile(outbox.taskId), outbox)
    } catch (error) {
      log(`写 outbox 失败（${outbox.taskId}）：${error?.message}`)
      return false
    }
    if (active && outbox.taskId === active.taskId) {
      active.lastWriteAt = now()
      active.pendingWrite = false
    }
    return true
  }

  /** 把内存里的进度同步进 outbox 并落盘（节流）。 */
  function flushProgress(force = false) {
    if (!active) return false
    const outbox = active.outbox
    outbox.steps = active.steps
    outbox.lastTool = active.lastTool
    outbox.progressText = active.progressText
    return writeOutbox(outbox, force)
  }

  function finish({ status, result = null, error = null }) {
    if (!active) return null
    const outbox = active.outbox
    outbox.status = status
    outbox.steps = active.steps
    outbox.lastTool = active.lastTool
    outbox.result = result === null ? null : String(result)
    outbox.error = error === null ? null : String(error)
    outbox.progressText = status === 'done' ? `已完成（${active.steps} 步）` : `失败：${String(error ?? '').split('\n')[0].slice(0, 120)}`
    writeOutbox(outbox, true)
    const snapshot = { ...outbox }
    if (status === 'done') stats.done += 1
    else stats.failed += 1
    log(`任务 ${active.taskId} → ${status}（${active.steps} 步${result ? `，正文 ${String(result).length} 字` : ''}）`)
    active = null
    return snapshot
  }

  /** 上次进程跑到一半的 running：标失败，别让小星干等。 */
  function failOrphan(outbox) {
    const next = {
      ...createOutbox(outbox.taskId, now()),
      ...outbox,
      status: 'failed',
      updatedAt: now(),
      progressText: '上次运行时中断，任务没做完',
      error: '编程助手侧的桥在任务进行中重启/退出，这一轮没跑到结束。需要重新投递。',
    }
    writeJsonAtomic(outboxFile(outbox.taskId), next)
    stats.failed += 1
    stats.skipped += 1
    log(`发现孤儿任务 ${outbox.taskId}（上次没跑完）→ 标 failed，不然小星会一直等`)
  }

  /** 挑一条能投的：没做完、批准过、先来先做。 */
  function pickCandidate() {
    for (const entry of scanInbox(dirs)) {
      const task = entry.task
      const outbox = readOutbox(task.taskId)
      if (outbox && TERMINAL_STATUSES.has(String(outbox.status))) continue
      if (outbox && String(outbox.status) === 'running') {
        failOrphan(outbox)
        continue
      }
      if (requireApproval) {
        const state = approvalState(dirs, task.taskId)
        if (state !== 'approved') {
          stats.approvalsPending += 1
          continue
        }
      }
      return { task, outbox }
    }
    return null
  }

  /**
   * 给"已批准但还没轮上"的任务落一个 queued 的 outbox。
   *
   * 为什么要这一步：任务排在别人后面时，如果连 outbox 都没有，
   * 小星那边看到的是"已批准，等编程助手接手" —— 分不清"收到了"和"根本没看见"。
   * 写了 queued，它就知道**这个桥确实读到了**，只是还没轮到。
   */
  function markQueued() {
    for (const entry of scanInbox(dirs)) {
      const task = entry.task
      if (active && task.taskId === active.taskId) continue
      if (readOutbox(task.taskId)) continue
      if (requireApproval && approvalState(dirs, task.taskId) !== 'approved') continue
      const outbox = createOutbox(task.taskId, now())
      try {
        writeJsonAtomic(outboxFile(task.taskId), outbox)
      } catch (error) {
        log(`写 queued 失败（${task.taskId}）：${error?.message}`)
      }
    }
  }

  async function start(task, existing) {
    const outbox = existing && String(existing.status) === 'queued' ? { ...existing } : createOutbox(task.taskId, now())
    active = {
      taskId: task.taskId,
      task,
      turn: null,
      awaitTurn: false,
      steps: 0,
      lastTool: null,
      progressText: '已投递给编程助手，等它开口',
      lastAssistantText: '',
      startedAt: now(),
      lastWriteAt: 0,
      pendingWrite: false,
      outbox,
    }
    // 状态跃迁不受节流：queued 已经落过盘，这里立刻变 running，
    // 小星才不会把"等它开口"看成"卡住了"
    outbox.status = 'running'
    outbox.steps = 0
    outbox.lastTool = null
    outbox.progressText = active.progressText
    writeOutbox(outbox, true)
    try {
      await dispatch(task)
      dispatchFailures.delete(task.taskId)
      stats.dispatched += 1
      log(`已投递 ${task.taskId}「${task.title}」→ ${sessionId}`)
    } catch (error) {
      // ⚠️ dispatch 期间可能已经有事件进来（flush 会推动会话），
      //    所以只有 active 还在时才结算 —— 否则会把已结算的任务改回 failed
      if (!active || active.taskId !== task.taskId) return
      const attempts = (dispatchFailures.get(task.taskId) ?? 0) + 1
      dispatchFailures.set(task.taskId, attempts)
      const reason = `投递失败：${error?.message ?? error}`
      if (attempts >= maxDispatchAttempts) {
        finish({ status: 'failed', error: `${reason}（试了 ${attempts} 次）` })
        return
      }
      // 刚重启时服务可能还没就绪 —— 退回 queued 再试，
      // 别把一次瞬时失败写成"任务失败"（小星会以为对方不接）
      outbox.status = 'queued'
      outbox.progressText = `${reason.slice(0, 120)}（第 ${attempts} 次，稍后重试）`
      outbox.error = null
      writeOutbox(outbox, true)
      active = null
      log(`投递失败第 ${attempts}/${maxDispatchAttempts} 次，退回 queued 重试：${reason}`)
    }
  }

  /** 一次心跳：清孤儿、判超时、投下一条。 */
  async function tick() {
    if (stopped || isKilled()) return { dispatched: false, skipped: 'stopped' }
    if (active) {
      if (staleActiveMs > 0 && now() - active.startedAt > staleActiveMs) {
        finish({
          status: 'failed',
          error: `等了 ${Math.round(staleActiveMs / 60000)} 分钟还没等到这一轮结束（可能被中断在别处）。`,
        })
      } else {
        markQueued()
        return { dispatched: false, skipped: 'busy' }
      }
    }
    markQueued()
    const candidate = pickCandidate()
    if (!candidate) return { dispatched: false, skipped: 'idle' }
    await start(candidate.task, candidate.outbox)
    return { dispatched: true }
  }

  /**
   * 收会话事件。只认目标会话，只认自己认领的那个回合。
   *
   * @returns {object|null} 结算时的 outbox 快照（只有 turn/end 会返回）
   */
  function onEvent(sessionIdIn, event) {
    if (stopped || !active) return null
    if (String(sessionIdIn ?? '') !== String(sessionId)) return null
    if (!event || typeof event !== 'object') return null
    const data = event.data ?? {}

    if (event.type === 'turn/start') {
      openTurn = data.turn
      if (active.turn === null && active.awaitTurn) {
        active.turn = data.turn
        active.awaitTurn = false
      }
      return null
    }

    if (event.type === 'turn/end') {
      const ours = active && active.turn !== null && data.turn === active.turn
      openTurn = null
      if (!ours) return null
      const kind = String(data.reason?.kind ?? 'completed')
      const cut = truncateText(active.lastAssistantText.trim(), maxResultChars)
      if (kind === 'completed' || kind === 'max-tokens') {
        if (!cut.text.trim()) {
          return finish({ status: 'failed', error: '这一轮没有可回传的正文（可能只有工具调用，或在中途停下）' })
        }
        return finish({ status: 'done', result: cut.text })
      }
      return finish({
        status: 'failed',
        result: cut.text || null,
        error: `回合结束原因：${kind}（不是正常完成，结果可能不完整）`,
      })
    }

    if (event.type === 'user/message') {
      // 认领：我们投的那条消息出现在哪个回合，那个回合就是这次任务的
      if (active.turn !== null) return null
      if (!isHandoffMessage(event) && !messageTextOf(event).includes(active.taskId)) return null
      if (openTurn !== null) active.turn = openTurn
      else active.awaitTurn = true
      return null
    }

    if (active.turn === null) return null
    if (data.turn !== undefined && data.turn !== active.turn) return null

    if (event.type === 'assistant/message') {
      const text = assistantTextOf(event)
      if (text.trim()) active.lastAssistantText = text
      return null
    }

    if (event.type === 'tool/call') {
      active.steps += 1
      active.lastTool = String(data.name ?? '') || null
      active.progressText = progressLine(data.name, data.arguments, active.steps)
      flushProgress(false)
      return null
    }

    return null
  }

  function status() {
    return {
      sessionId,
      active: active ? { taskId: active.taskId, title: active.task.title, turn: active.turn, steps: active.steps, startedAt: active.startedAt } : null,
      stats: { ...stats },
    }
  }

  function dispose() {
    stopped = true
  }

  return { tick, onEvent, status, dispose, flushProgress }
}
