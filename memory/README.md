# dsh-memory

给 DSH 补上**长期记忆**：一个跨会话、跨工作区、人可读可手改的记忆库，外加四个让模型自己读写记忆的工具。

设计直接移植自 Z code 的 `~/.zcode/global-memory/`：**索引文件 + 分主题 Markdown + frontmatter 元数据 + 全局/项目两层作用域**，靠 `$DSH_HOME/AGENTS.md` 里的一段托管区块自动进入每次会话的上下文。

---

## 1. 它解决什么

DSH 原本没有记忆功能：会话日志只是历史记录，`AGENTS.md` 只能读不能记，`storage-domain` 模型看不见。这个插件补上三件事：

| 缺口 | 本插件的做法 |
|---|---|
| 模型没有「记」的手段 | `memory_write`：自动生成 frontmatter、写正文、并把摘要挂进索引 |
| 记忆进不了上下文 | 在 `$DSH_HOME/AGENTS.md` 里维护一段托管区块，把全局索引直接放进全局指令（`dsh-agent-instructions` 每次会话自动加载它） |
| 记了找不到 | `memory_search` 按关键词检索索引摘要 + 正文全文，直接返回条目正文 |

## 2. 磁盘布局

```
<DSH_HOME>/memory/                     记忆根（默认 ~/.dsh/memory）
├── INDEX.md                           全局索引：## 分组 + 「- [标题](路径) — 摘要」
├── user-identity.md                   根级条目
├── preferences/…                      按主题分子目录，与 Z code 完全一致
├── tools/…
└── projects/<工作区键>/                项目级记忆（只对某个 cwd 成立）
    ├── MEMORY.md                      项目索引
    └── <条目>.md
```

工作区键 = `<目录名 slug>-<规范化 cwd 的 sha1 前 16 位>`。

规则细节（与 Z code 的 `projects/<slug>-<hash>` **同一套规则**，但哈希随路径而变，不是同一个值）：
`path.resolve(cwd)` → 反斜杠转 `/` → 去掉尾部 `/` → **转小写** → sha1 → 取前 16 位十六进制；
slug 由目录名小写、非 `[a-z0-9\u4e00-\u9fa5._-]` 的字符一律换成 `-` 得到。

本机实例：本工作区 `D:\桌面\编程作品\马具对比\DeepSeek Harness` → `deepseek-harness-e9b7a1e936a10df7`
（`~/.dsh/memory/projects/` 下另有两个：`测试-aed73870c10edae0`、`ai教学-36df60ec49a8de76`）。
想知道某个目录的键，直接调 `store.projectKey(cwd)`，别手算。

条目文件格式（与 Z code 相同，可双向互认）：

```markdown
---
name: tools/dsh-desktop-app
description: DSH 桌面端在 F:\dsh，插件隔离在 profiles/desktop
metadata:
  node_type: memory
  type: reference
  scope: global
  originSessionId: sess_xxx
  createdAt: 2026-09-30T12:00:00.000Z
  updatedAt: 2026-09-30T12:00:00.000Z
---

事实……

**Why:** 为什么这条值得记。

**How to apply:** 具体怎么做。可用 [[machine-env-and-network]] 互链。
```

## 3. 模型拿到的四个工具

| 工具 | 作用 |
|---|---|
| `memory_write` | 写一条记忆：`scope`（global/project）、`name`（slug，可含 `/`）、`description`（索引那行摘要）、`body`、可选 `title`/`type`/`section`/`overwrite`。条目已存在时**默认拒绝**，必须显式 `overwrite: true` 才整条替换。**覆盖时不传 `section` 会沿用索引里现有的分组**（只有全新条目才回退到 name 首段目录）；传了则把条目搬到该分组。 |
| `memory_search` | 关键词检索，**直接返回命中条目正文**；`query` 省略则返回索引。默认 `scope: auto` = 先当前工作区、再全局。 |
| `memory_read` | 按名字精确读全文（名字就是索引里的路径，`.md` 可省）。 |
| `memory_forget` | 删除条目并同步摘掉索引。 |

写入成功后插件会立刻重写 `AGENTS.md` 的托管区块，所以**下一个会话**（以及刷新后的当前会话）就能看到新索引。

## 4. 设置页（记忆管理界面）

DSH 的「设置」里会多出一页 **记忆**（排在「智能体预设」之后）。这一页是插件的浏览器半边（`client.js`），注册进宿主声明的 `settings.section` 插槽。

能做什么：

- **看**：按索引分组列出全部条目（标题 / 摘要 / 路径），顶部状态条显示记忆根、全局条目数、注入区块字节、项目库数量。
- **搜**：一个过滤框，按标题、摘要、路径实时筛。
- **改**：点任意条目进入编辑器 —— 标题、描述、类型、索引分组、正文；保存时整条替换（`overwrite: true`）。
- **建**：`新建条目`，填 name / 描述 / 正文即可，插件负责生成 frontmatter 并把摘要挂进索引。
- **删**：编辑器里的「删除」，同时摘掉索引条目。
- **切作用域**：全局记忆 ↔ 各工作区记忆（工作区下拉列出 `projects/` 下的所有库）。
- **重新同步 AGENTS.md**：手工改过 `INDEX.md` 之后点一下，把托管区块重新写一遍。

实现方式与 `dsh-sysmon` 相同：宿主注册 `/memory-api/*` 只读/只写路由，页面用 `fetch` 调用；所有写入都被限制在记忆根内（条目名经 `slugify`，`..` 直接拒绝）。

### 4.1 视觉规范（对齐宿主，不发明新样式）

页面刻意只用宿主自己的规格，所有数值都从 DSH 源码里抄来，不是估的：

| 元素 | 依据 | 规格 |
|---|---|---|
| 页面容器 | `ui-settings-general` 的 `.options` | 外壳已经给了 `padding:0 24px 24px` 与滚动，**根元素不再套一层** padding/height/overflow（这条有回归测试） |
| 列表行 | `ui-settings-general/DeveloperToolsRow.module.css` | `padding:14px 0` + `border-bottom:.5px solid var(--dsw-alias-border-l2)`，无卡片底色；标题 14/20，说明 12/18 `--dsw-alias-label-secondary` |
| 按钮 | `primitives/Button.module.css` | sm：`height:28px`、`border-radius:var(--dsw-radius-sm)`、`font-size:12px`；主按钮走 `--dsw-alias-button-primary-fill` + `--dsw-alias-label-primary-foreground`；描边按钮 `0.5px solid var(--dsw-alias-border-l3)` |
| 输入框 / 选择器 | `primitives/Input.module.css` | `height:32px`、`border:.5px solid var(--dsw-alias-border-l4)`、`border-radius:var(--dsw-radius-md)`、bg `--dsw-alias-bg-layer-1`；聚焦换 `--dsw-alias-state-business-primary`；placeholder `--dsw-alias-label-dimmed` |
| 类型标签 | `primitives/Tag.module.css` | 胶囊 + `0.5px solid var(--dsw-alias-border-l4)` + `--dsw-alias-label-tertiary` |
| 提示条 | `primitives/Tag.module.css` 的状态音色 | `color-mix(in srgb, <state token> 10%, transparent)` 作底 |
| 记忆字形 | 自绘（16px 网格、`currentColor` 描边） | 宿主图标集里没有 memory/brain 字形，最近的只有 archive / database / list-pen |

