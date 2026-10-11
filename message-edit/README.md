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

1. 用户气泡的**原生操作行**里多两个图标按钮，排在复制键右边（就是官方 `MessageIconActions`
   的 `extraActions` 位置与几何）：✏️ 编辑、↩ 撤回。
2. **撤回** → 二次确认 → 该消息及其之后的整段被撤掉。
3. **编辑** → 气泡**原地**变成编辑态：**白底 + 蓝描线**，尺寸位置与原气泡一致，
   上面的图片/附件/引用摘要一个都不丢；`Enter` 保存并重发、`Shift+Enter` 换行、`Esc` 取消。

限制：
- **会话空闲时才能操作**（当前轮次还在跑会被拒绝并提示）。运行中改写表面会打断 KV 前缀与步骤边界。
- 只能对**当前表面上的追加型用户消息**操作，不能动系统提示词（表面节点 0）。
- 撤回是「从这条起回退」，不是只删这一条——因为它之后的回答都是在回答它。

### 编辑态的视觉与动效

- **无缝**：编辑时官方消息本体照常渲染（所以附件不丢），编辑器按**实测**的原气泡盒子
  `top/left/宽/最小高` 原位覆盖上去。字号、行高、内容盒内边距（10px 16px）与气泡逐项对齐，
  所以文字在编辑前后**一个像素都不动**。
- **盒子必须严格等于气泡**（2026-10-10 真机反馈修）：`✓/✕` 那一行**不放进盒子**，而是
  `position:absolute;top:calc(100% + 4px)` 贴到盒子下方（就是官方操作行那一行，编辑态下把
  官方操作行 `visibility:hidden` 让位）。早先把它们放进 flex 流里，盒子就永远比气泡高一行
  （= 一行按钮 + gap），用户看到的就是"编辑框没贴合气泡、底部多悬出一条"。
  同时去掉 `.me-editor` 上的 `max-width` 上限——宽度以实测值为准，避免 CSS 上限（用的是
  `--dsh-chat-content-width` 的兜底值）把盒子压窄。继续打字时盒子向下长，✓/✕ 跟着往下走。
- **进场过渡**：160ms 的关键帧把底色从气泡蓝渐变到白、描线从透明渐显为蓝环；✓/× 再延后 70ms 淡入。
- **退场过渡**：点 ×（或 `Esc`）不会立刻卸载编辑器，而是先置 `closing` 播 150ms 的**反向**关键帧
  （白底 + 蓝环 → 气泡蓝、描线消失），播完再 `setEditing(false)`。
  因为官方气泡全程都在编辑器底下，反向动画的终态就是气泡本身，所以收尾**零跳变**；
  关闭期间 `pointer-events:none` 并锁掉按键，避免重复触发。
- 两段都刻意**不做透明度/缩放**——那会让文字发虚或位移；`prefers-reduced-motion: reduce` 时全部关闭。
- 图标全部是官方路径数据内联（客户端插件不能 require app 内部 ESM 库）；
  「撤回」用的是**掉头箭头**（官方图标集里没有撤销箭头，按用户给的参考形自绘，
  但沿用官方那套 viewBox 16 / stroke 1 / currentColor 约定）。

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

本插件做的是同一件事，用一条**遮蔽节点**（`user/message`）把 `[目标 … 末尾]` 换掉。

#### ⚠️ 为什么遮蔽节点必须是 `user/message`（2026-10-10 修正）

format v4 把事件分成两类（源码 `dsh-session-format-v3-to-v4` 的 `Relationships`）：

```ts
const STEP_EVENT_TYPES = new Set(['system/message', 'developer/message', 'assistant/attempt'])
```

这三类事件的 `data.turn` / `data.step` **必须等于写入那一刻打开的 turn+step**，否则整条日志在
**下一次加载**时抛 `SessionFormatError: <type> does not match an open turn and step`，会话直接打不开
（`session.append()` 只做事件自身校验、不做关系校验，所以**写的时候不报错**，坑在下次加载）。

