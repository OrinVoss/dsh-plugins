# dsh-sysmon

DSH 的**系统状态**插件：侧栏底部常驻一排占用圆环——**CPU / 内存 / 磁盘 / 核显 / 独显**，
悬停能看到各自明细（磁盘那个还带读写 MB/s）。侧栏收窄时自动收敛成一个 CPU 圆环。
数据由宿主半边直接读系统计数器。

```
侧栏底部 sidebar.footer.action ──► 圆环排（CPU / 内存 / 磁盘 / 核显 / 独显）
                                            │ fetch /sysmon-api/sample（每秒）
                                            ▼
                     host.js：Node 内置 os / 系统计数器采样 ──► JSON
```

## 刷新节奏（2026-11-01 提速）

采样分**两路**，因为两者成本差两个数量级：

| 数据 | 来源 | 频率 |
| --- | --- | --- |
| CPU 使用率 / 内存 | Node `os.cpus()` 差分 + `os.totalmem/freemem`（零成本，毫秒级） | **500ms**（客户端轮询，宿主每次当场算） |
| 磁盘 IO / GPU | PowerShell `Get-Counter` + `nvidia-smi`（脚本里三次 `Start-Sleep`，一次约 700ms–1s） | 后台 **2000ms** 慢刷，接口永远只返回上一次的值，**不阻塞** |

要点：**不要**为了"更跟手"去缩小 PowerShell 那条的间隔——那等于每秒开两次 PowerShell，CPU 与内存占用反而成为干扰项。
快数据走 `node:os` 之后，500ms 轮询的额外开销可以忽略；慢数据用上一次的缓存，磁盘/GPU 的 1–2s 滞后看不出来。

调参位置：`client.js` 的 `SAMPLE_MS`（轮询）、`host.js` 的 `SLOW_TTL_MS`（慢刷 TTL）。

## 它做什么

- **宿主半边**（`host.js`）注册两个只读路由：
  - `GET /sysmon-api/sample` —— 一次采样：CPU 使用率、内存、磁盘 IO、各 GPU 占用。
  - `GET /sysmon-api/width` —— 侧栏可用宽度，供客户端决定圆环排布（宽＝五个环，窄＝一个 CPU 环）。
- **客户端半边**（`client.js`）往 `sidebar.footer.action` 插这排圆环，按采样值画占用，
  每个环带 `title` 悬停明细（如 `系统监控 · CPU 12%`、`磁盘 C: D: F: 0% ↓ 0 MB/s ↑ 0.3 MB/s`）。
  **它是纯展示，没有点击展开的面板。**
- 只用 Node 内置模块与 `ctx.webServer`，不 import 任何 `@deepseek-ai/*`；配色全部走
  `--dsw-*` token，因此**跟随皮肤与浅深主题**。

## 安装

本插件是 **`dsh-style-extras`（拓展包）组合包的成员**：加载行由组合包的
[`cordis.patch.yml`](../style-extras/cordis.patch.yml) 声明（`insert: id: sysmon`），
本包自己不声明 `dsh.bundle`。

profile 侧需要两处声明：

1. `profiles\desktop\package.json` 的 `dependencies`：`"dsh-sysmon": "link:C:/Users/17040/.dsh/plugins/sysmon"`
2. `profiles\desktop\package.json` 的 `dsh.profile.bundles` 里列出 **`dsh-style-extras`**（不是本包）

装完后侧栏「插件」页的「已安装」里会出现「拓展包」卡片，点进去能看到**系统状态**这一行
（图标来自本包的 `icon.svg`，标题/描述来自 `locale/zh.json` 的 `meta`）。