`--dsw-radius-*` 都带兜底值（`var(--dsw-radius-md,8px)`），避免宿主没定义时塌成直角。

### 4.2 关于导航图标（外壳写死，插件改不了）

设置面板左侧那一列的图标**不是**注册项的一部分：外壳 `dsh-client-ui-settings-general` 里有一个硬编码函数

```js
// Nav glyph by section id; unknown ids fall back to the settings gear.
function navIcon(id) {
  if (id === 'account') …
  if (id === 'models') …
  if (id === 'agent-presets') …
  if (id === 'plugins') …
  if (id === 'archived-sessions') …
  return <IconSettingsOutlineMedium size={16} />   // 兜底：设置齿轮
}
```

而 `settings.section` 的注册项只接受 `{ id, order, label }`（`Slots.listSubTree` 的 catalog 里没有 icon 字段），导航行的渲染就是 `[navIcon(row.id), <span>{label}</span>]`，也没有每行的图标插槽。

结论：**第三方设置页拿到的是兜底的齿轮图标，插槽层面无法自定义**。

**当前采用的绕法（方案 B）**：借用外壳已映射、但整份 DSH 里**没有任何包注册**的 `archived-sessions` 座位，
从而拿到 `IconArchiveOutlineMedium`（档案盒）——一个「把东西存起来」的隐喻，比齿轮贴近记忆库。
代价与回退方式：

- 语义上我们占的是「归档会话」的座位，不是「记忆」。
- 若将来 DSH 真的启用了 `archived-sessions` 设置页，两边会挤进同一个座位（后注册者覆盖）。
  届时把 `client.js` 里的 `id` 改回 `'memory'` 即可——功能不受影响，只是图标退回齿轮。
- 页面头部仍然自带自绘的记忆字形（`.dshmem-headIcon`），所以即使图标退回齿轮，页面内的识别度不变。

另外两条备选（未采用）见 §10。

### 4.3 这一页什么时候出现

客户端插件的清单是**页面加载时组装**的，所以：

- **首次安装后需要重启一次桌面端**（托盘菜单「退出」，再重新打开）。桌面端的应用菜单里只有「关于 / 检查更新 / 管理 dsh 命令 / 退出」，**没有「重新加载」**，F5 与 Ctrl+R 也没有接线 —— 换句话说，装完客户端插件没有别的热加载途径。
- 之后改 `client.js` 同样需要重启；改宿主半边（`host.js`）则由 HMR 即时生效，不用重启。

> 开发客户端半边时可以让 `pnpm run dev:web` 跑起来，那样客户端插件的改动会热替换、不用重启（见系统里的 DSH 说明）。

## 5. 安装

