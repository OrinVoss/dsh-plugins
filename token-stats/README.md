# dsh-token-stats

DSH 的 **Token 用量统计报表**插件：把本机所有会话日志里的 `usage` 汇总成一张报表页
（侧栏「Token 统计」图标进入），含 **Token 活跃度热力图**、**每日 Token 趋势图**、
**模型用量环形图**，时间范围可切到近 7 日 / 近 30 日 / 全部。

```
侧栏 panellist 图标  ──►  main keyed slot 'token-stats'  ──►  TokenStatsPage
                                                              │
                                     fetch /token-stats-api/summary
                                                              ▼
会话日志 (*.jsonl.zstd) ──► lib/scan.js 逐帧解压 ──► 聚合 ──► 磁盘缓存
```

## 数据从哪来

DSH 把每个会话写在 `$DSH_HOME/sessions/<workspace-key>/<session-dir>/` 下，文件名是
`session.jsonl.zstd`、`session.v3.jsonl.zstd`、`session.v4.jsonl.zstd`（格式升级时写新文件，
旧文件保留）。每一次模型调用都会落一条 `assistant/message`：

```json
{"type":"assistant/message","seq":225,"time":1786690316912,
 "data":{"usage":{"inputTokens":8357,"outputTokens":205,"cacheReadTokens":256},
         "message":{"source":{"provider":"opencode-go","model":"deepseek-v4-flash"}}}}
```

本插件读的就是 `data.usage` 与 `data.message.source`，按 **本地时区** 切日聚合。

### 两个必须知道的实现细节

1. **同一目录取版本号最高的日志**（`v4 > v3 > 无后缀`）。三种文件可能同时存在，
   全读会把同一会话统计多遍。
2. **会话目录名不一定是 `session-<uuid>`**。实测有大量纯 UUID 目录，所以扫描只按
   「文件所在目录」分组，不依赖目录命名 —— 早期版本按 `session-` 前缀过滤，漏掉了
   约 3/4 的数据。
3. **日志是「连续 zstd 帧」拼接**（每次追加写一帧）。Node 的 `zstdDecompressSync`
   只解第一帧，因此 `lib/scan.js` 自己按帧魔数 `28 B5 2F FD` 切帧并逐帧解压。

## Token 口径

**总量 = `inputTokens + outputTokens + cacheReadTokens`**。

`cacheReadTokens` 是上下文缓存命中后重读的部分，在本机数据里占绝对大头
（实测约 97%），所以报表把它单独列成一个 KPI，避免「总量看着很大」产生误解。
近 7 日 / 近 30 日 / 全部三个范围都在客户端用**按天 × 按模型的完整明细**重算，
不是拿全量按比例估。

### 热力图的时间轴是独立的

**热力图固定铺满最近 12 个自然月，不随时间范围切换**，没记录的日子也占一个空格子
——这样才看得出用量是集中在某几周还是均匀分布。趋势图和模型用量环形图跟随范围切换。
格子宽度随容器自适应（9–26px），塞不下时横向滚动；月份标签画在网格下方。

## 安装

本插件现在是 **`dsh-style-extras`（样式扩展）组合包的成员**：它自己不再声明 `dsh.bundle`，
加载行统一由组合包的 [`cordis.patch.yml`](../style-extras/cordis.patch.yml) 声明
（`insert: id: token-stats`）。装法：

1. 把本目录 link 进 profile 的 `dependencies`（三个成员各自一行）：
   ```json
   "dsh-token-stats": "link:C:/Users/17040/.dsh/plugins/token-stats"
   ```
2. 在 profile 的 `dsh.profile.bundles` 里列出 **组合包 `dsh-style-extras`**（不是本包）。
3. 重启桌面端。侧栏「插件」页会出现一张「样式扩展」卡片，点进去能看到
   **Token 用量统计** 这一行，带自己的开关。

> ⚠️ **不要在 profile 的 `cordis.patch.yml` 里再 `insert` 一次本行**：同一 id 插两次会加载两遍
> （`applyEntryPatches` 对 insert 只做 `push`）。

**生效方式**：

- **宿主半边**：在插件页把「样式扩展」关掉再打开即可触发一次重载，实测不必重启。
- **客户端面板**（侧栏图标）：改动要重启桌面端。

