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

工作区键 = `<目录名 slug>-<规范化 cwd 的 sha1 前 16 位>`，例如 `deepseek-harness-71e9342bec5e8de1`——和 Z code 的 `projects/paper-71e9342bec5e8de1` 同一套规则。

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
| `maxBlockBytes` | `20000` | 索引区块的字节预算，超出则截断并给出指向完整索引的提示；本 profile 的 bundle patch 设为 `20480` |

## 6. 从 Z code 导入已有记忆

两边的目录结构与索引格式本来就一致，所以导入是**保结构复制**，不是翻译：

```powershell
cd dsh-memory
node import.cjs --from "C:\Users\17040\.zcode\global-memory" --to "$env:USERPROFILE\.dsh\memory" --dry-run
node import.cjs --from "C:\Users\17040\.zcode\global-memory" --to "$env:USERPROFILE\.dsh\memory"
```

实测：43 个条目、8 个分组，索引区块约 7.7 KB（远低于 20 KB 预算，也远低于 `dsh-agent-instructions` 的 64 KB 预算）。

## 7. 自检

```powershell
cd dsh-memory
node selfcheck.cjs    # 43 项：文件格式、索引增删改（含折行续行、空分组清理、同 target 去重与 repairIndex）、切词/多词检索、项目键寻址、AGENTS.md 托管区块幂等与预算、CRLF 条目解析
node plugintest.cjs   # 40 项：mock ctx 下的工具注册形状、execute/render 接线、作用域、错误路径、/memory-api/* 全部路由与参数校验
node clienttest.cjs   #  9 项：客户端 bundle 形状、settings.section 注册参数、样式只走主题 token 且不重复外壳留白、沿用宿主控件规格、首次渲染、只请求 /memory-api/*
node lintmemory.cjs   #  9 项：校验**真实记忆库**的字段约定与索引一致性（见下）
node reindex.cjs      # 一次性修复：合并索引里同一 target 的重复登记（--dry-run 预演）
node import.cjs --from <源> --to <目标> --dry-run   # 导入预演
```

也可以 `pnpm test` / `npm test`（= 上面四项顺序执行）。

`lintmemory.cjs` 是 2026-10-01 补的**真实库** lint——`selfcheck.cjs` 只测临时目录里的纯文件逻辑，
管不到"仓库里那 50 多条到底写得对不对"。它按 INDEX.md 的字段约定检查：

- frontmatter 齐备（`node_type` / `name` / `description`），`name` 与文件名一致；
- `scope` 显式且与位置一致（全局库根 = `global`，`projects/<键>/` = `project`）；
- `type` 合法，且 `project` 只用于 `projects/` 或 `study/` 白名单；
- 索引不重复登记同一条目、不指向不存在的文件，条目也不会成为孤儿；
- 行尾统一为 LF（不允许 CRLF）、每个条目都有 `updatedAt`。

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
| `~/.dsh/AGENTS.md` 托管区块 | 生成成功，区块约 11 KB（预算 20 KB，指令预算 64 KB） |
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
| 其中托管区块（45 条索引） | 11.3 KB |
| 其中区块外（用户自己的内容） | 47 字节 |
| 项目级 `AGENTS.md` 链 | 0（本工作区根目录没有） |
| 占 `maxBytes` 指令预算 | 17.2% |
| 全库总量 | 127 KB（正文 ≈4.5 万–5.9 万 tokens） |
| **索引 / 全库比例** | **8.9%** —— 这是这套设计最值钱的地方：库可以长到几百 KB，进上下文的只有目录 |

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