插件目录在 `C:\Users\17040\.dsh\plugins\memory\`（与 skins / sysmon / token-stats 同级，都是 `~/.dsh/plugins` 下的自研插件）。宿主半边只用 `ctx.tools`、可选的 `ctx.webServer` 与 Node 内置模块，**不 import 任何 `@deepseek-ai/*`**，因此不依赖 DSH 的模块解析拦截层。

### 5.1 链接进 desktop profile

编辑 `~/.dsh/profiles/desktop/package.json`，在 `dependencies` 里加一行（路径按实际位置改）：

```json
"dsh-memory": "link:C:/Users/17040/.dsh/plugins/memory"
```

然后在 profile 目录装一次依赖（Node 与 pnpm 都用桌面端自带的，别用系统版本）：

```powershell
& "F:\dsh\resources\runtime\bin\node.cmd" "F:\dsh\resources\runtime\pnpm\bin\pnpm.mjs" `
  -C "$env:USERPROFILE\.dsh\profiles\desktop" install
```

> 也可以不走 package.json，直接把插件目录软链到 profile 的 `node_modules/dsh-memory`，
> 但那样插件不在 profile 的依赖图里，升级/卸载要手工处理——推荐上面的 `link:` 方式。

### 5.2 声明为组合包（bundle）并启用

本包声明了 `dsh.bundle.patch`，所以它按**组合包**安装，而不是往 profile 的 patch 里 insert 一行。
在 profile 的 `package.json` 里把它列进 bundles：

```json
"dsh": {
  "profile": {
    "bundles": [
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-web-app",
      "…",
      "@local/dsh-math-team-presets",
      "dsh-memory"
    ]
  }
}
```

加载行由本包自己的 [`cordis.patch.yml`](cordis.patch.yml) 声明（`insert: id: memory`）。

> ⚠️ **不要再往 profile 的 `cordis.patch.yml` 里 insert 同一条**：`applyEntryPatches` 对 insert
> 只做 `data.push(...insert)`，同一 id 插两次就会加载两遍，第二次注册同名工具直接报
> `tool memory_write is already registered`。

这么做的收益：本包会出现在侧边栏**「插件」页的「已安装」列表**里（该列表筛的就是
`plugin_manager list_bundles` 中 `installed: true` 的组合包），带版本、描述、开关，并且可卸载。
profile 自己的 patch 仍可按 `id: memory` 覆盖 config 或 `disabled: true`（bundle patch 先应用，
用户 patch 后应用，后者胜）。

条目的**图标与标题**来自包自己的展示元信息：`package.json` 的 `icon: ./icon.svg`
（相对路径、SVG/PNG/JPEG/WebP、≤256 KiB、必须在包目录内）加 `locale/zh.json` 与
`locale/en.json` 的 `meta.title` / `meta.description`（`exports` 要放开 `./locale/*.json`）。
缺 locale 时列表会回退成裸包名 `dsh-memory` + `package.json` 的 description；
现在显示的是图标 + **记忆**。

可选的 hmr 开发段（把源码监听指到本目录，改代码即时生效）：

```yaml
- id: hmr
  disabled: false
  config:
    base: 'file:///C:/Users/17040/.dsh/plugins/'
    root: ['memory']
```

确认方式：

- `plugin_manager list_bundles` 里应出现 `"name":"dsh-memory"`，`installed: true`、`enabled: true`，
  且 `rows[0]` 是 `{rowId: "memory", moduleName: "dsh-memory", entryId: "include:memory"}`。
- `plugin_manager list_plugins` 里 `include:memory` 的 `fiberPhase` 应为 `active`；
  用 `set_plugin` 启停时 target 要写 **`include:memory`**（只写 `memory` 报 `unknown-plugin`）。
- 让模型调用一次 `memory_search`；或看 `~/.dsh/AGENTS.md` 里有没有生成托管区块。
- 加载失败时插件会把异常写到 `~/.dsh/memory/.dsh-memory-load-error.log`（DSH 界面看不到 fiber 错误），
  加载成功会删掉它。

### 5.3 配置项

| 字段 | 默认 | 含义 |
|---|---|---|
| `home` | `<DSH_HOME>/memory` | 记忆根目录。指到 `~/.zcode/global-memory` 即可与 Z code **共用同一份记忆** |
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | 用来推导默认 `home` 与 `agentsPath` |
| `agentsPath` | `<dshHome>/AGENTS.md` | 托管区块写进哪个指令文件 |
| `autoAgentsSync` | `true` | 是否在每次写入/删除后同步索引区块（关掉可省去同会话的重复重注入，见 §11 的成本一节） |
| `syncOnStartup` | `true` | 插件加载时先同步一次 |
| `settingsPage` | `true` | 是否注册 `/memory-api/*` 设置页接口（没有 `webServer` 的 profile 会自动跳过） |
| `maxBlockBytes` | `20000` | 索引区块的字节预算，超出则**从末尾截断**条目并给出指向完整索引的提示；本 profile 的 bundle patch 2026-10-04 起设为 `32768`（原 20480 已被 69 条索引顶满） |
| `autoCommit` | `true` | 落盘后把记忆库**本地提交**一次（`git add -A && git commit`，**从不 push**）。home 不是 git 仓库时静默跳过；任何 git 失败都吞掉、不影响记忆写入。stdio 用 `ignore`（沙箱下管道捕获子进程输出会 EPERM）。设 `false` 关掉 |
| `injectProjectBlock` | `true` | **文件通道（已退休，2026-10-09）**：是否把索引写进 `AGENTS.md`/`AGENTS.local.md` 的托管区块。**`promptInjection` 生效时这个开关被忽略**（不再写文件）；它只在 `promptInjection.enabled:false`（回滚到文件通道）时起作用 |
| `projectBlockFile` | `AGENTS.local.md` | 工作区块写进哪个文件（仅文件通道用） |
| `maxProjectBlockBytes` | `8192` | 工作区块的字节预算（仅文件通道用） |
| `blockMode` | `layered` | `layered` = 分层区块（头部 + 触发规则 + 规则速查 + 专题地图，见 §12.1）；`full` = 旧行为（逐条索引全量）。**这是 L0 的一键回滚开关** |
| `triggerLines` | 内置 5 条 | 「动手前先查记忆」那几条触发规则；给了就**整体覆盖**内置默认 |
| `sectionHints` | 内置 5 组 | 专题地图每行后面的关键词提示（按分组名覆盖）。内置默认是刻意的——**本文件只在应用启动时读**，写在这里的新键要重启才生效，内置默认保证「改完代码即生效」 |
| `retrieve` | 见下 | L1 检索注入（见 §12.2）。子字段：`enabled`(`true`)、`k`(`3`)、`minScore`(`8`)、`maxBytes`(`2000`)、`minQueryChars`(`4`，查询有效长度不足就不注入)、`repeatAfterSteps`(`60`，兜底去重窗口)、`clearOnCompaction`(`true`)、`log`(`true`)。`enabled: false` 是 L1 的一键回滚开关 |
| `compactionGuard` | 见下 | 把「压缩时必须保留 dsh-memory 检索条目」注册进**系统提示词**（见 §12.3）。子字段：`enabled`(`true`)、`order`(`10300`)、`text`(可整体覆盖段文本)。`enabled: false` 关掉 |
| `promptInjection` | 见下 | 记忆索引改走插件自己的扩展点（见 §12.4）。子字段：`enabled`(`true`)、`sectionOrder`(`10250`)、`contextOrder`(`200`)。与 `settingsPage`/`webServer` **无关** |

## 6. 从 Z code 导入已有记忆

两边的目录结构与索引格式本来就一致，所以导入是**保结构复制**，不是翻译：

```powershell
cd dsh-memory
node import.cjs --from "C:\Users\17040\.zcode\global-memory" --to "$env:USERPROFILE\.dsh\memory" --dry-run
node import.cjs --from "C:\Users\17040\.zcode\global-memory" --to "$env:USERPROFILE\.dsh\memory"
```

实测：**条目会一直长**——2026-10-04 已到 68 条全局条目 / 8 个分组，索引区块约 20.3 KB，把当时的 20480 字节预算顶满（区块末尾出现「索引超预算，此处省略 N 条」）。`maxBlockBytes` 因此提到 **32768**；`dsh-agent-instructions` 那边还有 64 KB 的指令预算兜底。条目继续增长时优先精简摘要，其次再提预算。

## 7. 自检

```powershell
cd dsh-memory
node selfcheck.cjs    # 43 项：文件格式、索引增删改（含折行续行、空分组清理、同 target 去重与 repairIndex）、切词/多词检索、项目键寻址、AGENTS.md 托管区块幂等与预算、CRLF 条目解析
node plugintest.cjs   # 40 项：mock ctx 下的工具注册形状、execute/render 接线、作用域、错误路径、/memory-api/* 全部路由与参数校验
node clienttest.cjs   #  9 项：客户端 bundle 形状、settings.section 注册参数、样式只走主题 token 且不重复外壳留白、沿用宿主控件规格、首次渲染、只请求 /memory-api/*
node lintmemory.cjs   # 14 项：校验**真实记忆库**的字段约定、摘要一致性、双链与注入预算（见下）
node reindex.cjs      # 一次性修复：合并索引里同一 target 的重复登记（--dry-run 预演）
node memcheck.cjs     # 体检（只读）：待合并候选、陈旧条目、作用域可疑、孤岛条目、预算余量
node namemap.cjs      # 查 name（只读）：库里路径式与叶子名混用，写 [[…]] 前先查；--leaf 只看叶子名
node import.cjs --from <源> --to <目标> --dry-run   # 导入预演
```

也可以 `pnpm test` / `npm test`（= 上面四项顺序执行）。

`lintmemory.cjs` 是 2026-10-01 补的**真实库** lint——`selfcheck.cjs` 只测临时目录里的纯文件逻辑，
管不到"库里那几十条到底写得对不对"。它按 INDEX.md 的字段约定检查：

- frontmatter 齐备（`node_type` / `name` / `description`），`name` 与文件名一致；
- `scope` 显式且与位置一致（全局库根 = `global`，`projects/<键>/` = `project`）；
- `type` 合法，且 `project` 只用于 `projects/` 或 `study/` 白名单；
- 索引不重复登记同一条目、不指向不存在的文件，条目也不会成为孤儿；
- 行尾统一为 LF（不允许 CRLF）、每个条目都有 `updatedAt`；
- `description` 不许折行（插件按行解析，续行会被静默吞掉）；
- 索引摘要必须与 frontmatter `description` 一致（同一事实只留一套摘要）；
- 正文 `[[…]]` 必须命中某个条目的 `name`；
- **索引标题不许是英文文件名**（`标题 === target` 或以 `.md` 结尾都不行）——标题是给人读的那套，`name` 只是检索兜底；混用会让设置页列表出现中英混排；
- `~/.dsh/AGENTS.md` 托管区块没被预算截断、且余量 > 10%。

首次运行就抓到两个真问题：**`parseEntry` 在 CRLF frontmatter 上会丢最后一行元数据**
（`head` 末尾残留 `\r`，正则的 `$` 匹配不上；本库 20 个 CRLF 条目里 8 条正好把 `scope` 写在最后一行，
于是"scope 缺失"），以及一个条目文件名拼错（`generalmuser-…` vs frontmatter 的 `generaluser-…`）。
前者已在 `lib/store.js` 修掉并加了回归测试。

### 7.1 索引重复登记（2026-10-01 发现并修复，v0.3.1）

同一个 lint 后来又抓到第三条真问题：`INDEX.md` 里 `preferences/skill-strict-execution.md` 与
`workflows/music-compose-pipeline.md` **各被登记了两行**——一行在人工维护的中文分组里（旧标题），
一行在文件末尾新出现的 `## preferences` / `## workflows` 里（新标题）。

根因在 `write()` + `upsertIndexEntry()` 的分工：

- `write()` 在调用方没给 `section` 时，**回退成 `name` 的首段目录**（`preferences/…` → `preferences`）；
- 而 `upsertIndexEntry()` 只在**目标分组内**找同 target。两个"不同"一撞上，就变成"新开一组 + 追加一行"，
  旧分组里那行原样留着。触发条件很常见：`memory_write(overwrite: true)` 时漏传 `section`
  （旧标题 → 新标题时特别容易，因为人会去改 `title` 而忘了 `section`）。

修复分两层，都在 `lib/store.js`：

1. **同 target 全局去重**：`upsertIndexEntry()` 现在先扫全索引里该 target 的所有登记处——
   已登记过就**原地更新**（不管它在哪个分组），同时删掉多余的登记行；只有调用方**显式**传了
   `section`（`{ forceSection: true }`）才把条目搬分组，搬空的旧分组会被剪掉。
2. **分组以索引为准**：`write()` 没拿到 `section` 时，沿用索引里现有的分组；只有全新条目才回退到
   name 首段目录。返回值里的 `section` 是**实际落地**的分组（另给 `sectionRequested` 供排查）。

已经写脏的库用一次性脚本修回来（位置取第一次登记、内容取最后一次登记，摘空的重复分组剪掉，
跑完顺带重同步 `AGENTS.md` 托管区块）：

```powershell
node reindex.cjs --dry-run   # 只看会改什么
node reindex.cjs             # 真改（自动备份靠 git / 你自己的工作区备份习惯）
```

`selfcheck.cjs` 补了 4 项回归（漏传 section 不产生重复、显式换组会搬家且剪空组、upsert 自愈、
`repairIndex` 的取舍与折行续行清理），`lintmemory.cjs` 的"索引不重复登记"一项从此守着这条不变量。

`plugintest.cjs` 里复刻了 `@deepseek-ai/dsh-tools` 的原始 JSON Schema 子集校验
（`assertSupportedJsonSchema`）：**`ctx.tools.register()` 收的是已经转换好的标准 JSON Schema，
不是 `defineTool` 的参数规格**——`required` 只能是 object 节点上的字符串数组，属性里写 `required: true`
会直接抛 `JsonSchemaError`，`additionalProperties` 必须是 boolean。这个坑本地就能挡住。

## 8. 开发循环

- HMR 只跟踪**入口文件** `host.js`。改完 `lib/store.js` 后要么碰一下 `host.js`，
  要么在 `cordis.patch.yml` 里动一下 `memory` 的配置，插件才会重挂载。
- `host.js` 加载时会 `delete require.cache[require.resolve('./lib/store')]`，
  所以重挂载必然读到最新的 `store.js`（否则会命中被缓存的旧版本——这个坑实际踩过：
  schema 已修好但进程仍报旧错误，堆栈行号与磁盘文件完全对不上）。
- 如果连 `host.js` 的改动都没生效，说明 `hmr` 的源码监听没配（见 §5.2）。

## 9. 与 DSH 既有机制的关系

- **不碰会话日志**：记忆是磁盘文件，不是会话事件。写入不产生会话事件，因此不影响回放与压缩。
- **注入走现成通道**：索引进的是 `$DSH_HOME/AGENTS.md`，由 `dsh-agent-instructions` 按它自己的预算与刷新规则加载——不新增注入路径，也不与它抢 KV cache 前缀。
- **和 `AGENTS.md` 的分工**：`AGENTS.md` 放「必须遵守的硬规则」，记忆库放「可检索的事实与经验」；区块用 HTML 注释界定，**插件只改区块内部，你写在区块外的内容一个字都不会动**。
- **和 `storage-domain` 的分工**：需要模型看得见、人可以手改的用记忆库；纯宿主侧状态继续走 `storage-domain`。

## 10. 已知限制

- **导航图标只能靠借座位**：外壳按 section id 硬编码图标，见 §4.2。当前采用方案 B
  （借空置的 `archived-sessions` 座位拿档案盒图标）。另外两条备选：
  - **A. 保持齿轮**：把 `id` 改成 `'memory'`，零风险、升级不坏，但导航里是通用齿轮；
    页面内的记忆字形不受影响。
  - **C. CSS 覆盖最后一个导航格**：能拿到真正的记忆字形，但依赖外壳生成的哈希类名
    （`wCInkW_navList` / `wCInkW_navIcon`）。失败方式是「安静失效、退回齿轮」，不至于崩；
    风险是若将来有 order > 30 的新设置页，图标会落到别人那一行。DSH 每次改动这两个模块都会换哈希名。
- **记忆不会自动写入**：需要模型判断「这条值得记」并调用 `memory_write`，或在 `AGENTS.md` 里写硬规则要求它这么做。自动候选提取（turn 结束抽候选）是后续工作，尚未实现。
- **检索是多词子串，没有向量**：查询先按空白/标点/中英边界切词，逐词按「标题 > 摘要/路径 > 正文」计分，整串命中权重最高。两个已知限制：
  - **无空格的多词中文不切分**：`笔记本蓝屏` 是一个词，不会拆成 `笔记本` + `蓝屏`；写成 `笔记本 蓝屏` 即可。曾试过 bigram 兜底，但 `不存在`、`关键` 这类常见二字词会让乱码查询也凑够票数产生假命中（`不存在的关键词xyzzy` 曾命中 12 条），所以**刻意不做**。
  - 条目多了以后召回仍会下降，届时可接 `session-query-sqlite` 的 FTS 或外挂 embedding。
- **区块是快照**：`AGENTS.md` 里的索引在写入时同步；若你手工编辑了 `INDEX.md`，要么重启插件，要么跑一次 `node -e "require('./lib/store').createStore({}).syncAgents()"`。
- **并发写同一工作区**：靠原子替换（写临时文件再 rename）保证不撕裂，没有跨进程锁。
- **同一份 `home` 被两个 agent 系统共用时**（例如指到 Z code 的目录），两边的写入互不感知：索引可能出现重复条目，两边对"分组"的叫法也可能互相改来改去。v0.3.1 起 `upsertIndexEntry` 会按 target 全局去重（每次写入顺手合并），
  `node reindex.cjs` 可一次性把历史重复合并掉——但两个系统仍可能争夺同一个分组名，共用是可行但需自觉。

## 11. 实测记录（2026-09-30，本机 desktop profile）

装上并在**运行中的 DSH 里**验证过，不是只在本地跑的单元测试：

| 验证项 | 结果 |
|---|---|
| `plugin_manager list_plugins` | `include:memory` / `dsh-memory` → `fiberPhase: active` |
| 导入 Z code 记忆 | 43 条、8 个分组，落到 `~/.dsh/memory` |
| `~/.dsh/AGENTS.md` 托管区块 | 生成成功，2026-10-04 实测 20.3 KB / 68 条（预算 32768 字节，指令预算 64 KB） |
| 注入生效 | `dsh-agent-instructions` 在会话中途就检测到该文件变化并重新注入（肉眼可见） |
| `memory_search` | 命中 6 条、按作用域分组、返回完整正文 |
| `memory_write`（global） | 落盘 + frontmatter + 索引 + 区块同步，一次调用全做完 |
| `memory_write`（project） | 落到 `projects/deepseek-harness-e9b7a1e936a10df7/` |
| `memory_read` | 按名字读到全文与元数据 |
| `memory_forget` | 文件与索引条目都删除，区块同步回退 |
| `/memory-api/status` | 宿主直接返回真实状态：44 条、区块 11 151 字节、1 个项目库 |
| `dsh-memory/client` 解析 | 从 profile 里 `require.resolve('dsh-memory/client')` → `client.js`；`dsh.client` 声明被正确解析 |
| 设置页 `settings.section` | 插槽契约已核对（`id`/`order`/`label`/`ownerProps: {close}`）；**客户端注册要等桌面端重启后才可见** |
| 视觉规范 | 页面容器不再重复外壳留白、行分隔线为 0.5px `border-l2`、控件尺寸与缓存 token 全部对齐 primitives——均有断言守住（`clienttest.cjs`） |
| 记忆库 lint（2026-10-01） | `lintmemory.cjs` 对真实库 53 条 / 3 个索引文件跑 9 项检查 → 9 通过 0 失败 |
| 导航图标 | 借用空置的 `archived-sessions` 座位 → 档案盒图标；`grep` 全库确认只有外壳图标表引用该 id |
| 组合包（bundle） | 迁移后 `plugin_manager list_bundles` 出现 `"name":"dsh-memory"`, `version:"0.3.0"`, `installed:true`, `removable:true`, `rows:[{rowId:"memory", moduleName:"dsh-memory", entryId:"include:memory"}]`；迁移期间 `include:memory` 保持 `active` 未掉线 |
| 设置页注册 | 桌面端重启后 `Slots.listSubTree('settings.section')` 的 occupants 出现 `{id:"archived-sessions", order:30}` |

### 第二轮：问题清单修复（同一日实测反馈）

用户实测后提交了一份问题清单（4 条 BUG + 2 条备注），全部修复并回归：

| 编号 | 问题 | 修法 | 线上验证 |
|---|---|---|---|
| BUG-1 | 空命中文案写死「项目作用域」，与请求的 scope 无关 | 按实际搜索过的作用域拼文案（`已搜索：全局记忆` / `当前工作区记忆 + 全局记忆`） | ✅ `memory_search{scope:"global"}` 返回「已搜索：全局记忆」 |
| BUG-2 | 多词查询被当成一个整体子串 → 假阴性（`CUDA 蓝屏` 返回空） | 新增 `tokenize()`：按空白/标点切词 + 中英字符类边界；逐词计分（标题 8 / 摘要路径 4 / 正文 2，整串命中 60/40/20，全词命中 +12） | ✅ `CUDA 蓝屏` 命中 5 条，相关两条排最前 |
| BUG-3 | `memory_forget` 后残留空分组标题 | 新增 `pruneEmptySections()`，删除后剪掉无条目的 `## 分组`；`forget()` 返回 `pruned` 列表并写进回执 | ✅ 索引 8 分组无空组；单测覆盖「同组还有条目时不剪」 |
| BUG-4 | `/memory-api/status` 的 `project` 恒为 `null` | 支持 `?key=<项目键>` 与 `?cwd=<绝对路径>`，回显 `source`；非法 key / 相对路径返回 400；`/list` 的 key 也一并校验 | ✅ `?cwd=…` 返回 `project.key=deepseek-harness-e9b7a1e936a10df7`；`?key=../../etc` → 400 |
| 备注 1 | 命中即回整条正文，长条目一次吃掉几千 token | 检索结果按剩余条目**均分预算**（每条上限 6000 字、下限 1200 字），超长截断并给出 `memory_read` 指针 | ✅ 9600 字条目被截断，返回体明显小于正文 |

排查过程中还发现并修掉一个**由 BUG-2 修复引入**的问题：曾用 bigram 兜底无空格中文查询，
结果 `不存在的关键词xyzzy` 因为撞上「不存在」这种常见二字词命中 12 条假结果。
连续重合的大词会让「过半 bigram 命中」失效，所以最终**去掉 bigram**——
代价是无空格的多词中文不切分（见 §10），换来的是乱码查询零命中。

测试从 74 项增至 **87 项**（38 store + 40 插件 + 9 客户端），其中新增 13 项专门守这些回归。
（2026-10-01 又增至 **101 项**：store 43、插件 40、客户端 9、真实库 lint 9，见 §7 与 §7.1。）

### 第三轮：索引重复登记修复（2026-10-01，v0.3.1）

`lintmemory.cjs` 的「索引不重复登记」在真实库上抓到两处重复登记（根因见 §7.1）。修复后的线上验证：

| 验证项 | 结果 |
|---|---|
| `node reindex.cjs` 修真实库 | `INDEX.md` 141 → 133 行，合并 2 处重复；两个 `projects/*/MEMORY.md` 无需修 |
| 修后 `lintmemory.cjs` | 9 项通过 / 0 失败（55 个条目、3 个索引文件） |
| HMR 重挂载（顺手改 `host.js`） | 生效：`memory_write(overwrite: true)` **故意不传 `section`**，回执是「分组『工具配置』」（旧代码会写「tools」并另起一组） |
| 覆盖写后的索引 | `tools/dsh-memory-plugin.md` 仍只有一行、仍在原分组，没有长出 `## tools`；`createdAt` 保留、`updatedAt` 刷新 |
| `AGENTS.md` 托管区块 | 写入后自动重同步；两条受害条目各只剩一行，且都落在原中文分组 |
| 四项自检 | 43 + 40 + 9 + 9 = **101 项**全绿 |

