/**
 * 跨实例任务投递桥 · 编程助手侧（desktop 实例）宿主插件。
 *
 * ## 它做什么
 *
 * 每 3 秒扫一次共享 `inbox/`：发现**已批准**的新任务，就把它当成一条用户消息
 * 投进目标会话（`session-331d9500…`，工作区 `D:\桌面\自主工作空间`），
 * 然后把那个会话的进度与最终答复写进 `outbox/`，让小星轮询。
 *
 * ## 为什么必须在这里做
 *
 * 「另一个进程往会话里塞一条消息并叫醒它」只能靠宿主服务：
 *
 * ```js
 * const resolved = await ctx.sessionController.resolveAgent(sessionId)
 * resolved.agent.followup(createUserMessage({ content, source: { kind: 'handoff' } }))
 * await ctx.sessions.flush(resolved.agent.session)
 * ```
 *
 * 抄的是手机通道 / 看门狗的写法（`catch` 里的失败一律只记日志，
 * **不让一次投递失败把插件带崩** —— 桥崩了没人知道，比投失败更糟）。
 *
 * ## 三个行为约定
 *
 * 1. **一次只跑一条**：同一会话并发两条任务，正文会缠在一起，"最终答复"也说不清是谁的。
 * 2. **进度写盘最多每 3 秒一次**（`throttleMs`）：工具调用一串串来，不节流就是把
 *    磁盘当日志写，还会让对面每 3 秒看到一次"变化"。
 * 3. **状态跃迁不受节流**：queued→running、running→done 必须立刻可见，
 *    否则小星看到的是"卡在排队"。
 *
 * ## ⚠️ 装完要重启 desktop 实例才生效
 *
 * 宿主半边不随客户端热更（见 `~/.dsh/AGENTS.md` 的插件坑）。本插件**不会**
 * 自己重启任何实例。
 */

import { appendFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { createUserMessage } from '@deepseek-ai/dsh-llm'

import {
  composeTaskMessage,
  createRunner,
  ensureDirs,
  pathsOf,
} from './bridge-core.js'

export const name = 'xiaoxing-bridge'

/**
 * 需要的服务。
 *
 * ⚠️ 函数式插件的 `inject` 是**模块级导出**，不是 `apply.inject`。
 * 写错时插件照样加载、定时器照跑，但一碰 `ctx.sessionController` 就抛
 * `cannot get property "sessionController" without inject`。
 */
export const inject = ['sessionController', 'sessions']

/** 默认配置。**路径不给默认值**，全部由 cordis.patch.yml 给。 */
const DEFAULTS = {
  /** 共享总线目录。空 = 插件不启动（宁可什么都不做，也别往猜出来的路径写） */
  bridgeDir: '',
  /** 目标会话：投给谁。空 = 插件不启动 */
  sessionId: '',
  /** 扫 inbox 的间隔（规格：3 秒） */
  pollIntervalMs: 3_000,
  /** outbox 写盘节流（规格：最多每 3 秒一次） */
  throttleMs: 3_000,
  /** 没有批准记录就不投（默认 true，和"批准前不投递"的规格一致） */
  requireApproval: true,
  /** 回传正文上限（字符） */
  maxResultChars: 8_000,
  /** 一条任务卡多久算超时（0 = 不判） */
  staleActiveMs: 30 * 60_000,
  /** 投递失败重试几次（刚重启时服务可能还没就绪，别把瞬时失败写成任务失败） */
  maxDispatchAttempts: 3,
  /** 日志。空 = 不写文件 */
  logFile: '',
  /** 心跳文件（写"我还活着 + 当前在跑哪条"，排障第一现场） */
  heartbeatFile: '',
  /** 心跳间隔 */
  heartbeatIntervalMs: 30_000,
  /** 停开关：文件存在就不再投递（删掉即恢复，不用重启） */
  killSwitchFile: '',
}

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) }

  /**
   * 取数字配置。
   *
   * ⚠️ 不能用 `Number(x) || 默认值`：`0` 是合法值（`throttleMs: 0` = 关节流，
   * `staleActiveMs: 0` = 不判超时），用 `||` 会把 0 悄悄换成默认值，
   * 现场表现是"配了关不掉"。这个坑联调测试直接踩到了。
   */
  function numberOr(value, fallback) {
    const n = Number(value)
    return Number.isFinite(n) && n >= 0 ? n : fallback
  }

  function log(message) {
    const line = `[${new Date().toISOString()}] ${message}`
    if (config.logFile) {
      try {
        mkdirSync(dirname(config.logFile), { recursive: true })
        appendFileSync(config.logFile, `${line}\n`, 'utf8')
      } catch {
        /* 日志写不了不能把桥搞崩 */
      }
    }
    try {
      ctx.logger?.info?.(`xiaoxing-bridge: ${message}`)
    } catch {
      /* 没有 logger 就算了 */
    }
  }

  const bridgeDir = String(config.bridgeDir ?? '').trim()
  const sessionId = String(config.sessionId ?? '').trim()
  if (!bridgeDir || !sessionId) {
    log(`配置不全（bridgeDir=${JSON.stringify(bridgeDir)}，sessionId=${JSON.stringify(sessionId)}）—— 跨实例桥不启动`)
    return
  }

  const dirs = pathsOf(bridgeDir)
  try {
    ensureDirs(dirs)
  } catch (error) {
    log(`建不出共享目录（${bridgeDir}）：${error?.message} —— 跨实例桥不启动`)
    return
  }

  const killed = () => Boolean(config.killSwitchFile) && existsSync(config.killSwitchFile)

  let stopped = false
  let tickTimer = null
  let heartbeatTimer = null
  let ticking = false

  /**
   * 真正把任务投进会话。
   *
   * `flush` 必须 await：不 await 的话 outbox 会先写着 running，而消息可能还没进会话，
   * 一旦这一步抛错就永远没人知道任务没投出去。
   */
  async function dispatch(task) {
    const resolved = await ctx.sessionController.resolveAgent(sessionId)
    if (!resolved?.agent) throw new Error(`resolveAgent 没给出 agent（${sessionId}）`)
    const message = createUserMessage({
      content: [{ type: 'text', text: composeTaskMessage(task) }],
      // 自定义 source.kind：会话日志里能分清"用户打的"和"另一个实例投的"，
      // 认领回合也靠它（见 bridge-core 的 onEvent）
      source: { kind: 'handoff' },
    })
    resolved.agent.followup(message)
    await ctx.sessions.flush(resolved.agent.session)
  }

  const runner = (() => {
    try {
      return createRunner({
        dirs,
        sessionId,
        dispatch,
        requireApproval: config.requireApproval !== false,
        throttleMs: numberOr(config.throttleMs, DEFAULTS.throttleMs),
        maxResultChars: Math.max(200, numberOr(config.maxResultChars, DEFAULTS.maxResultChars)),
        staleActiveMs: numberOr(config.staleActiveMs, 0),
        maxDispatchAttempts: Math.max(1, numberOr(config.maxDispatchAttempts, DEFAULTS.maxDispatchAttempts)),
        log,
        isKilled: killed,
      })
    } catch (error) {
      // 构造失败只让这条桥不工作，**不能让整个 profile 加载失败**
      // —— 用户的会话在里面，插件崩了会把界面带下去
      log(`运行器建不起来：${error?.message} —— 跨实例桥不启动`)
      return null
    }
  })()
  if (!runner) return

  function beat() {
    if (!config.heartbeatFile) return
    try {
      mkdirSync(dirname(config.heartbeatFile), { recursive: true })
      writeFileSync(
        config.heartbeatFile,
        `${JSON.stringify(
          {
            at: new Date().toISOString(),
            bridgeDir,
            sessionId,
            killed: killed(),
            requireApproval: config.requireApproval !== false,
            ...runner.status(),
          },
          null,
          2,
        )}\n`,
        'utf8',
      )
    } catch (error) {
      log(`写心跳失败：${error?.message}`)
    }
  }

  async function tick() {
    if (stopped || ticking) return
    ticking = true
    try {
      const outcome = await runner.tick()
      if (outcome.dispatched) beat()
    } catch (error) {
      log(`tick 出错：${error?.stack ?? error}`)
    } finally {
      ticking = false
    }
  }

  // 会话事件：进度 / 终态的唯一来源
  const disposeEvents = ctx.on('session/event', (session, event) => {
    try {
      const snapshot = runner.onEvent(session?.id, event)
      if (snapshot) beat()
    } catch (error) {
      log(`处理会话事件出错（${event?.type}）：${error?.message}`)
    }
  })
  ctx.effect(() => disposeEvents, 'xiaoxing-bridge: session/event')

  tickTimer = setInterval(() => {
    tick().catch((error) => log(`tick 抛了：${error?.message}`))
  }, Math.max(500, numberOr(config.pollIntervalMs, DEFAULTS.pollIntervalMs)))
  tickTimer.unref?.()

  heartbeatTimer = setInterval(beat, Math.max(5_000, numberOr(config.heartbeatIntervalMs, DEFAULTS.heartbeatIntervalMs)))
  heartbeatTimer.unref?.()

  // 启动先跑一次：把上次没跑完的 running 标成 failed，并接手已排队的任务
  tick().catch((error) => log(`首轮 tick 抛了：${error?.message}`))
  beat()

  log(
    `跨实例桥起来了：共享目录 ${bridgeDir}，目标会话 ${sessionId}，每 ` +
      `${Math.round(numberOr(config.pollIntervalMs, DEFAULTS.pollIntervalMs) / 1000)} 秒扫一次，` +
      `${config.requireApproval !== false ? '要求批准' : '⚠️ 不要求批准（requireApproval=false）'}`,
  )
  if (killed()) log(`⚠️ 停开关已存在（${config.killSwitchFile}）—— 不投递`)

  ctx.effect(() => () => {
    stopped = true
    if (tickTimer) clearInterval(tickTimer)
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    runner.dispose()
    // 主动停止时删心跳（"没有心跳"和"心跳很旧"含义不同）
    try {
      if (config.heartbeatFile && existsSync(config.heartbeatFile)) unlinkSync(config.heartbeatFile)
    } catch {
      /* 删不掉无所谓 */
    }
    log('跨实例桥停了')
  })
}
