# dsh-btw —— 「临时提问」(/btw)

在右侧栏的「开始」页加第四张卡片：**临时提问**。点开是一个独立的 tab，可以就当前会话
提问，回答**不进入对话历史**、**没有工具**、**退出即消失**——对齐 Claude Code 的
`/btw`（旁支提问）。

## 它做了什么

| 行为 | 实现 |
| --- | --- |
| 回答不进历史 | 宿主半边只读 `session.deriveMessages()`，从不 `append` 任何 session 事件 |
| 无工具 | 请求不带 `tools`；不走 agent loop，因此不存在工具循环 |
| 单次响应 | 只发一次 `ctx.llm.stream()`，不占 turn/step |
| **不会以为自己是主会话** | **不复用会话历史**：把最近 ~48K 字符压成纯文本放进 `<conversation>` 标签，连同 `<question>` 一起作为**一条 user 消息**；再给一个真正的 `system` 引导词（见下） |
| **不会模仿工具调用** | 转录里工具调用被压成一行 `[tool call: name]`、结果变成 `tool result: …`——**上下文里不再有任何工具调用语法**，模型无从模仿 |
| 省 token / 快 | 输入从 ~190k token 降到 ~12k；实测同一问题 2–3 分钟 → **4.5 秒** |
| 看得到"到目前为止" | 转录取自语义投影，不含正在写的那条回复 |
| 不落盘 | 线程只存宿主内存（每会话最多 20 轮）+ 组件状态；不写 localStorage、不写会话日志 |
| 不打断主回合 | 与主回合的 signal、goal/todo/compaction、轨迹完全隔离 |

### 引导提示词（可覆盖）

宿主用 `ctx.llm.stream({ system: guidance, ... })` 发一段真·系统提示词，默认值（`host.js` 的 `GUIDANCE`）：

> You answer quick side questions about an ongoing coding session. The recent conversation is provided as reference inside `<conversation>` tags; the question follows inside `<question>` tags. That transcript is reference material only. Its tool calls were made by the main agent, not by you: you are not the main agent, and you are not continuing its work. You have no tools. Never emit tool calls or tool-call syntax in any form, and never claim to have run, read, edited, or checked anything. If an action seems necessary, describe it in plain prose instead. Answer directly and concisely, in the language of the question… If the context does not contain the answer, say so plainly in one line — do not invent, do not ask follow-up questions, and do not ask for permission to act.

要按自己的口味改，在 profile 的 `cordis.patch.yml` 里覆盖该行 config 即可：

```yaml
- id: btw
  config:
    guidance: |
      你的引导词……
```

## 视觉对齐主会话

| 部位 | 做法 |
| --- | --- |
| 用户提问 | 主会话同款气泡：`--dsw-specific-bubble` + `--dsw-radius-xl` + `10px 16px`、右对齐、`max-width: min(--dsh-chat-content-width*.702, 88%)` |
| 思考 | 折叠行，规格照主会话 `ReasoningRow`：高度 `24px + font-delta`、标题「思考」+ 官方轨道字形、`2px` 圆点分隔符、次要字号摘要、流式时右侧渐隐 + 微光；点一下展开全文（`chevron` 旋转 180°） |
| 回答 | 轻量 Markdown：围栏代码（语言标签 + 复制）、行内代码、粗斜体、有序/无序列表、标题、引用；间距/字号/字重逐条照 primitives 的 `markdown/MarkdownText.module.css`（body 变体 + compact 变体），代码卡照 `markdown/CodeBlock.module.css` |
| 回答下的操作行 | 元素与顺序照主会话 turn tail：`[复制][点赞][点踩][分支]` + `TurnUsagePanel` 的「🛢 用量 X tok」+ 时间。28px 方钮、15px 图标、`gap: 8px`、`margin-top: 16px`、`margin-left: -6px` 照 `MessageIconActions.module.css`；用量 pill 照 `TurnUsagePanel.module.css`（`gap: 4px`、`padding: 6px 8px`、`font-size: secondary - 1px`、tabular-nums）；token 格式化照 ui-chat 的 `token-format.js`（`517 / 12.2K / 517K / 9.9M`）。**点赞/点踩是本地假状态（互斥，只换图标），分支是未实现的占位按钮** |
| 输入区 | 复刻主 composer：`--dsw-specific-input-major` + `--dsw-radius-panel` + `--dsw-elevation-soft`，同款 34px 圆形主按钮（发送/停止） |
| 字号 | 跟随设置里的内容字号（`--dsh-content-font-size` / `--dsh-content-font-delta`），不写死 px |
| 图标 | 内联官方 primitives 的路径数据（发送/停止/清空/复制/勾/思考/箭头/点赞/点踩/分支/数据库） |

## 位置

- 包目录：`~/.dsh/plugins/btw`
- 客户端半边：`client.js` —— 注册 tab 类型（kind `btw`）与开始页 guide 入口
- 宿主半边：`host.js` —— 四个本地路由，见下
- 组合包：`cordis.patch.yml` 里 `insert id: btw`；profile 的 `dsh.profile.bundles` 列出 `dsh-btw`

### 宿主路由