撤回/编辑发生在**空闲**（两轮之间）时没有任何打开的 step。旧版用的「空 content 的 `system/message`」
正好踩中这条，2026-10-08～10-10 写坏了 3 条会话（已用 `_sessdiag/repair_logs.py` 挪进打开的 step 修好，
原文件备份为 `session.v4.jsonl.zstd.repair-bak-20261010`）。

各候选的结论：

| 候选 | 结果 |
|---|---|
| `system/message` / `developer/message` / `assistant/attempt` | ❌ step 作用域事件，空闲位置非法（旧版的 bug 就在这里） |
| `assistant/message` / `tool/result` | ❌ 同样要求打开的 step（`assistant/message` 还禁止带 `sourceEventSeqs`） |
| 自定义新事件类型 + message projection | ❌ `validateStoredEvents()` 拒绝未知事件类型；projection 只对内核名单里的 `image/offload` 开放，插件**无法**注册新类型 |
| **`user/message`** | ✅ 唯一的非 step 表面类型，任何位置都能带 `surfaceOp:replace` |

代价：`deriveEventMessage()` 对 `user/message` **一定会返回消息本身**（`image/offload` 靠 projection 才能改写，
插件用不了），所以遮蔽节点的 content 写一行占位文本 `RECALL_TEXT`：

- 撤回 → 「（用户撤回了一段对话，其中内容已不再可见，请不要再引用它。）」
- 编辑 → 「（用户撤回并改写了下面这条消息。）」

DSH 自己的压缩同样是留一条**模型可见**的 checkpoint 消息，所以这是与内核一致的取舍。

### 2. 替换的硬约束（源码 `dsh-session` 的 `planSurfaceEvent`）

- `startSeq` / `endSeq` 必须都还在**当前表面**上，且 start 在 end 之前、都比新事件早；
- `sourceEventSeqs` **必须覆盖每一个被遮蔽的表面节点**，只引用更早事件、不能重复；
- `tool/result` 的替换只能改 `content`；表面节点 0（系统提示词）只能被 `system/message` 一对一替换；
- **没有**「必须整轮 / 必须平衡」的要求——单条 `user/message` 起始的后缀替换是合法的。

### 3. 标记自己的替换事件 + 日志自检

`message.id` 写成 `dsh-recall:<uuid>`、`source.kind` 写成 `message-edit`
（两者都是格式允许的取值），合法且可稳定识别，不需要额外状态（重启后从日志里重新扫出来即可）。
`isRecallCut()` 仍识别旧日志里那种空 `system/message` 遮蔽事件，隐藏逻辑对历史会话照常生效。

宿主还带一个日志自检 `stepScopeViolations()`，专门盯上面那条不变量：

- `POST /message-edit-api/apply` 的返回值带 `logProblems`（空数组 = 合法）；
- `POST /message-edit-api/selftest` 既验证新写法写完仍然合法（`log-legal`），
  也**反向**构造旧版那种非法日志，要求检查器必须抓到（`detector-catches-old-bug`）——
  否则旧 bug 会静默复活。

### 4. 客户端为什么还要额外做「隐藏」

客户端的对话记录是**原始日志视图**：表面替换本身不会让旧气泡消失（压缩也一样，只影响模型上下文）。
所以宿主半边的 `state` 路由会把「被遮蔽的轮次」算出来返回给客户端，客户端再隐藏那些轮次的行。

隐藏用的是**遮蔽 slot 渲染器**而不是改 DOM：wrap `conversation.chat.node` 的每一种 kind，
当 `node.location.turn.turn ∈ hiddenTurns` 时渲染 `null`——干净的 React 卸载，官方逻辑完全不受影响。
（当前实现按行过滤：给 `[data-chat-flow-key]` 行打 `data-msg-edit-hidden` 再 `display:none`，
并在 DOM 变化后重放。）

#### ⚠️ 例外：遮蔽节点本身必须可见（2026-10-11 修正）

隐藏是**按轮次**的，而遮蔽节点和被它遮蔽的消息**同属一轮**，所以占位节点一开始被一起藏掉了：
用户只看到"这一段凭空消失"，看不到"这里被撤回了"。用户原话："每一轮上下文都有三次注入
（AGENTS.md / runtime-context / time-context），怎么撤回之后没有注入这一条？"