教训（已写进 `tools/dsh-memory-plugin` 记忆）：**索引行的身份是 target（路径），不是标题、也不是分组名**；
覆盖写必须按身份定位后原地更新，凡"找不到就追加"的分支都得先在全库范围里找一遍。

> 迁移成 bundle 时的坑：profile 的 `cordis.patch.yml` 里那条 `insert: id: memory` **必须同时删掉**。
> `applyEntryPatches` 对 insert 只做 `data.push(...insert)`，同 id 插两次会加载两遍，第二次注册同名
> 工具直接抛 `tool memory_write is already registered`。

过程中修掉的三个真问题，都已写成回归测试：

1. **参数写成 `defineTool` 规格**：`ctx.tools.register()` 要标准 JSON Schema，
   属性里的 `required: true` 直接让插件加载失败。现在由 `plugintest.cjs` 的本地复刻校验挡住。
2. **索引折行续行**：Z code 的索引摘要会折行；解析时只取第一行会截断摘要，
   新增条目还会被插进上一条的续行中间（真把 `tools/dsh-desktop-app` 的摘要切坏了，已修复数据）。
3. **CJS 模块缓存**：改了 `lib/store.js` 但运行中的进程仍执行旧版本，堆栈行号与磁盘文件对不上；
   靠 `host.js` 加载时清理 `require.cache` 解决。

