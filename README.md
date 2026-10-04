# 本机自研 DSH 扩展（插件仓库）

各子目录是一个插件包（`memory` / `pet` / `skins` / `style-extras` / `sysmon` / `token-stats` / `btw` / `agent-team-plus`）。
改完：`git add -A; git commit`（只本地提交、不推送）。

## tools/ —— 不属于任何插件包的小工具

- `tools/readasar.cjs`：从 `F:\dsh\resources\app.asar` 里读文件（list / cat / dump / grep）。
  DSH 桌面端的前端产物与设计系统 token 都在 asar 里、仓库里没有源码；核对「官方到底用什么值」
  （如 `--dsw-radius-md` 是 8 还是 12、官方卡片底色是哪个 token）时用它，比凭印象靠谱。
  用法见文件头注释；asar 头是**两层 pickle**，`数据区 = 8 + headerSize`（照常见示例把
  `readUInt32LE(4)` 当 jsonLen 会解析失败）。
- 这些工具**不参与**插件加载，只是本机维护脚本；不进 `dsh.profile.bundles`、也不进 hmr 的 root。