正解是**让官方自己渲染这一行**。官方 Chat 对 `user/message` 里 `source.kind !== 'user'` 的一律
渲染 `ContextInjectionRow`（就是那三条「上下文」注入行的实现）：

| 位置 | 取值 |
|---|---|
| 折叠标题 | locale `message.contextInjection`（「上下文」） |
| 折叠摘要 | `source.summary`，**只对 `form: 'notice'` 生效**（官方 `noticeSummary()`） |
| 展开正文 | 模型看到的那串 content（`ModelFacingContent`） |
| producer 标签 | `source.kind`（本项目里是 `message-edit`） |

所以遮蔽节点的 source 写成 `{ kind: 'message-edit', form: 'notice', summary: RECALL_NOTICE[action] }`，
客户端只做两件事：

1. 被遮蔽的轮次照常隐藏，但**豁免这一行**——按官方注入行的 `[data-context-source]` 文本（=kind）
   或我们自己的 `data-me-mask` 标记识别；
2. 对这一行不加编辑/撤回按钮（用 `display:contents` 包一层，官方 DOM 结构不变）。

官方 `KNOWN_FORMS = ["instructions", "catalog", "snapshot", "notice", "relay", "recall"]`：
不写 `form` 会退化成"opaque"原始文本，写 `notice` + `summary` 才能在折叠状态下读到人话。

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

⚠️ **包装层必须是普通块（`position:relative;display:block;width:100%`），不能是 flex。**
官方 `.userStack` 的 `max-width: min(calc(--dsh-chat-content-width * .702), 82%)` 里那 82%
是相对 `.userRow` 的宽度算的；一旦把 `.userRow` 放进 `display:flex;align-items:flex-end` 的
包装层，它就收缩到内容宽，82% 的基准随之变小——**同一句话会比原生更早换行**
（2026-10-11 用户截图：同一条消息一条一行、一条两行）。我们的按钮、编辑框、确认气泡全是
绝对定位，包装层不需要 flex。

---

### 6. 撤回确认气泡：贴着消息行内的小弹层，不用 `window.confirm`

早期版本用 `window.confirm()`，弹出来的是**操作系统对话框**，与 DSH 的视觉语言完全无关。

**第一版改成挂在 `document.body` 的全屏 Mask + Dialog，结果真机上按钮点不动**（2026-10-10 反馈：
"取消不了，撤回也撤回不了，界面没有任何变化"）：DSH 应用自身有一层全窗口 overlay，
`body` 级的固定层会被它压住——视觉上能看到（所以看着像弹出来了），但**收不到点击**，
而且全屏遮罩把整个界面挡住了。

现在的做法是**把气泡挂进消息行**（`.me-root` 的子元素，React 渲染，`confirming` 状态控制）：

- **在应用 DOM 树里**：不会被任何 overlay 压住，点击必然生效；不遮挡界面，点外面或按 `Esc` 就关。
- **视觉**：抄官方弹层/菜单取值 `--dsw-menu-surface-fill` + `--dsw-menu-backdrop-filter` +
  `--dsw-radius-lg` + `--dsw-elevation-panel`；进入动画只有 `opacity`（官方 `modalEnter` 就是这样）；
  `prefers-reduced-motion` 下关闭。
- **按钮**：抄官方 Button 原子的 `.sm` 尺寸（28px 高 / 12px 字号 / `--dsw-radius-sm` / `padding:0 10px`），
  主按钮 `--dsw-alias-button-primary-fill`+`-hover`，次按钮 ghost 用 `--dsw-alias-interactive-bg-hover`+`-active`。
- **位置**：`position:absolute; right:0; top:calc(100% + 6px)`——就在这条消息下面、右对齐；
  开着时给 `.me-root` 加 `data-confirming="1"`（`z-index:30`）压过后续行。
- **行为**：`Enter` 确认、`Esc` 取消、点气泡外面取消、初始焦点在主按钮上（均在捕获阶段拦按键，
  避免官方组件在同一按键上另有动作）；确认后才走 `/apply`，`busy` 期间撤回键禁用。