### 验收状态

**设置页已经注册成功了**（桌面端重启后，`Slots.listSubTree('settings.section')` 的 occupants 里出现了
`{id: "archived-sessions", order: 30}`）。剩下的是「肉眼渲染对不对」，本地无法自动验证，验收清单：

1. 设置面板左侧应出现第 6 项 **记忆**，图标是**档案盒**（借用 `archived-sessions` 座位），排在「智能体预设」之后。
2. 打开后应看到页头（记忆字形 + 标题 + 一行说明）、工具栏（搜索框 / 作用域下拉 / 新建条目）、
   状态行（记忆根 · 条数 · 注入区块 · 工作区库 · 刷新 / 重新同步）与 8 个分组。
3. 视觉对照：行分隔线应是 0.5px 的极细分隔、无卡片底色；按钮高 28、输入框高 32；
   明暗主题都应正常，不应出现硬编码颜色。
4. 点一条能打开编辑器并保存；保存后 `~/.dsh/AGENTS.md` 的区块应随之更新。
5. 若页面空白或报错，浏览器控制台会显示 `slot entry crashed in 'settings.section'`；
   宿主侧接口可先用 `Invoke-RestMethod http://127.0.0.1:19387/memory-api/status` 单独确认。
6. 侧边栏**「插件」页的「已安装」**里应出现 `dsh-memory`，显示为**图标 + 「记忆」+ 中文描述**
   （`icon.svg` + `locale/zh.json` 的 `meta`；缺了这两样就退回裸包名）。关掉再打开该页即应刷新，
   若仍没有则重启桌面端。