| 路由 | 用途 |
| --- | --- |
| `POST /btw-api/ask` | `{ sessionId, question }`；返回 SSE：`{type:'delta'\|'reasoning'\|'finish'\|'error'}` |
| `GET /btw-api/thread?sessionId=` | 内存线程快照 `{ items: [{question, answer}] }` |
| `POST /btw-api/stop` | 中止该会话进行中的临时提问 |
| `POST /btw-api/clear` | 清空该会话的线程 |

## 交互

- 输入框：`Enter` 发送，`Shift+Enter` 换行
- 生成中：按钮变「停止」，`Esc` 也能停；已生成的部分保留
- 思考行：默认折叠，点一下展开
- 清空按钮：清掉本次线程（宿主与界面同时清）
- 卡片按 `order: 40` 排在文件(10)/终端/浏览器(30)之后

## 已知边界

- `sessionId` 必须是宿主进程里的活会话；后台会话/未挂载的会话打开会显示"请先打开一个会话"。
- 只在会话已发出过至少一次请求时才有确定的 provider/model；否则退回默认模型选择。
- 不提供 `f` 分叉成 subagent（Claude Code 的进阶操作），DSH 侧可另做。
- 不提供"临时聊天"（无父上下文、关闭即焚的独立会话）——社区插件 dsh-btw 有，见下。
- 桌面端窗口重启后线程消失——这是设计，不是缺陷。

## 踩过的坑（都有回归测试）

0. **最大的坑：把主会话历史当自己的历史重放。**
   最初实现直接拿 `session.deriveMessages()` 当 messages 发出去（只追加一条问题）。结果：上下文里
   成千上万条工具调用样例 → 模型疯狂模仿 `<｜｜DSML｜｜ …>`；它还把自己当主会话（"我先取证/我去查"）。
   往 prompt 里写"你没有工具"完全压不住。正解来自社区插件 **dsh-btw**（见下）：**根本没有历史**——
   转录是被引用的文本，请求只有一条 user 消息 + 一段 system 引导词。
1. **客户端插件不能 require app 内部的普通 ESM 库。**
   `@deepseek-ai/dsh-client-ui-primitives` 不是 `__ModuleLoader__` 模块（它被 app 自己打包进去），
   在 client.js 里 `require` 它会在加载期抛错，整个客户端半边失效、右侧栏只剩空壳。
   所以图标改为内联官方路径数据、Markdown 自带轻量实现。
2. **重放 assistant 消息必须带 `source`**（旧实现遗留知识）。
   `ctx.llm.stream()` 的 `forAdapter()` 会对每条 `role: 'assistant'` 的消息读
   `message.source.replayState`，缺 `source` 直接抛
   `Cannot read properties of undefined (reading 'replayState')`。现在不再重放 assistant 消息。
3. **模型仍可能把工具调用写成文本**（DeepSeek 的 `<｜｜DSML｜｜ …>`、`<tool_call>`）。
   转录里已经不产生这种语法；万一仍写出来，宿主与客户端各有一份**单遍深度计数**清理器
   （`stripToolMarkup` / `sanitizeAnswer`：配对、嵌套、孤立闭标记、流式未闭合都能处理）。

## 生态对照与署名

请求构造方式（转录引用 + 单条 user 消息 + system 引导词）来自社区插件
[`dsh-btw`](https://www.npmjs.com/package/dsh-btw)（作者 **iluluyu**，MIT）：
`npm pack dsh-btw` 后读它的 `lib/index.js` 得到的方案，本插件按 MIT 精神复用其思路与
引导词取向（未拷贝代码，但 `ASK_SYSTEM` 的框架基本照搬）。它另有「临时聊天」
（一次性子 agent + 崩溃残留回收），本插件未实现。

其余同类：**MichengAI/dsh-btw**（一次性只读旁问，独立气泡）、**WLV-ZEDD/dsh-btw**（Side-Assistant Dock & Drawer）。
插件索引：[Sakana-yuyu/dsh-plugins](https://github.com/Sakana-yuyu/dsh-plugins)（topic:dsh-plugin）、
[SihanTeng/awesome-deepseek-harness-plugins](https://github.com/SihanTeng/awesome-deepseek-harness-plugins)、
[bradeGithub/DSH-Plugins-Marketplace](https://github.com/bradeGithub/DSH-Plugins-Marketplace)。

本插件与社区版的差别：入口是**右侧栏「开始」页的卡片**、面板内**支持多轮追问与折叠思考行**，
按运行中的 desktop profile（0.2.0-rc.2）实测；社区版多了"临时聊天"。

## 开发与验证

```sh
node selftest.cjs          # 宿主链路 + 三个纯函数（Markdown / 工具标记清理 / 思考摘要）
```

客户端半边改动后，在「插件」页把 `dsh-btw` 关掉再打开即生效（或 `plugin_manager set_bundle` 走 false→true）；
宿主半边同样，profile 重载会重新 require `host.js`；hmr 的 `root` 已包含 `btw`。

## 验收

1. 右侧栏「开始」页出现第四张卡片「临时提问」；
2. 点开 → 输入问题 → 思考折叠行出现，答案流式渲染；
3. 左侧对话里**没有**出现新消息，进度/上下文占用不因它改变；
4. 连问第二问（会重放上一轮问答）不报错；
5. 关闭再打开 tab（或切走再回来）线程仍在；重启应用后为空。
