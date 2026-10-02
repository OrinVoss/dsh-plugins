# @local/dsh-agent-team-plus

DSH Agent Teams 的**本地 fork 组合包**：在官方 `@deepseek-ai/dsh-experimental-agent-team-profile`
基础上做两处改动——

1. **成员上限 8 → 16**（patch 里的 `config.maxMembers: 16`，官方包本体不动）。
2. **新增 `release_teammate` 工具**：成员干完活后由 Lead 让它「散伙」——成员从名册消失、
   名额与名字立刻可复用，之后可以 `spawn_teammate` 雇新的（同名也行）。

上游基线：`0.2.0-rc.2`（域服务 / 工具层 / Web 看板三包源码逐文件对照抄改，只改下面列出的点）。

---

## 1. 改动清单（对照上游）

| 文件 | 相对上游的改动 |
| --- | --- |
| `lib/index.js`（域服务） | ① `teamMemberSnapshotSchema.phase` 枚举加 `"released"`；② 投影折叠 `team/member` 新增 released 分支：只允许 `active/failed → released`，命中后把该成员从 `state.members` **摘除**；③ `TeamRoster.release()` + `TeamService.releaseTeammate()`；④ 邮箱 `dispatchOnce()` 起步处加防护：目标不是「在册且 active」的成员时，把这条排队消息就地标记 delivered（丢弃） |
| `lib/tools.js`（工具层） | ① `TeamTaskId` 改为从同包 `./index.js` 导入（不再依赖官方域包）；② `POLICY` 增补一段散伙说明；③ 新增 `RELEASE_VALUE_SCHEMA` 与 `release_teammate` 工具（工具面 9 → 10） |
| `lib/invariant.js`（不变量副本） | 与域服务逐条同步：枚举 + released 折叠分支；`PACKAGE_NAME` 改为本包名 |
| `cordis.patch.yml` | 关掉官方 `agent-team` / `tool-agent-team` 两行，插入本包两行（域 + 工具），`maxMembers: 16` |
| `package.json` / `icon.svg` / `locale/*` | 包身份与插件页展示信息 |

**刻意不动**：`@deepseek-ai/dsh-experimental-client-ui-agent-team`（Web 名册/看板）。
投影的 wire view 结构完全不变，所以**看板和名册代码零改动**——成员「直接消失」。

---

## 2. `release_teammate` 语义

```
release_teammate({ target: "<成员名>" })   // 仅 Lead 可调用
→ { target: "<成员名>", previousStatus: "running" | "inactive" }
```

执行顺序（全部发生在 Lead 会话日志里，可回放）：

1. 校验调用者是 Lead；目标名存在且相位为 `active` 或 `failed`。
2. **门禁**：目标名下有 `in_progress` 任务 → 拒绝（`TEAM_MEMBER_HAS_TASKS`），
   先 `team_task_update` 把它 reassign / release 掉再散伙。
3. 追加 `team/member`（`phase: "released"`）事件 → 投影把该成员**摘出** `members`。
4. 把「发给该成员且尚未投递」的排队消息逐条标记 `delivered`（丢弃，避免冷启动一个已经散伙的孤儿会话）。
5. 事务提交后：若该成员还活着先 `interrupt` 打断当前回合，再 `drainContinuableChildren`
   停掉它的子会话（失败只写 warn，不影响已落盘的散伙结果）。

**成功即腾坑**：名额计数、名字占用、`resolveActiveMember`、`list_agents`、Web 名册
都只看 `state.members`，所以第 3 步之后这些地方自动干净，不需要任何额外分支。
因此**同名可以再雇**，`send_message`/`interrupt_agent` 对旧名字会报
`TEAM_MEMBER_NOT_FOUND`（这正是「人已经走了」的期望行为）。

### 稳定错误码

| 码 | 触发 |
| --- | --- |
| `TEAM_LEAD_REQUIRED` | 非 Lead 调用 |
| `TEAM_INVALID_TARGET` | `target: "lead"`（Lead 不能散伙自己） |
| `TEAM_MEMBER_NOT_FOUND` | 名字不存在，或已经散伙过（成员已不在名册） |
| `TEAM_MEMBER_NOT_RELEASABLE` | 目标还在 `provisioning`（等它落定再散伙） |
| `TEAM_MEMBER_HAS_TASKS` | 目标名下还有 `in_progress` 任务 |
| `TEAM_DISPOSED` | 服务正在销毁 |

### 已接受的代价（来自「直接消失」这个选择）