### 配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖（默认值写在组合包的 patch 里）：

```yaml
- id: token-stats
  config:
    cacheTtlMs: 300000      # 聚合结果缓存有效期，默认 5 分钟
    warmupOnStartup: true   # 启动后自动扫一次
```

## 模型归并

DSH 会给**即将下线**的模型加 `-expires-on-MMDD` 后缀，于是同一个模型会在日志里
留下前后两个名字。不归并的话，环形图与趋势图会把它拆成两条，看起来像两个模型在跑。

本机实测的例子：

| 名字 | provider | 时间跨度 | 总量 |
|---|---|---|---|
| `deepseek-v4.1-flash-expires-on-0910` | deepseek-official | 9/8 → 9/9 | 3250 万 |
| `deepseek-flash` | deepseek-official / deepseek-account | 9/10 → 9/30 | 9.44 亿 |

两段首尾相接（后缀里的 `0910` 正好是换名日期），就是同一个 DeepSeek-V4.1-Flash。
归并后合并为一条 `deepseek-v4.1-flash`（约 9.77 亿）。

规则有两层：

1. **兜底**：任何 `<name>-expires-on-MMDD` 自动去掉后缀。
2. **显式别名**：内置表把 `deepseek-flash` 也并到 `deepseek-v4.1-flash`。
   你可以在 profile 的 `cordis.patch.yml` 里覆盖或追加：

```yaml
- id: token-stats
  config:
    modelAliases:
      'deepseek-flash': 'deepseek-v4.1-flash'
```

> 改动归并规则后缓存要跟着失效——`host.js` 里的 `CACHE_VERSION` 就是干这个的，
> 调整规则时记得 +1，否则磁盘上那份旧缓存仍然"新鲜"，会继续端出没归并的数据。

## HTTP 接口

宿主半边注册两个只读路由，客户端页面就是它们的消费者：

| 路由 | 说明 |
|---|---|
| `GET /token-stats-api/summary` | 聚合结果。有缓存且未过期时直接回缓存；过期则**先回旧数据**并后台重扫（响应带 `stale: true`）；带 `?refresh=1` 时强制重扫并等待 |
| `GET /token-stats-api/status` | 扫描状态（是否在扫、上次扫描耗时、错误、缓存文件路径） |

聚合结果落在 `$DSH_HOME/token-stats/cache.json`，所以重启后首屏也有数据。

## 性能与副作用

- 全量扫描本机约 **6.5 秒**（483 个会话、约 1.4 万步）。扫描是**异步分批**的
  （每 16 个会话 `setImmediate` 让出一次事件循环），不会长时间冻结 Web 界面。
- 插件**只读**会话日志，不写任何会话数据；唯一写入是缓存文件。
- 渲染层不引第三方图表库：热力图是 CSS Grid，趋势图与环形图是手写 SVG。
- 趋势图的平滑用**单调三次插值（Fritsch–Carlson）**，不是普通的 Catmull-Rom。
  后者在「高值骤降到 0」的拐点会过冲，把曲线画到 0 线以下（看起来像负数用量）；
  单调插值先把每点切线夹到不越界，谷底平贴 0 线。`selftest.cjs` 里有对应的回归测试。
- 模型的图表配色绑定在**全量排名**上，不是当前时间范围的排名：否则切一次范围，
  同一个模型就换一种颜色，前后两张图对不上。图例与列表顺序仍按所选范围的用量降序。

## 自检

```bash
node selftest.cjs          # 合成数据单元测试（帧解析 / 版本选择 / 聚合 / 包声明 / 客户端静态检查）
node selftest.cjs --live   # 额外全量扫一遍真实会话库并校验自洽
```

`--live` 会校验两条恒等式：**按天之和 == 总量**、**按模型之和 == 总量**。

## 已知限制

- 报表只统计已落在会话日志里的用量；正在进行的这一步在写盘前不计入。
- 「日均」按**有记录的天数**算，不是自然日跨度。
- 模型步数按天明细精确；环形图的百分比按所选范围重算。
- 客户端插件改动需要重启桌面端才生效（宿主半边可以走 hmr）。
