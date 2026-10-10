# dsh-message-edit

给 DSH 的**已发送用户消息**加上「撤回」和「编辑」。

现在 DSH 里排队中的消息能改能删，但一旦发出去（变成日志里的 `user/message`）就再也回不去了——
用户气泡上只有「复制」和「时间」。本插件补上两个按钮。

- **撤回**：这条消息及其之后的对话**从模型上下文里移除**，界面上那一段也隐藏。
- **编辑**：同样移除，然后把你改后的文本作为一条**全新的**用户消息发出去，
  于是模型看到的是「改后的文本 + 新回答」，界面上是一条气泡一个回答。

原始会话日志**不会删除**（append-only），被遮蔽的事件仍可用 `session-log-export` 之类的手段查到；
变的只是「派生出来的模型历史」和「当前对话视图」。

---

## 一、怎么用

1. 在用户气泡下出现「编辑 / 撤回」两个小按钮（鼠标悬停时更明显）。
2. **撤回** → 二次确认 → 该消息及其之后的整段被撤掉。
3. **编辑** → 气泡变成内联编辑框（`Ctrl+Enter` 保存，`Esc` 取消）→ 保存后自动重发。

限制：
- **会话空闲时才能操作**（当前轮次还在跑会被拒绝并提示）。运行中改写表面会打断 KV 前缀与步骤边界。
- 只能对**当前表面上的追加型用户消息**操作，不能动系统提示词（表面节点 0）。
- 撤回是「从这条起回退」，不是只删这一条——因为它之后的回答都是在回答它。

---

## 二、原理（为什么不改 DSH 本体就能做到）

### 1. 会话是 append-only 日志，模型历史是「表面投影」

`@deepseek-ai/dsh-session` 把每个模型可见事实记进只增日志，模型看到的历史由 `deriveMessages()` 从
**表面（surface）**投影得到。表面事件（`system/message` / `developer/message` / `user/message` /
`assistant/message` / `tool/result`）必须带 `surfaceOp`：

```ts
type SurfaceOp = 'append' | { op: 'replace'; startSeq: SessionSeq; endSeq: SessionSeq }
```

`replace` 把当前表面上 `[startSeq, endSeq]` 这一段**换成一条新事件**；旧事件仍留在日志里，
但不再出现在 `deriveMessages()` 里。**压缩（compaction）用的就是这个机制**——它用一条
`user/message` 摘要 checkpoint 遮蔽一整段。

本插件做的是同一件事，只是换成一条**空的 `system/message`**。为什么是它：

| 候选 | 结果 |
|---|---|
| 空 `user/message` | `deriveEventMessage()` 对 `user/message` **永远返回消息**（哪怕 content 为空）→ 模型会收到一条空用户消息 |
| `assistant/message` | 禁止携带 `sourceEventSeqs`，而替换事件**必须**带 → 用不了 |
| `developer/message` | 空 content 能投影成 null，但客户端会把它渲染成「注入上下文」一行 → 不干净 |
| **空 `system/message`** | ✅ 投影成 `null`（模型看不到）；客户端只「认领」不建节点（界面也不显示）；不覆盖节点 0 就不触发系统提示词保护 |

### 2. 替换的硬约束（源码 `dsh-session` 的 `planSurfaceEvent`）

- `startSeq` / `endSeq` 必须都还在**当前表面**上，且 start 在 end 之前、都比新事件早；
- `sourceEventSeqs` **必须覆盖每一个被遮蔽的表面节点**，只引用更早事件、不能重复；
- `tool/result` 的替换只能改 `content`；表面节点 0（系统提示词）只能被 `system/message` 一对一替换；
- **没有**「必须整轮 / 必须平衡」的要求——单条 `user/message` 起始的后缀替换是合法的。

### 3. 标记自己的替换事件