7. 卸载清理未实现：直接在插件页点卸载，`~/.dsh/AGENTS.md` 里的托管区块会**留下**并继续被注入
   （指向已经不存在的 `memory_*` 工具）。卸载前请手动删掉 `<!-- dsh-memory:begin -->…<!-- end -->` 区块。

## 12. 注入成本（实测，2026-09-30）

「往新对话里注入多少」和「一次会话总共注入多少」是两回事，实测数据：

| | 量 |
|---|---|
| 整份 `~/.dsh/AGENTS.md`（新会话注入一次） | **11.3 KB / 7 457 字 / 59 行**，约 **2 500–3 000 tokens** |
| 其中托管区块（68 条索引） | 20.3 KB |
| 其中区块外（用户自己的内容） | 47 字节 |
| 项目级 `AGENTS.md` 链 | 0（本工作区根目录没有） |
| 占 `maxBytes` 指令预算 | 31.7% |
| 全库总量 | 263.9 KB / 72 条（正文 token 数随内容增长） |
| **索引 / 全库比例** | **7.7%** —— 这是这套设计最值钱的地方：库可以长到几百 KB，进上下文的只有目录 |

**变更会重复注入**：`dsh-agent-instructions` 在 `changedSectionText()` 里对「文件已改变」发的是
**整份 `file.content`**，不是 diff、也不是摘要：

```
Updated instructions from: ~/.dsh/AGENTS.md
This file changed after it was loaded. Use the following content instead of the previously loaded instructions from this file.
<整份 AGENTS.md>
```

语义上是「替换」，物理上是**追加**——旧的那几份仍留在会话历史里占 token，直到 compaction 压掉。
所以 **`memory_write` 一次 = 当前会话多背一份 11 KB**。

实测本仓库那次开发会话（从 `session.v4.jsonl.zstd` 逐帧解压 + 按事件类型统计）：

```
重注入的 user/message 事件：12 条（全部来自 ~/.dsh/AGENTS.md）
合计 135.1 KB，单条中位 11.6 KB
```

（12 > 写入次数，因为重写 AGENTS.md 的不止 `memory_write`，还有插件每次重挂载时的 `syncOnStartup`。）

**新会话只注入一次，所以贵的是同一会话里反复写。** 三档应对：

| 做法 | 效果 | 代价 |
|---|---|---|
| `autoAgentsSync: false` | 写记忆不再改 AGENTS.md，改为手动同步——一个会话最多 1 次重注入 | 索引会滞后；但 `memory_search` 永远读磁盘，不受影响 |
| `maxBlockBytes: 8192` | 每次重注入的份量变小 | 索引不全，需检索补足 |
| 把写记忆集中在会话开头 | 天然只有 1–2 次重注入 | 靠习惯 |

### 12.1 工作区记忆区块（2026-10-09 新增）

全局 `~/.dsh/AGENTS.md` 是所有工作区**共用**的，塞不进 per-workspace 内容；而 DSH 的
`dsh-agent-instructions` 会按 `projectRoot→cwd` 逐级读工作区自己的 `AGENTS.md` / `AGENTS.local.md`
（`.local` 变体是**独立候选**，不需要 base 文件存在）。所以项目索引写进**工作区自己的**指令文件：

- **渲染**：`buildProjectBlock(cwd)` —— 与全局区块同构，标记是 `<!-- dsh-memory-project:begin/end -->`，
  预算独立（`maxProjectBlockBytes`，默认 8192）。