- **方向**：默认在消息下面；打开时实测可用空间，**下面被输入框占住就翻到消息上方**
  （`.me-confirm[data-placement="above"]{top:auto;bottom:calc(100% + 6px)}`）。
  ⚠️ 坑 1（真机踩到）：对话流的滚动容器**一直延伸到窗口底边**，输入框是浮在它上面的——
  边界必须取**输入框顶边**（"页面里最靠下的输入控件"就是它），否则"下方空间"永远算成够用，
  最后一条消息的气泡会被输入框盖掉半截。
  ⚠️ 坑 2：**不要给 `.me-root` 抬 z-index**。曾经为了让气泡压过输入框而给整行加
  `z-index:30`，结果连消息本体（蓝色气泡）也被抬到输入框上面，看起来像气泡钻进了输入框。
  翻转已经保证气泡不会和输入框重叠，层级只需留给气泡自己（`z-index:1`，足以盖住后面
  那些 DOM 靠后但没有定位层级的行）。

## 三、HTTP 接口

与 `btw` / `sysmon` 同一套 `ctx.webServer` 约定（本地回环，仅本机可访问）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/message-edit-api/state?sessionId=` | `{ live, idle, hiddenTurns, ops, targets, clientErrors, recentOps, liveSessions }` |
| POST | `/message-edit-api/apply` | `{ sessionId, seq, action:'retract'|'edit', text? }` |
| POST | `/message-edit-api/selftest` | 在**临时会话**（`prepare`，不进 store）上验证替换机制 |
| POST | `/message-edit-api/client-error` | 客户端渲染错误上报（诊断通道） |
| POST | `/message-edit-api/debug/prompt` | **仅诊断**：单独试 `sessionController.prompt`，返回逐次尝试的错误 |

`apply` 成功返回 `{ ok, cutSeq, startSeq, endSeq, shadowed, hiddenTurns, prompted, promptError? }`。
`prompted` 表示编辑后是否成功自动重发（`sessionController.prompt`）；失败会把原因放进 `promptError`，
此时历史已改写，需要手动发送。

`selftest` 不碰任何真实会话，用来回归核心机制：

```powershell
curl.exe -s -X POST http://127.0.0.1:19387/message-edit-api/selftest
```

---

## 四、真机实测攒下的五个硬坑

这几条是踩完才写下来的，改这个插件时**一个字都别省**：

1. **slot core 把 `locale` / `inject` / `children` 存在 entry 本身，不在 `entry.options` 里。**
   只有 `key` / `id` / `order` / `label` / `priority` 进 `options`。读错地方 → 复制不到 `locale` 与 `inject`。
2. **遮蔽条必须复制官方条目的 `locale` 与 `inject`。**
   `kit.t` 只在条目声明了 `locale` 时注入，`inject` 提供的 props（如 `useHostInfo`）同理。
   不复制 → 官方组件在渲染时抛 `t is not a function` / `useHostInfo is not a function`，
   slot 会把我们的条目**让位（abdicated）**，表现为「按钮根本没出现」而界面一切正常。
3. **找官方条目要按 `priority === 0`，不能只按 component 身份排除自己。**
   客户端热更后，上一次注册的遮蔽条可能还留在账本里，会被误认成「官方条目」。
   遮蔽优先级因此取 `-999`，压过历史遗留的 `-1`。
   `-999` 压过官方 `0` 这件事由官方 Slots inspect 实证：遮蔽生效时
   `key=user priority=-999 active=true`、官方那条 `priority=0 active=false`。
4. **官方条目可能比我们晚进账本：拿不到就绝不注册（2026-10-11 重启后实测）。**
   重启桌面端后我们的客户端半边**先于** `mirror` 里的 ui-chat 半边执行，`apply` 时
   `ctx.slots.entries` 是空的（`captured=0 officialUser=none`）。老逻辑照样注册 →
   遮蔽条没有复制官方 `locale` → 官方组件抛错 → 条目被让位，界面一切正常但**按钮不出现**，
   看起来就是"插件没启动成功"。
   修法：`tryRegisterUser()` 里 `official === undefined` 时**直接 return false 不注册**，
   槽位服务没有 entries 变更订阅可用，所以短轮询（150ms × ≤100 次 ≈ 15s）等官方条目出现再注册；
   注册成功补一条 `ready-late` 报告，`GET /message-edit-api/state` 里能直接看到
   `registered user shadow after N retries; officialLocale=chat`。
5. **`sessionController.prompt(request, signal)` 的 signal 必须是真的 `AbortSignal`。**
   内部会调 `signal.throwIfAborted()`，传 `undefined` 会抛
   `Cannot read properties of undefined (reading 'throwIfAborted')`。
   这个坑的破坏性最大：替换已经落盘、重发却失败 → 对话被清空且没有新回答。
   修法是 `AbortSignal.timeout(60_000)`；失败时 `promptError` 会回给界面。

另外两条设计约束：
- 不要用「wrap 每一种 chat node 渲染器」来隐藏行：官方 `tool-call` / `turn-tail` / `command`
  自己声明了 children slot，而同一个 child slot 不能声明两次；不声明就拿不到官方 kit 里的
  `renderSlot`，转发 props 后官方组件会崩。改为按 `data-chat-turn` 做作用域内的行过滤。
- 官方 `user` 气泡的操作行只传了 `text/time`，所以 `MessageIconActions` 支持的
  `extraActions` 用不上。但可以**给原生操作行加 `padding-right` 把复制键挤左、再把自己等宽的
  图标钮绝对定位补进腾出的空位**，位置与几何就等于官方 `extraActions`（选择器用 `[data-clock="start"]`，
  别依赖哈希类名）。

后两条是 UI 复核时用户提的，踩了才知道：
- **编辑态不能整块替换官方消息本体**：官方用户消息的 DOM 是
  `.userRow > .userStack > [附件行][文字气泡][引用摘要]` 加行尾的操作行；只渲染自己的编辑框会把
  上面的图片/文件卡一起吞掉（用户原话：「如果之前上面有个图片的话，那就没有了」）。
  正解是**保留本体 + 编辑框原位覆盖**。
- **气泡是 shrink-to-fit 的**：`.userStack` 限宽、气泡按内容收缩，所以编辑框的盒子必须
  **实测**（`getBoundingClientRect` 相对 `.me-root` 求 top/left/宽/高），不能靠 `max-width` 猜。
  找气泡元素也别用哈希类名：附件行与引用摘要背景透明、只有 `.bubble` 有填充色，按这个筛就稳。

---

## 五、配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `allowRunning` | `false` | 置 true 允许在轮次进行中替换。**不建议**：会打断 KV 前缀复用与步骤边界。 |

在 profile 的 `cordis.patch.yml` 里按 `id: message-edit` 覆盖即可。

本包是**拓展包（`dsh-style-extras`）组合包的成员**：加载行由 style-extras 的
`cordis.patch.yml` 声明（`insert id: message-edit`），profile 的 `dsh.profile.bundles` 里
列的是 `dsh-style-extras`，本包自己不带 `dsh.bundle`。

---

## 六、已知限制

- 客户端的隐藏是**按轮次**的粗粒度：撤回一条消息会隐藏它所在轮次及其之后的所有轮次
  （这正是「从此处回退」的语义，但如果那一轮里有 steering 消息，会被一起隐藏）。
- 隐藏范围由宿主从日志算出；会话**不在内存里**（未 resume 的冷会话）时 `state` 返回 `live:false`，
  此时界面不会隐藏（点开会话后会重新拉取）。
- 撤回不可撤销（没有「恢复」按钮）。原始日志还在，但本插件不提供反遮蔽 UI。
- 不处理附件消息的图片编辑（只编辑文本块；附件原样保留在历史里）。
- **编辑失败时历史已被改写**：`promptError` 只会以提示条告知，不会回滚（日志是 append-only，无法回滚）。
- `request/header` 的 `series` 快照依赖 agent loop 自己发现表面变化；连续操作之间若立刻发新消息，
  仍按 loop 的正常路径处理。
- `/message-edit-api/debug/prompt` 是无鉴权的本地诊断路由（和 `apply` 一样只监听回环）；
  不需要时删掉这个 `ctx.effect` 即可。

## 七、自检

```powershell
node selfcheck.cjs            # 语法 + 静态断言（不启动 DSH）
node selftest.cjs 19387       # 打运行中的桌面端：路由可达 + 机制自检
```