- **已完成任务的 `ownerName` 会丢**：任务快照只存 `ownerId`，`ownerName` 是视图派生时从
  `state.members` 现查的；成员被摘除后，`team_task_list` 里这些任务不再显示归属人
  （`complete` 不清 `ownerId`，所以确实会看到空）。任务本身、revision、状态都不受影响。
- **散伙是单人单向门**：用某个会话回放过的日志里一旦有 `released` 事件，就不要再把该会话
  交回**官方**包去折叠——官方枚举不认 `released`，投影会进入 failure（聊天本身不受影响）。
  回退到官方包时，**没用过散伙的会话**不受影响。
- 如果第 5 步的子会话清理失败（5 秒超时），只记 `warn`：该游离子会话已经没有 Team 身份
  （`tryMembership` 返回 undefined），不能再做 Team 操作，进程退出时自然回收。

---

## 3. 部署结构（为什么这样接）

真实运行时，本包落在 `~/.dsh/plugins/agent-team-plus`，并：

1. `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 加
   `"@local/dsh-agent-team-plus": "link:C:/Users/17040/.dsh/plugins/agent-team-plus"`；
2. `dsh.profile.bundles` **追在** `@deepseek-ai/dsh-experimental-agent-team-profile` **之后**
   （patch 层按 bundles 顺序应用；我们的 `disabled: true` 必须晚于官方 `insert` 才能命中那两行）；
3. `profiles/desktop/node_modules/@local/` 下建同名符号链接指向 1 中的目录。

> ⚠️ **不要把官方那条组合包单独关掉**（插件页里的「智能体团队」）。它不只是那两行运行时逻辑：
> ① 它 insert 的 `ui-agent-team` 才是 Web 名册/共享任务看板；② 它禁用了 4 条旧的全局 subagent
> 工具行（`tool-subagent` / `tool-subagent-control` / `tool-subagent-list-agents` /
> `tool-subagent-fork`，定义在 `dsh-base` 里）。单独关掉它 → 看板/名册整个消失，旧 subagent 工具
> 又会和团队工具同时在场。
> **要停用本 fork，请关掉「智能体团队 Plus」（本包）那一开关**，官方两行会自动恢复。

为什么是「官方外壳 + 我们覆盖」，而不是直接改官方那一行？因为补丁方言**不允许改一行的 `name`/`id`**
（`cordis-plugin-include` 的 `applyEntryPatches`：`name` 是断言字段，与目标不符就 `name mismatch … skipping`；
只有除 `id`/`insert`/`name` 以外的字段才 `target[key] = value`）。所以**换实现只有"禁用原行 + 插入新行"
这一条合法路径**。再加上：官方代码在只读的 `app.asar` 里（直接改会被桌面端自动更新整包覆盖、不在任何
git 里、无法回退），以及「我们被版本判定跳过时要有官方兜底」这个需求——三者叠加就是现在这个形状。

模块解析靠 DSH 的拦截层：本包 import 的 `@deepseek-ai/*` 与 `zod` 都写在
`peerDependencies` 里，`routeLinked` 才会把它们重定向到 app.asar 里的**同一份**安装副本
（对象身份一致，Cordis `Service` 基类不会出现两份）。
`test/manifest.test.mjs` 会静态守住这条：**lib 下任何裸导入如果没写进 peers，测试直接挂**。

`dsh-*` peer 一律**精确钉** `0.2.0-rc.2`：DSH 升级后版本不匹配 → 本 bundle 被判定不兼容而
**自动跳过**（只打一条 skip 警告），官方 8 人团队原样接管，不会把桌面端起不来。
重对齐见下一节。

---

## 4. 安装 / 回退

- **回退**：把 `@local/dsh-agent-team-plus` 从 `dsh.profile.bundles` 里删掉，或在插件页把
  「智能体团队 Plus」关掉，即可回到官方行为——**不要反过去关官方那条**（原因见上一节的 ⚠️）。
- **临时关掉失败成员**：`release_teammate` 对 `failed` 成员同样有效——这正是官方行为里
  「失败成员会一直占着名额」的解法。

---

## 5. DSH 升级后的重对齐 SOP

1. 确认新版本的运行时版本号（`F:\dsh\resources\app.asar` 内 `dsh/desktop-runtime.json`
   的 `release.version`）。
2. 从新 asar 抽出这三包并对照本包：
   `@deepseek-ai/dsh-experimental-agent-team/lib/{index.js,invariant.js}`、
   `@deepseek-ai/dsh-experimental-tool-agent-team/lib/index.js`。
3. 把第 1 节表格里的 4 处改动重新打到新版源码上（改动都是**局部**的：枚举、折叠分支、
   两个新方法、一个邮箱防护、一个工具注册、一段 POLICY）。
4. 更新 `package.json` 的 `version` 和 4 个 `@deepseek-ai/dsh-*` peer 到新版本号。
5. 跑 `pnpm test`（等价于 `node test/setup.mjs && node test/run.mjs`）——测试里有
   「peers 完整」「patch 形状」「折叠规则」「散伙门禁」等断言。
6. 重启桌面端，按第 6 节清单过一遍。

---

## 6. 重启后的验收清单

1. `list_agents` 只看到 lead；`spawn_teammate` 两个成员（`worker-a` / `worker-b`）→ 都在名册。
2. `release_teammate({ target: "worker-a" })` → 返回 `{ target: "worker-a", previousStatus: ... }`；
   `list_agents` 里**只剩 lead 与 worker-b**（Web 看板同步消失）。
3. 同一个名字再 `spawn_teammate({ name: "worker-a" })` → 能创建（名字解冻）；名额也复用。
4. 造一个 `in_progress` 任务 assign 给 `worker-b`，再 `release_teammate` → 报
   `TEAM_MEMBER_HAS_TASKS`；任务 reassign / release 之后再散伙成功。
5. `send_message` 给已散伙的名字 → `TEAM_MEMBER_NOT_FOUND`。
6. 一次性雇到 16 个：第 17 个报 `TEAM_MEMBER_LIMIT`（说明上限确实是 16）。
7. 重启桌面端：散伙过的会话仍只剩在册成员（日志回放走 released 折叠，不报 failure）。

---

## 7. 本地测试

```powershell
pnpm test            # = node test/setup.mjs && node test/run.mjs
```

- `test/setup.mjs` 生成包内 `node_modules`：`@deepseek-ai/*` 最小桩，外加从
  `F:\dsh\resources\app.asar` 抽出的**真实 zod**（可用 `DSH_ASAR` 覆盖路径）。
- `test/run.mjs` 在**单进程**里 import 全部 `*.test.mjs`；不用 `node --test`，
  因为 DSH 文件沙箱下 node:test 的 runner 会用管道 stdio spawn 子进程而被拒（EPERM）。
- 覆盖：投影折叠（含 released 折叠与全部拒绝分支）、散伙全流程与门禁、
  邮箱恢复期防护、工具注册与输出契约、peers/patch 静态安全网。

## 8. 已知限制

- 单 Lead、单 Team；`release_teammate` 只解决「名额与名字复用」，不做跨 Team 迁移。
- 已经散伙的成员，其历史消息仍留在日志里（发送者名是当时的快照），不影响交付。
- `stateVersion` 保持 `4`：状态结构没变（成员是被摘除的，不是新相位），所以缓存双向可读；
  只有「日志里出现 `released` 事件」这一件事是回官方包时的单向门。

---

## 9. 本次接线的实测记录（可复现）

- **接线**：`~/.dsh/plugins/agent-team-plus`（16 个文件）；desktop profile 的 `dependencies`
  加 `link:C:/Users/17040/.dsh/plugins/agent-team-plus`；`profiles/desktop/node_modules/@local/`
  下建 **junction**。本机实测：Node 的 `dirent.isSymbolicLink()` 与 `lstat().isSymbolicLink()`
  对 junction 都返回 `true`，所以 `symlinksUnder`/`linkedProfileRoots` 认得它，会走
  「linked 层 → peerDependencies → app.asar 安装副本」的拦截路由（这也是为什么 peers 必须齐全）。
- **预检 1（导入级）**：desktop profile 不能被 CLI 直接 dump——会报
  `error: profile "desktop" is managed exclusively by the Electron application`。
  做法是建一个同构临时 profile（同 `dependencies`、同 `dsh.profile.bundles`，依赖用 junction 铺好），
  跑 `dsh --profile <临时名> --dump-config-schema`：两个 fork 行 `status=schema`
  （模块被真实拦截层解析并 import 成功），全表 `status=error` 行 0 条。校验后删除临时 profile。
- **预检 2（组合级）**：同一个临时 profile 跑 `dsh --profile <临时名> --dump-config`：
  `agent-team` / `tool-agent-team` 两行末尾出现 `disabled: true`（并标注
  `# == @deepseek-ai/dsh-experimental-agent-team-profile, patched by @local/dsh-agent-team-plus`），
  `ui-agent-team` 保持启用，fork 行的 `maxMembers: 16` 生效；stderr 无补丁未命中告警。
- **单测**：`node test/run.mjs` → 31 passed / 0 failed。
- **注意**：预检只能证明「能导入、能组合」，**不能**替代重启后的真机验收（第 6 节清单）。