- **落盘**：`syncWorkspaceAgents(cwd)`，由 `host.js` 的 `sync(cwd)` 在 `memory_write` / `memory_forget`
  之后调用（**只有拿到会话 cwd 时才写**；设置页那条路径只有 key、没有 cwd，故不动工作区文件）。
- **默认文件 `AGENTS.local.md`**：独立生效，且按惯例不进版本控制，避免把生成物塞进用户的仓库；
  想让它进仓库就把 `projectBlockFile` 改成 `AGENTS.md`。
- **三条安全约定**：①只动托管区块，区块外一个字不改；②本工作区没有项目条目**且**文件里没有托管区块时
  **什么都不做**（不在用户仓库里凭空建文件）；③条目删空后摘掉区块，文件因此变空则删掉文件。
- **关掉**：`injectProjectBlock: false`。
- **测试注意**：假 session 的 cwd 必须是临时目录——用真实工作区路径会把测试夹具写进开发者的仓库
  （2026-10-09 真漏过一次，`plugintest.cjs` / `selfcheck.cjs` 已改用 `mkdtemp`）。

### 12.2 L1 检索注入（2026-10-09 新增）

L0 把逐条索引换成了规则 + 地图，代价是"细节要靠模型自己搜"。实测 456 个被注入会话里
**86.2% 一次都没搜过**；48 条从未被读的条目里 **41 条主题在会话里出现过**（投递失败）。
所以 L1 把"模型想起来搜"换成"相关记忆自动出现"：

- **钩子**：`ctx.on("agent/pre-step", async (payload, next) => …)`。**必须在 `inject` 里声明 `agents`**，
  否则钩子注册成功但永远不触发（原来只声明 `tools`，实测踩到）。
- **时机**：只在**用户轮次**注入（`payload.messages` 里出现新的 user 消息）；工具续跑步骤直接返回，
  既省 token 也让前缀保持稳定。
- **流程**：取本轮用户消息（剥掉 `<system-reminder>` 与指令块）→ `search(project)` + `search(global)`
  → `lib/retrieve.js` 的 `pickHits` 按 `k/minScore/maxBytes/seen` 挑 → `renderInjection` 渲染 →
  以 `{content:[{type:"text",text}], source:{kind:"dsh-memory-retrieval", form:"retrieval", changes:[]}}`
  追加到本轮消息。**`source` 不能省**：只给 `{content:[...]}` 会让框架去读 `message.source.kind`，
  抛 `Cannot read properties of undefined (reading 'kind')`、**整轮直接崩掉**（2026-10-09 实测踩到，
  那条提问因此没被收到）。自定义 `kind` 是可行的——官方团队插件用 `kind:"team-message"`。
- **三条硬约束**（都是为了不破坏前缀缓存，实测缓存命中率 96.9%、前缀可达 20 万 token）：
  ①只追加，绝不改写/删除已注入消息；②内容确定性；③同一条目不反复注入。
- **去重的主触发器是「压缩」而不是步数**：DSH 会压缩长会话，`compaction/prune` 会把消息 **shadow** 掉
  （实测某会话 15 个压缩事件、prune 落在 seq 23/29/36/48），那条「我送过了」的内容可能已不在上下文里。
  所以 `host.js` 监听 `session/event`：收到 `compaction/end` / `compaction/prune` 就**清空该会话的注入记账**，
  下一次用户轮次重新可注入。`repeatAfterSteps`（默认 60）只是兜底窗口，防止「没压缩但会话极长」时反复注入。
  `clearOnCompaction: false` 可关掉压缩触发。
- **精确补送**：注入消息在会话日志里是 `user/message` 事件、带自己的 `seq` 与上面的 `source.kind`，
  所以能靠 `source.kind` 认出来；`compaction/prune` 又带 `shadowedSeqs`（被遮掉的消息 seq）→
  两者比对，**只把确实被遮掉的那几条原文重送**（原文复用＝确定性，不必再读库）。
  日志里对应 `injection-seq-recorded` / `injection-shadowed` / `restore-after-compaction`。
- **配置**：`retrieve: {enabled, k, minScore, maxBytes, minQueryChars, repeatAfterSteps, clearOnCompaction, log}`。
  `enabled: false` 只关 L1；`blockMode: full` 只关 L0——两级都能单独回滚。
- **降级**：钩子注册失败或本轮异常 → 记 warn 并原样返回，L0 照常工作。
- **注入日志**：`%LOCALAPPDATA%\Temp\dsh-memory-l1.log`（每次用户轮记 `no-hit` 或 `inject`+targets），
  是 A/B 验证"搜索率/命中率有没有改善"的数据源。

### 12.3 压缩保护段（`compactionGuard`，2026-10-09 新增）

**要解决的问题**：DSH 压缩长会话时会把旧消息 **shadow** 掉（`compaction/prune` 的 `shadowedSeqs`），
而 L1 的注入**只在用户轮次发生一次**（为了前缀缓存），所以它可能被压缩吃掉。§12.2 那套"比对
`shadowedSeqs` 再补送"是**硬保证**，本节是降低丢失概率的**软保证**。

**做法**：不直接改压缩提示词——`dsh-compaction-basic` 的 `COMPACTION_INSTRUCTION` 是**模块私有常量**，
config schema 里没有提示词字段，想改只能 patch asar（应用一更新就没了）。改为用官方扩展点
`ctx.systemPrompt.section({name, order, text})`（`dsh-system-prompt`）注册一段**系统提示词**：

```
Note for context compaction only: when this conversation is condensed into a `<compacted-summary>`
checkpoint, messages that begin with "（dsh-memory 自动检索：" carry entries retrieved from the
user's long-term memory store. … copy their entry lines (title, `name`, and summary) verbatim into
"## Critical Context" — do not paraphrase, merge, shorten or drop them. …
```

**为什么放系统提示词**（两条都来自 `dsh-compaction-basic` 的 README，实测核对过）：

1. **摘要模型会逐字回放系统提示词**（surface 节点 0 作为 `messages` 首项）→ 要求必然送到它眼前；
2. **系统提示词永不被遮蔽**（压缩范围一律从第一个非 `system/message` 节点开始）→ 指令自己不会被压缩掉。

**代价与性质**：段文本约 595 B，每次请求都重复（见 `dsh-system-prompt` 的 Token 影响），但内容静态、
前缀稳定（KV cache 友好）。**它是软保证**（靠摘要模型照做），所以与 §12.2 的硬保证叠加使用。
配置：`compactionGuard: {enabled, order, text}`；段名 `dsh-memory:compaction-guard`，默认 order `10300`
（排在第一方内容 10000/10100/10200 之后）。

**验证方式**：会话日志里的 `system/message` 事件应包含段文本（实测 seq 4384、整段 9304 字符里带着它）；
插件日志有 `compaction-guard-registered` / `compaction-guard-failed`。

