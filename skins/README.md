# dsh-skins —— DSH Web GUI 皮肤机制

给 DSH 桌面端 / Web GUI 加的一层「皮肤」机制：把一整套配色以 `--dsw-*` 别名 token 叠加在当前主题之上，
随「设置 → 通用 → 皮肤」切换。目前自带七套皮肤：

| id | 名称 | 色调 | 字体 |
|---|---|---|---|
| `porcelain` | **青花瓷** | 白瓷底 + 单一靛青，冷、净、对比最高 | 宋体（衬线） |
| `tokyo` | **东京夜** | 深靛底 + 蓝紫，深色档最好看 | 等线 |
| `ink` | **水墨** | 纯灰阶零彩度，注意力全给文字 | 楷体 |
| `landscape` | **青绿山水** | 绢黄底 + 石绿赭石，千里江山图色系 | 华文中宋 |
| `latte` | **卡布奇诺** | 柔和暖调 + 深色档淡紫 | 华文细黑 |
| `guofeng` | **中国风** | 宣纸底、墨色字、朱砂红 + 石青 + 描金 | 宋体 |
| `morandi` | **莫兰迪** | 低饱和灰调：雾蓝灰、灰玫瑰、灰米 | 思源黑体 |

每套皮肤都有浅色与深色两档配色，共 14 份完整调色板；七套字体各不相同。

实机截图见 `preview/`：`porcelain-light.png`（青花瓷）、`tokyo-dark.png`（东京夜深色）、
`ink-light.png`（水墨）、`landscape-light.png`（青绿山水）、`latte-light.png`（卡布奇诺）、
`guofeng-light.png` / `guofeng-dark.png`（中国风）、`morandi-light.png`（莫兰迪）、
`skins-row.png`（设置行全貌，含每套皮肤的字体名）、`skin-candidates.png`（选色阶段对比图）。

---

## 它到底做了什么

DSH 的 Web 客户端本来就有一套主题系统（`@deepseek-ai/dsh-client-ui-theme`）：

- 内置 `light` / `dark` 两套基础配色，`system` 跟随系统；
- 基础样式表 `design-platform.css` 在 `body` / `body[data-ds-dark-theme]` 上定义**别名 token**（`--dsw-alias-*`）；
- 客户端服务 `ctx.theme` 提供三个扩展入口：
  - `register(definition)` —— 注册一个**完整主题**（自己带 `colorScheme`，会顶掉用户的浅色/深色选择）；
  - `overrideTokens(source, tokens)` —— 在当前主题之上**叠加一层** token（每个 token 给 `{ light, dark }` 一对值）；
  - `setTheme(id)` —— 切换偏好（只对内置的三个值持久化）。

本插件走 `overrideTokens`：**皮肤是一层，不是一套主题**。用户选的「浅色 / 深色 / 跟随系统」照旧生效，
皮肤只负责换配色，两档配色都在，切换时不会把用户的选择顶掉。

```
皮肤声明(槽位 palette)  →  buildLayer()  →  ctx.theme.overrideTokens()
                                              ↓
                                    ui-layout 呈现器写 body 内联样式
                                              ↓
                              全应用读 var(--dsw-alias-*) 自动变色
```

## 目录

```
dsh-skins/
├── package.json        插件包声明（dsh.client 指向 Web 客户端半边）
├── host.js             Host 半边：空实现，只为让包可被加载
├── client.js           Web 客户端半边：机制 + 七套皮肤 + 设置行 UI
├── test/selfcheck.cjs  Node 自检（不需要浏览器）
├── icon.svg            插件页「已安装」卡片里的图标
├── locale/zh.json      插件页卡片的中文标题与描述（meta.title / meta.description）
├── locale/en.json      同上英文
├── preview/            实机截图
└── README.md
```

`client.js` 里分成 8 段，从上到下依次是：槽位 → token 映射、中性值兜底、字体栈、皮肤注册表、
皮肤展开、样式表、运行时、设置行组件、插件体。

## 字体也跟着换

设计系统把字体收在一个变量上：`--dsw-font-family`。所有字号简写（`--dsw-font-s-14`、
`--dsw-font-xs-13`…）和 markdown 各级标题的 `*-font-family` 子项都写成 `var(--dsw-font-family)`，
连 `--dsw-font-family-brand` 也是 `"Montserrat", var(--dsw-font-family)`。所以**皮肤只覆盖这一个变量，
全站字体一起换**；代码块走 `--ds-font-family-code`，不受影响，等宽字体保持等宽。

皮肤用 `font` 声明字体栈、`fontName` 给设置行显示名字：

```js
font: '"楷体", KaiTi, "华文楷体", STKaiti, serif',
fontName: '楷体',
```

三条约定（自检逐条卡）：

1. 用**本机已装的家族名**，中文名与英文名各写一份（不同系统认的名字不一样）；
2. 结尾落到通用族（`serif` / `sans-serif`），装不上也不会变方框；
3. 带空格的家族名加引号。

## 覆盖范围