把空 `system/message` 的 `message.id` 写成 `dsh-recall:<uuid>`。
每个校验器只要求 `message.id` 是非空字符串（见 `assertMessageEventShape`），所以这是合法且可稳定识别的标记，
不需要任何额外状态（重启后从日志里重新扫出来即可）。

### 4. 客户端为什么还要额外做「隐藏」

客户端的对话记录是**原始日志视图**：表面替换本身不会让旧气泡消失（压缩也一样，只影响模型上下文）。
所以宿主半边的 `state` 路由会把「被遮蔽的轮次」算出来返回给客户端，客户端再隐藏那些轮次的行。

隐藏用的是**遮蔽 slot 渲染器**而不是改 DOM：wrap `conversation.chat.node` 的每一种 kind，
当 `node.location.turn.turn ∈ hiddenTurns` 时渲染 `null`——干净的 React 卸载，官方逻辑完全不受影响。

### 5. `user` 渲染器怎么加按钮而外观不变

`conversation.chat.node` 是 keyed slot，key `user` 已被官方占用，catalog 明说
「Registering an already-occupied key replaces that occupant」；slot core 的规则是
**同 key 不同 priority 共存、priority 最小者渲染**（官方是 0），所以注册 `priority: -1` 即遮蔽。

而 slot 渲染器把合并好的 props 作为**一个对象**传给组件，所以我们能拿到官方那条 entry 的
`component` 并原样转发：

```js
const Original = resolveOriginal('user')          // 从 ctx.slots.entries 里按 component 身份排除自己
return <div className="me-root">
  <Original {...props} />                          // 官方气泡，零改动
  <div className="me-actions">…编辑 / 撤回…</div>
</div>
```

---

## 三、HTTP 接口

与 `btw` / `sysmon` 同一套 `ctx.webServer` 约定（本地回环）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/message-edit-api/state?sessionId=` | `{ live, idle, hiddenTurns, ops, targets }` |
| POST | `/message-edit-api/apply` | `{ sessionId, seq, action:'retract'|'edit', text? }` |
| POST | `/message-edit-api/selftest` | 在**临时会话**（`prepare`，不进 store）上验证替换机制 |

`apply` 成功返回 `{ ok, cutSeq, startSeq, endSeq, shadowed, hiddenTurns, prompted, promptError? }`。
`prompted` 表示编辑后是否成功自动重发（`sessionController.prompt`）；失败会把原因放进 `promptError`，
此时历史已改写，需要手动发送。

`selftest` 不碰任何真实会话，用来回归核心机制：

```powershell
curl.exe -s -X POST http://127.0.0.1:19387/message-edit-api/selftest
```

---

## 四、配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `allowRunning` | `false` | 置 true 允许在轮次进行中替换。**不建议**：会打断 KV 前缀复用与步骤边界。 |

在 profile 的 `cordis.patch.yml` 里按 `id: message-edit` 覆盖即可。

---

## 五、已知限制

- 客户端的隐藏是**按轮次**的粗粒度：撤回一条消息会隐藏它所在轮次及其之后的所有轮次
  （这正是「从此处回退」的语义，但如果那一轮里有 steering 消息，会被一起隐藏）。
- 隐藏范围由宿主从日志算出；会话**不在内存里**（未 resume 的冷会话）时 `state` 返回 `live:false`，
  此时界面不会隐藏（点开会话后会重新拉取）。
- 撤回不可撤销（没有「恢复」按钮）。原始日志还在，但本插件不提供反遮蔽 UI。
- 不处理附件消息的图片编辑（只编辑文本块；附件原样保留在历史里）。
- `request/header` 的 `series` 快照依赖 agent loop 自己发现表面变化；连续操作之间若立刻发新消息，
  仍按 loop 的正常路径处理。

## 六、自检

```powershell
node selfcheck.cjs            # 语法 + 静态断言（不启动 DSH）
curl.exe -s -X POST http://127.0.0.1:19387/message-edit-api/selftest
```