### 12.4 记忆索引改走插件扩展点（`promptInjection`，2026-10-09 第二步）

**要解决的问题**：AGENTS.md / AGENTS.local.md 是**文件写入** —— 插件关掉后区块仍留在文件里、仍被官方
加载器注入，而区块里写的 `memory_search`/`memory_read` 那时已经不存在了（**指令与事实不一致**）。
`ctx.on` 与 `ctx.systemPrompt.section()` 这类注册都绑在插件作用域上、随插件销毁，**写进文件的东西不会**。

**做法**：把记忆索引从文件搬到两个同样"随插件销毁"的扩展点：

| 层 | 通道 | 说明 |
|---|---|---|
| 全局 L0（规则速查 + 专题地图） | `ctx.systemPrompt.section({name:'dsh-memory:index', order:10250})` | 进**系统提示词**；顺带**永不被压缩遮蔽** |
| 工作区项目索引 | `ctx.systemPrompt.context({name:'dsh-memory:project', order:200})` | 进 **runtime context**（与 `time-context` 同一通道，仍是每轮 user 消息） |

两者的 `text` 都传**函数**（`text(context)` 每次组装求值）——工作区那条据此按 `agent.session.header.cwd`
现算。段文本带 5 秒 TTL 缓存（`alwaysRules()` 要扫全部条目文件，不能每次组装都扫），写库后立即失效。

**三个必须记住的实现事实**（都是实测踩出来的）：

1. **注册必须挂在主 ctx 上**。三条注入通道原本被我追加在 `applyHttp`（设置页接口）函数末尾，而
   `applyHttp` 只在 `settingsPage !== false` **且**存在 `webServer` 时才被调用 ⇒
   `settingsPage: false` 会误关这三样、没有 webServer 的 profile 里则永不注册。
   现已抽成 `applyInjection(ctx, store, cfg)`，由 `applyInner` 直接调用。
2. **别把声明和赋值放在两个函数里**。`invalidatePromptCache` 曾在 `applyInner` 声明、在 `applyHttp` 赋值，
   实测报 `invalidatePromptCache is not defined`（两个函数作用域不同）→ 现放模块级。
3. **别往组装上下文对象上写标记**：它可能是冻结的，写入会抛错并被自己的 catch 吞掉，表现为"探针没触发"。

**配置**：`promptInjection: {enabled, sectionOrder, contextOrder}`。

**第二步（2026-10-09 当天完成）—— 文件通道已退休**：

- `fileBlocksEnabled(ctx, cfg)` 决定文件通道是否生效：**能走系统提示词通道就不写文件**。
  显式 `injectProjectBlock: false` 仍是关闭；`promptInjection.enabled: false` 是**回滚开关**
  （恢复文件通道，下次启动重写区块）。
- 走新通道时，启动的 `sync(null)` 与 L1 钩子首次拿到 cwd 时都会调 `store.stripFileBlocks()`：
  摘掉历史遗留的托管区块，**全局文件若只剩我们写的那行标题就整个删掉**（否则官方加载器每轮还会
  注入一条只有标题的空指令）。
- 实测：`~/.dsh/AGENTS.md` 被删、session 里出现 "Instructions removed: ~/.dsh/AGENTS.md"；
  `AGENTS.local.md` 在下次用户轮次由钩子摘掉。

## 13. 自动提交（`autoCommit`）

`memory_write` / `memory_forget` / 设置页保存与删除落盘后，会在记忆根跑一次
`git add -A && git commit -m "<作用域>：<条目路径>"` —— **只本地 commit，从不 push**。

**为什么必须由插件来做**：库 2026-10-04 纳入 git 后，10-04~10-06 的 16 条新记忆整整两天没进
版本控制——写入方只落盘、不提交，而"每次更改都要提交"是用户明写的约定。人（模型）写完不会记得
手动提交，所以这条不变量只能由唯一会写库的东西来守。

**安全边界**：home 不是 git 仓库 → 静默跳过；`git` 不存在、仓库损坏、`add` 失败 → 吞掉错误并
在工具回执里说明，**绝不让 git 问题挡住"记忆已经写进磁盘"**；没有实际变更（同一条重复写）→
以 `nothing-to-commit` 正常返回。子进程 stdio 一律 `'ignore'`（DSH 沙箱下用管道捕获输出会 EPERM）。

## 14. 定期维护：lint 守机械，memcheck 提示语义

记忆库会随会话一直变长。**结构性问题交给 lint，语义问题交给体检**——两者都只读，不写盘：

| 工具 | 管什么 | 能判对错吗 |
|---|---|---|
| `lintmemory.cjs` | 字段 / 索引 / 摘要一致 / 双链命中 / 注入预算 —— 机械一致性 | 能，错了退出码 1 |
| `memcheck.cjs` | 待合并候选、陈旧条目、作用域可疑、孤岛条目 —— 语义信号 | 不能，只列清单（`--strict` 时才有退出码 1） |
| `namemap.cjs` | 查条目的真实 `name`（库里**命名不统一**：路径式 53 条 / 叶子名 35 条） | 只读工具，永远不挡 |
| 设置 → 记忆 顶部健康度卡片 | 上面那份体检报告的图形版 | —— |

- 宿主新增只读路由 `GET /memory-api/health`（同一份 `lib/health.js`，按 `INDEX.md` 的 mtime + 60 秒缓存；
  写入会改 mtime，所以刚写完刷新也能看到新结果）。
- 阈值可调：`--threshold 0.18`（正文 4-gram 包含度）、`--stale-days 180`、`--limit 12`、`--max-block-bytes 32768`。
- **建议节奏**：每次大批写入记忆后跑一次 `lintmemory.cjs`；每月、或健康度卡片显示"该维护了"时，
  跑一次 `memcheck.cjs` 并按清单做合并 / 升格 / 精简。
- **卡片形态照官方设计系统**（2026-10-04 解 `app.asar` 的 `dsh-client-ui-theme`/`-primitives` 实测）：底色用 `--dsw-alias-markdown-code-block`（官方 CodeCard 的底色；`bg-layer-1` 是**纯白**，与设置页同色＝等于没有卡片）、圆角 `--dsw-radius-md`（=12px，fallback 别写成 8px）、警示用 `--dsw-alias-state-warn-primary`/`-warn-label`（amber）而不是 error 红，状态底纹沿用 Tag 的 `color-mix(..., 10%, ...)` 惯例。`clienttest` 有两条回归守着这些取值。
- **为什么语义问题不能自动修**：`memory_write` 只有"追加"和"整条覆盖"，没有合并原语；哪两条该并、
  两套数字该信哪套，需要判断。2026-10-04 那次全库修复就是人工判断的结果：llama.cpp 簇 5 条并成 3 条、
  硬件簇 2 条并成 1 条、`gpu-mode-do-not-hardcode` 并入预算条、项目条升全局。