一套皮肤会展开成 **93 个 token**，覆盖：

- 画布与表面：`bg-base` / `bg-layer-1..3` / `bg-overlay` / 侧栏 / 气泡 / 输入框 / 选中态 / 骨架屏
- 文字：`label-primary` / `-secondary` / `-tertiary` / `-caption` / `-dimmed` / 链接 / 菜单图标
- 字体：`--dsw-font-family`（全站字体，字号简写与 markdown 都引它）
- 边框：`border-l1..l4`
- 品牌与交互：`brand-primary` / `brand-text` / 主按钮三态 / 悬停 / 按下 / 幽灵按钮 / 对比按钮
- 代码与 Markdown：代码块、块头、行内代码、引用、标签、占位
- 状态：成功 / 警告 / 错误 / 空闲 / 业务色
- 浮层与反馈：toast、tooltip、菜单材质与吸顶分组、滚动条
- 派生（用 `color-mix` 现算，不用手填）：深潜文字、tooltip 键帽、悬停强调、危险悬停、文档选区
- 标识：`--dsw-skin-id`、`--dsw-skin-accent`、`--dsw-skin-font` —— 别的插件想知道「现在挂着哪套皮肤、什么字体」时读它们

## 加一套自己的皮肤

往 `client.js` 的 `SKINS` 数组里加一个对象就行，不用碰运行时、UI 和样式表：

```js
{
  id: 'my-skin',
  name: '我的皮肤',
  hint: '一句话描述',
  font: FONT_STACKS.serif,                     // 可选：字体栈
  fontName: '宋体',                             // 可选：设置行里显示的字体名
  swatch: ['#aabbcc', '#ddeeff', '#112233'],   // 设置行里的三个色卡
  light: { canvas: '#fafafa', surface: '#ffffff', /* ... 其余槽位 */ },
  dark:  { canvas: '#111111', surface: '#1a1a1a', /* ... */ },
  css: 'body[data-dsh-skin="my-skin"]::before{/* 可选材质，选择器记得带前缀 */}'
}
```

未填的槽位由 `SCHEME_DEFAULTS` 兜底（悬停层、发丝边框、滚动条这类不随色调变的值）；
漏填**必需**槽位会在加载时报错并列出缺了哪些。

## 持久化与优先级

- 选择记在浏览器 `localStorage` 的 `dsh-skins:active`；桌面端页面源固定，重启后自动恢复。
  持久化的 id 若已失效（皮肤被删掉），启动时会被忽略并回落到默认。
- 皮肤层是**最后叠加**的，且 token 由呈现器写成 `body` 内联样式，优先级高于一切样式表；
  卸载插件或切回「默认」时，`overrideTokens` 返回的 disposer 会把这一层整层摘掉，不留残余。
- 皮肤不影响「外观」里的浅色/深色/跟随系统，也不影响正文字号。

## 对外服务

插件以 `skins` 服务暴露机制，别的客户端插件可以：

```js
ctx.skins.list()          // [{ id, name, hint, fontName, swatch }]
ctx.skins.get()           // 当前皮肤 id，'default' 表示不叠加
ctx.skins.set('porcelain')// 切换
ctx.skins.subscribe(fn)   // 返回退订函数
```

## 安装

本插件现在是 **`dsh-style-extras`（样式扩展）组合包的成员**：加载行由组合包的
[`cordis.patch.yml`](../style-extras/cordis.patch.yml) 声明（`insert: id: skins`），
本包自己不再往 profile 的 patch 里 insert，也没有 `dsh.bundle`。

profile 侧需要两处声明：

1. `profiles\desktop\package.json` 的 `dependencies`：`"dsh-skins": "link:C:/Users/17040/.dsh/plugins/skins"`
2. `profiles\desktop\package.json` 的 `dsh.profile.bundles` 里列出 **`dsh-style-extras`**（不是本包）

> ⚠️ 不要再往 profile 的 `cordis.patch.yml` 里 insert `id: skins`——同一 id 插两次会加载两遍。

装完后侧栏「插件」页的「已安装」里会出现「样式扩展」卡片，点进去能看到**皮肤**这一行
（图标来自本包的 `icon.svg`，标题/描述来自 `locale/zh.json` 的 `meta`）。

客户端半边的更新需要**刷新页面**（`Ctrl+R`）才会重新拉取；只改配色时刷新一次即可。

## 自检

`test/selfcheck.cjs` 会在 Node 里用桩件加载 `client.js`（不需要浏览器、不需要桌面端），
覆盖 **239 项**：模块形状、皮肤注册表、字体栈约定（通用族收尾 / 引号 / 两档同值）、
token 层形状（每套 93 个 token × `{light,dark}` 对）、装配与切换、旧层销毁、
持久化与恢复、陌生 id 忽略、设置行渲染与点击切换，以及 7 套皮肤 × 浅深两档的
WCAG 对比度（正文 ≥ 7、次要 ≥ 4.5、按钮前景 ≥ 4.5、链接 ≥ 4.5）。

```powershell
node test\selfcheck.cjs
```
