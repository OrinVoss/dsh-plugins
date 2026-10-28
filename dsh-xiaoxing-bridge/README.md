# dsh-xiaoxing-bridge —— 跨实例任务投递桥（编程助手侧）

每 3 秒扫一次共享 `inbox/`，把**已批准**的新任务当成一条用户消息投进指定会话；
再把那个会话的进度和最终答复写进 `outbox/`，让学习监督助手「小星」轮询。

它是 `D:\桌面\编程作品\study-kit\plugins\dsh-xiaoxing-handoff` 的另一半。
**两个插件必须配同一个 `bridgeDir`**，否则两边都显示"正常工作"，但永远见不到对方。

```
D:\桌面\自主工作空间\_bridge\
    inbox\<taskId>.json      小星写，这里读
    outbox\<taskId>.json     这里写，小星读
    approvals\<taskId>.json  人批没批（没有 approved 就不投）
```

## 它到底做了什么

```
inbox/<id>.json（approved）
    │ tick() 每 3 秒
    ▼
resolveAgent(sessionId)
  → agent.followup(createUserMessage({ content, source: { kind: 'handoff' } }))
  → await ctx.sessions.flush(agent.session)
    │
    ├─ ctx.on('session/event')：只认目标会话
    │     tool/call      → steps++ / lastTool / progressText（节流 ≤ 3 秒一次）
    │     assistant/message → 记住最后的正文（只认 type==='text'）
    │     turn/end       → done（或 failed）+ 写最终正文
    ▼
outbox/<id>.json
```

状态机：`queued → running → done | failed`。

**一次只跑一条**：同一个会话里并发两条任务，两边的文字会缠在一起，
"最终答复"到底是谁的也说不清。排在后面的保持 `queued`。

**认领回合**：目标会话是用户正在用的会话，我们投进去的消息可能被 step 边界捞进
"当前开着的回合"，也可能等下一回合。所以靠"哪条 `source.kind === 'handoff'` 的
用户消息出现在哪个回合"来认领，**不按 turn/end 硬判** —— 否则会把用户自己那轮的
回答当成任务结果回传（`test-bridge.mjs` 里有正反两个用例）。

## 装法（本机已完成，这里是给以后重装用的）

和其它自研插件一样：源码在 `~/.dsh/plugins/<包名>`，profile 里用 `link:` 依赖 +
`dsh.profile.bundles` 列出包名 + `node_modules` 里的 Junction。

```powershell
# 1) 源码目录（就是这个目录）
C:\Users\17040\.dsh\plugins\dsh-xiaoxing-bridge\

# 2) profile 的 package.json：dependencies 里加
"dsh-xiaoxing-bridge": "link:C:/Users/17040/.dsh/plugins/dsh-xiaoxing-bridge"

# 3) 同一个文件的 dsh.profile.bundles 里加
"dsh-xiaoxing-bridge"

# 4) node_modules 里的 Junction
New-Item -ItemType Junction `
  -Path  C:\Users\17040\.dsh\profiles\desktop\node_modules\dsh-xiaoxing-bridge `
  -Target C:\Users\17040\.dsh\plugins\dsh-xiaoxing-bridge
```

profile 的 `cordis.patch.yml` **不用改** —— 加载行（含 config）由本包的
`cordis.patch.yml` 自己声明（和 `dsh-memory` / `dsh-style-extras` 同一套做法）。
同一 id 在 profile 里再 insert 一次会加载两遍。

> ⚠️ **改完要重启 desktop 实例才生效**（宿主半边不随客户端热更）。
> 插件的代码/配置**不会**自己去重启任何实例 —— 重启会把用户从当前会话踢下去，
> 得由他自己挑时机。

## 配置（`cordis.patch.yml`）

