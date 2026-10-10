# dsh-style-extras —— 「拓展包」组合包

把五个自研插件收在**一个组合包（bundle）**里的容器，让它们在侧栏**「插件」页的「已安装」**
里是**一张卡片**，点进去是五行成员，各自带开关；停用整张卡片＝五行一起停。

| 成员 | 包 | 干什么 | 加载行 id |
|---|---|---|---|
| **Token 用量统计** | `dsh-token-stats` | 会话日志 `usage` 的热力图 / 趋势图 / 模型环形图 | `token-stats` |
| **系统状态** | `dsh-sysmon` | 侧栏底部的一排圆环：CPU / 内存 / 磁盘 / 核显 / 独显 | `sysmon` |
| **皮肤** | `dsh-skins` | 叠加在浅/深主题上的 7 套配色层（设置 → 通用 里选） | `skins` |
| **临时提问** | `dsh-btw` | 右侧栏「开始」页的旁支提问卡片（`/btw`） | `btw` |
| **消息撤回 / 编辑** | `dsh-message-edit` | 撤回 / 编辑已发送的用户消息（原生操作行加两个图标钮） | `message-edit` |

## 它到底做了什么

DSH 的「组合包」= 一个包自带 `dsh.bundle.patch`，指向自己的 `cordis.patch.yml`；
profile 的 `dsh.profile.bundles` 里**选中这个包**，它才会出现在插件页，并且它的 patch 里
`insert:` 的行就会变成卡片里的成员行（官方源码里 `declaredRows()` 读的就是这份 patch）。
本包自己不注册任何工具 / 服务 / 面板，只贡献这一份 patch：

```
dsh-style-extras/cordis.patch.yml
  ├─ insert: id: token-stats   name: dsh-token-stats   (+ cacheTtlMs / warmupOnStartup)
  ├─ insert: id: sysmon        name: dsh-sysmon
  ├─ insert: id: skins         name: dsh-skins
  ├─ insert: id: btw           name: dsh-btw
  └─ insert: id: message-edit  name: dsh-message-edit
        │
        ▼
插件页「已安装」→ 一张「拓展包」卡片 + 五行成员，各自开关
```

五个成员**仍然是各自独立的包**（profile 的 `dependencies` 里各自 `link:`），只是不再自己
声明 `dsh.bundle`、也不再持有自己的 `cordis.patch.yml`；这样同一 id 只会被插入一次。

## 目录

```
style-extras/
├── package.json        组合包声明：dsh.bundle.patch + icon + locale 导出
├── index.js            空模块（本包不被当作插件加载，只提供 patch）
├── cordis.patch.yml    五条 insert（唯一的加载行声明处）
├── icon.svg            卡片图标（包裹箱）
├── locale/zh.json      卡片的中文标题与描述（meta.title / meta.description）
├── locale/en.json      同上英文
├── selfcheck.cjs       Node 自检：包声明 / patch / 元信息 / 五个成员是否就位
└── README.md
```

成员包在本包的**同级目录**（装好后都在 `~/.dsh/plugins/` 下）：`token-stats/`、`sysmon/`、
`skins/`、`btw/`、`message-edit/`，另有独立组合包 `memory/`（记忆插件，不属于本包）。

## 安装

profile（`~/.dsh/profiles/desktop`）侧三处：

1. `package.json` 的 `dependencies` 里，五个成员与本包各自 `link:`：

   ```json
   "dsh-token-stats": "link:C:/Users/17040/.dsh/plugins/token-stats",
   "dsh-sysmon": "link:C:/Users/17040/.dsh/plugins/sysmon",
   "dsh-skins": "link:C:/Users/17040/.dsh/plugins/skins",
   "dsh-btw": "link:C:/Users/17040/.dsh/plugins/btw",
   "dsh-message-edit": "link:C:/Users/17040/.dsh/plugins/message-edit",
   "dsh-style-extras": "link:C:/Users/17040/.dsh/plugins/style-extras"
   ```

2. `package.json` 的 `dsh.profile.bundles` 里列出 **`dsh-style-extras`**
   （成员包名**不要**写进去，它们不是组合包）。

3. `cordis.patch.yml` 里**不要**再 insert `token-stats` / `sysmon` / `skins` /
   `btw` / `message-edit` ——行由本包的 patch 声明，同 id 插两次会加载两遍。

**生效方式**：重启桌面端（组合包的构成与客户端模块图都在启动时组装）。

## 单独覆盖某一行

profile 的 `cordis.patch.yml` 仍可按 id 覆盖成员配置或单独停用；bundle patch 先应用、
用户 patch 后应用，后者胜：

```yaml
- id: token-stats
  config:
    cacheTtlMs: 600000
- id: skins
  disabled: true      # 只关皮肤，其余四个照常
```

## 自检

```powershell
node selfcheck.cjs
```

覆盖：包声明（bundle patch / 图标 / locale 导出）、patch 的五条 insert 与配置、patch 内无重复 id、
本包与五个成员的中英 `meta`、六个 `icon.svg`（存在、是 SVG、≤256 KiB、不依赖 `currentColor`）、
以及五个成员是否都已 remove `dsh.bundle`。
**项数随结构变化，以实际输出为准**（别再写死数字）。
