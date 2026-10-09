# 第三方代码与出处署名

本仓库整体以 MIT 许可发布（见 `LICENSE`）。下面是**非本仓库原创**的部分。

## 1. agent-team-plus —— DeepSeek 官方 Agent Teams 的修改版

`agent-team-plus/` 是 DeepSeek 官方包在 `0.2.0-rc.2` 基线之上的 fork，下列源码文件
为官方文件的逐文件对照抄改（改动点见 `agent-team-plus/README.md` 第 1 节）：

| 本仓库文件 | 上游文件 |
| --- | --- |
| `agent-team-plus/lib/index.js` | `@deepseek-ai/dsh-experimental-agent-team/lib/index.js` |
| `agent-team-plus/lib/invariant.js` | `@deepseek-ai/dsh-experimental-agent-team/lib/invariant.js` |
| `agent-team-plus/lib/tools.js` | `@deepseek-ai/dsh-experimental-tool-agent-team/lib/…`（工具层） |
| `agent-team-plus/cordis.patch.yml` | `@deepseek-ai/dsh-experimental-agent-team-profile/cordis.patch.yml` |

上游许可以及版权声明：

```
MIT License — Copyright (c) 2026 DeepSeek
https://github.com/deepseek-ai/deepseek-harness
（npm: @deepseek-ai/dsh-experimental-agent-team-profile@0.2.0-rc.2,
       @deepseek-ai/dsh-experimental-agent-team@0.2.0-rc.2,
       @deepseek-ai/dsh-experimental-tool-agent-team@0.2.0-rc.2）
```

上游 MIT 许可全文随附在 `agent-team-plus/LICENSE`（含修改声明）。

**刻意未改动的部分**：官方 Web 名册 / 看板客户端包
`@deepseek-ai/dsh-experimental-client-ui-agent-team` 不包含在本仓库内，作为依赖由 DSH
自身提供。

## 2. 行为参考（无代码借用）

- `btw/`（临时提问 /btw）的**交互形态**对齐 Anthropic Claude Code 的 `/btw` 旁支提问；
  实现全部原创，未复制任何 Claude Code 代码。
- `agent-team-plus/` 暴露的团队协作工具语义沿用 DSH 官方 Agent Teams 的对外契约
  （工具名、任务板 id 语义），以便与官方 Web 看板互通。

## 3. 运行时依赖

各插件对 `@deepseek-ai/*` 的引用（`peerDependencies`）**不打包进本仓库**，由使用者本机的
DSH 安装提供；本仓库不含任何 `@deepseek-ai/*` 的完整副本（`agent-team-plus` 的上述四个
文件除外）。