| 键 | 说明 |
|---|---|
| `bridgeDir` | 共享目录（**必须和小星侧一致**）。空 = 不启动 |
| `sessionId` | 投给哪个会话。**空 = 不启动**（静默不投是最糟的失败方式） |
| `pollIntervalMs` | 扫 inbox 间隔（默认 3000） |
| `throttleMs` | outbox 写盘节流（默认 3000，**0 = 关节流**，只建议调试） |
| `requireApproval` | 没有 approved 记录就不投（默认 true）。**别关** |
| `maxResultChars` | 回传正文上限（默认 8000） |
| `staleActiveMs` | 一条任务卡多久标 failed、把队列放行（默认 30 分钟；0 = 不判） |
| `maxDispatchAttempts` | 投递失败重试几次（默认 3；失败会先退回 `queued`，不谎报任务失败） |
| `logFile` | 日志 |
| `heartbeatFile` / `heartbeatIntervalMs` | 心跳（"我还活着 + 在跑哪条"，排障第一现场） |
| `killSwitchFile` | 文件存在 = 不投递（删掉即恢复，不用重启） |

## 测试

三份，都是零依赖、不需要 DSH、不需要另一个实例：

```powershell
cd C:\Users\17040\.dsh\plugins\dsh-xiaoxing-bridge

node test-bridge.mjs   # 纯逻辑：66 项（假目录 + 假时钟 + 假事件流）
node test-e2e.mjs      # 端到端：39 项（两个真 host.js 对跑，临时目录里造总线）
```

`test-e2e.mjs` 需要小星侧插件在场，默认找
`D:\桌面\编程作品\study-kit\plugins\dsh-xiaoxing-handoff`；
换位置就设 `HANDOFF_PLUGIN_DIR`。找不到会**明确跳过**（跳过不算通过）。

`test-e2e.mjs` 会把两个插件复制到临时目录，并塞一个只有一行
`createUserMessage` 的 `@deepseek-ai/dsh-llm` 桩 —— 绝不往真插件目录里放 `node_modules`。

## 故障排查

```
① 心跳：C:\Users\17040\.dsh\logs\handoff-bridge.heartbeat
    不存在 → 插件没加载（或 profile 没重启）
    很旧   → 进程在但 tick 卡住（看日志）
    内容里 active=null 且 stats 全 0 → 加载了但没扫到任务（先看 bridgeDir 对不对）
② 日志：C:\Users\17040\.dsh\logs\handoff-bridge.log
    "没配 bridgeDir / sessionId" → 配置没生效
    "投递失败" → resolveAgent 没给出 agent（会话 id 拼错？会话被删？）
③ inbox 有文件但一直 queued？
    approvals/<id>.json 是 approved 吗？（pending = 小星还没拿到人的批准，正常的）
④ outbox 一直是 running？
    目标会话那一轮还没结束。日志里有"发现孤儿任务"= 上次进程跑到一半被重启了。
⑤ 会话里看不到任务消息？
    看 `~/.dsh` 的实例日志有没有插件加载失败（本文件第一行会打"跨实例桥起来了"）。
```

## 已知边界（诚实清单）

1. **没在真实 desktop 实例上跑过**：本次交付只做到"代码 + 离线测试 + 装进 profile"，
   需要用户重启 desktop 实例后才真正生效。
2. **一次只跑一条**（上面解释过）。
3. **`turn/end` 的失败判据**：`reason.kind` 是 `completed` / `max-tokens` 算 done；
   `aborted` / `interrupted` / `blocked` / `error` 算 failed（**不谎报完成**），
   已产出的正文仍会带回去。
4. **只认 `type === 'text'` 的正文**：`reasoning` 片段不当作结果
   （手机通道 2026-10-22 踩过，这里照抄修好的判据）。
5. **重启即中断**：插件启动时会把上一次遗留的 `running` 标成 `failed`
   （"桥在任务进行中重启/退出"），让小星知道要重投，而不是干等。
6. **不带鉴权**：总线是两个实例本机共享目录，任何能写 `_bridge/inbox` 的进程都能塞任务。
   只在本机可信环境下用。
