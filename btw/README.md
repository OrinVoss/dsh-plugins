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
| 看得到"到目前为止"，看不到正在写的那条回复 | chunk 事件不是 surface 节点，`deriveMessages()` 天然不含未完成的 assistant 消息 |
| 省 token | 复用同一份对话前缀（含 system 消息），命中提供方的 prompt cache |
| 不落盘 | 线程只存宿主内存（每会话最多 20 轮）+ 组件状态；不写 localStorage、不写会话日志 |
| 不打断主回合 | 与主回合的 signal、goal/todo/compaction、轨迹完全隔离 |

## 视觉对齐主会话

| 部位 | 做法 |
| --- | --- |
| 用户提问 | 主会话同款气泡：`--dsw-specific-bubble` + `--dsw-radius-xl` + `10px 16px`、右对齐、`max-width: min(--dsh-chat-content-width*.702, 88%)` |
| 思考 | 折叠行，规格照主会话 `ReasoningRow`：高度 `24px + font-delta`、标题「思考」+ 官方轨道字形、`2px` 圆点分隔符、次要字号摘要、流式时右侧渐隐 + 微光；点一下展开全文（`chevron` 旋转 180°） |
| 回答 | 轻量 Markdown：围栏代码（语言标签 + 复制）、行内代码、粗斜体、有序/无序列表、标题、引用；配色走 `--dsw-alias-markdown-*` |
| 输入区 | 复刻主 composer：`--dsw-specific-input-major` + `--dsw-radius-panel` + `--dsw-elevation-soft`，同款 34px 圆形主按钮（发送/停止） |
| 字号 | 跟随设置里的内容字号（`--dsh-content-font-size` / `--dsh-content-font-delta`），不写死 px |
| 图标 | 内联官方 primitives 的路径数据（发送/停止/清空/复制/勾/思考/箭头） |

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

## 踩过的三个坑（都已有回归测试）

1. **客户端插件不能 require app 内部的普通 ESM 库。**
   `@deepseek-ai/dsh-client-ui-primitives` 不是 `__ModuleLoader__` 模块（它被 app 自己打包进去），
   在 client.js 里 `require` 它会在加载期抛错，整个客户端半边失效、右侧栏只剩空壳。
   所以图标改为内联官方路径数据、Markdown 自带轻量实现。
2. **重放历史里的 assistant 消息必须带 `source`。**
   `ctx.llm.stream()` 的 `forAdapter()` 会对每条 `role: 'assistant'` 的消息读
   `message.source.replayState`；缺 `source` 直接抛
   `Cannot read properties of undefined (reading 'replayState')`，表现为第二问必炸。
   现在补 `{ kind: 'model', provider, model }`。
3. **模型会把工具调用写成文本**（DeepSeek 的 `<｜｜DSML｜｜ …>`、`<tool_call>`）。
   宿主重放前先剥掉（否则诱导它继续乱写），客户端渲染时也剥，并补一句
   "旁支提问没有工具，上面的工具调用没有被执行"；流式中未闭合的开标记一直吃到结尾。

## 生态里已有的同类插件（2026-10 查证）

- **npm/`dsh-btw`（iluluyu）** — <https://www.npmjs.com/package/dsh-btw> · <https://github.com/iluluyu/dsh-btw>
  `/btw` 答案显示在**输入框上方的临时面板**（Esc 关闭），另有一个**右上角「临时聊天」**入口
  （无父上下文、不落盘、关闭即焚）。README 的装法是 `dsh plugin --profile web add dsh-btw`，面向 web profile。
- **MichengAI/dsh-btw** — 一次性只读旁问，独立气泡，不执行工具。
- **WLV-ZEDD/dsh-btw** — Side-Assistant Dock & Drawer。
- 插件索引：[Sakana-yuyu/dsh-plugins](https://github.com/Sakana-yuyu/dsh-plugins)（topic:dsh-plugin，按 stars）、
  [SihanTeng/awesome-deepseek-harness-plugins](https://github.com/SihanTeng/awesome-deepseek-harness-plugins)、
  [bradeGithub/DSH-Plugins-Marketplace](https://github.com/bradeGithub/DSH-Plugins-Marketplace)。

与社区版的差别：本插件的入口是**右侧栏「开始」页的卡片**、面板内**支持多轮追问与折叠思考行**，
并按运行中的 desktop profile（0.2.0-rc.2）实测；社区版多了"临时聊天"。

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
