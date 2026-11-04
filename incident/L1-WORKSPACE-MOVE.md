# L1 方案 A：把 Agent 的工作区整体挪出仓库

**状态**：**已执行**（2026-11-04 13:00Z）。执行记录见本文末尾「六、执行记录」；
对外口径见 `incident/RESUME.md` 顶部的 2026-11-04 13:00Z 段。
**前置**：等 2026-11-04 的 F4 × deepseek 那一轮跑完——挪工作区会打断正在跑的轮次。

## 一、这个方案到底做到什么（先把话说准，别又写一句假话）

原话「仓库整体不在 cwd 的祖先链上」**不成立**：`cd /` 之后什么都在，任何路径都可达。
A 真正做到的是**降低误触**，不是建立不可达：

|                                                | 现状                                                                                                   | A 之后                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| 答案键在哪                                     | `incident/`（= cwd 的**上一层**）：`RESUME.md`、`faults/`、`runs/ground-truth/`、11 份同故障类历史报告 | 仓库里，但离工作区几层之外；Agent 提示词里不再出现仓库路径 |
| Agent 一次 `ls ..`                             | 直接看到答案键所在的目录                                                                               | 看不到（那层只有新工作区）                                 |
| 一次 `find .. -maxdepth 2`（0324Z 那轮真做过） | 列全 11 份历史报告名，其中 5 份是 F2 族                                                                | 列不到仓库里的东西                                         |
| 提示词里的绝对路径                             | `LAB="node <repo>/incident/workspace/tools/..."`（指向仓库内部）                                       | 指向新工作区，不再指向仓库                                 |

**A 不解决的**：外仓 git 历史里的旧副本（`git show HEAD~n:incident/runs/ground-truth/F2.json` 仍拿得到）、
家目录（`~/.config/miniclaw-lab/lab.env` 那类路径 Agent 越界读到过）。
**硬边界**要么给 Bash 工具加沙箱，要么做 uid 隔离——底座目前两者都没有。
所以这一轮做完，边界仍然是「Agent 自觉 + 通道审计事后判污染」，只是**邻接性没了**。

### 可机械检查的不变量（建议做成闸门 W，别只写在文档里）

> **W**：从工作区根往上 **2 层**以内，任何目录的条目里都不出现答案键文件
> （`ground-truth/*.json`、`faults/*.mjs`、`runs/agent-report-*.md`、`runs/score-*.json`、`RESUME.md`）；
> 且工作区提示词（`identity.json` 四段 prompt）里**不含仓库根路径**。

W 是可执行的检查，不是比喻。挪完之后 W 必须为真；以后谁把工作区挪回仓库里，W 立刻变红。

## 二、改动面（每一处：现在是什么 → 变成什么 → 怎么验）

| #   | 位置                                                                          | 现在                                                                                       | 变成                                                                                       | 验证方式                                                                                                                                                                                                       |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `incident/workspace/`（含它自己的 `.git`，即服务仓库）                        | 仓库内，`.gitignore` 第 91 行忽略                                                          | 新路径                                                                                     | `git -C <new> log -1` 仍是 `34b43c8` 之后的链                                                                                                                                                                  |
| 2   | `registered_groups.custom_cwd`（DB，1 行）                                    | `<repo>/incident/workspace`                                                                | 新路径                                                                                     | `PATCH` 不行（`GroupPatchSchema` 无 `custom_cwd`，见 RESUME「搬家静默损坏」第 3 条）→ **停服务 → UPDATE → 起服务**                                                                                             |
| 3   | `config/mount-allowlist.json` → `allowedRoots`                                | 仓库根（注释写着「hosts the incident-lab workspace」）                                     | 新工作区路径                                                                               | Host 模式 Runner 启动时会校验 `custom_cwd` 是否在允许根下（`src/container-runner.ts:2361`），**不在就静默拒绝启动**                                                                                            |
| 4   | `incident/docker-compose.yml`                                                 | `build.context: ./workspace/target-service`、`volumes: ./workspace/logs:/app/logs`         | 绝对新路径                                                                                 | `docker inspect target-service` 的挂载源；P2 闸门也会查                                                                                                                                                        |
| 5   | `incident/lab.sh`                                                             | 用 `-f "$LAB_DIR/docker-compose.yml"`（相对挂载按 compose 文件位置解析）                   | 不用改（compose 文件位置不变）——但 compose 里若写绝对路径，就与 #4 重复                    | `incident/lab.sh ps`                                                                                                                                                                                           |
| 6   | `incident/agent-profile/identity.json` → `tools_prompt` 的 `LAB=` 绝对路径    | 仓库内路径                                                                                 | 新工作区路径                                                                               | 改完必须跑 `node incident/runs/sync-agent-profile.mjs`（运行时读的是库里的行，不是文件）；DB 里有 `agent_profiles.tools_prompt`（1 行）与 `agent_profile_prompt_versions.tools_prompt`（6 行历史版本，不用改） |
| 7   | `incident/runs/run-round.mjs`                                                 | `const WORKSPACE = join(LAB, 'workspace')`；P2 断言「挂载源在 `join(ROOT,'incident')` 下」 | 新路径 + 断言改成「挂载源 == 新工作区」                                                    | 闸门 P2                                                                                                                                                                                                        |
| 8   | `incident/runs/channel-audit.mjs`                                             | `WORKSPACE`、`ALLOWED_ROOTS = [WORKSPACE, SESSION_ROOT, '/tmp']`                           | 新路径                                                                                     | 通道审计的越界判定直接依赖它；改错会把越界读判成正常                                                                                                                                                           |
| 9   | `incident/runs/leak-scan.mjs`                                                 | `REPO = join(ROOT, 'incident/workspace/target-service')`（服务仓库工作树那一面）           | 新路径                                                                                     | 漏改 → 服务仓库那一面「扫不到」→ exit 1（这是好事：漏改会响）                                                                                                                                                  |
| 10  | `incident/runs/rebuild-service-history.mjs`                                   | `REPO = join(ROOT, 'incident/workspace')`                                                  | 新路径                                                                                     | 历史重建脚本（重建链时用）                                                                                                                                                                                     |
| 11  | `incident/runs/metrics-range-control.mjs`                                     | `cli = <repo>/incident/workspace/tools/incident-readonly.mjs`                              | 新路径                                                                                     | 负对照 5/5                                                                                                                                                                                                     |
| 12  | `incident/runs/channel-audit-control.mjs`                                     | 夹具里硬编码 `cd <repo>/incident/workspace && node tools/...`                              | 新路径                                                                                     | 负对照 6/6                                                                                                                                                                                                     |
| 13  | `incident/runs/round-table.mjs` / `score-report.mjs` / `calibrate-scorer.mjs` | 目前不引用工作区路径（只读 manifest 与 score）                                             | 大概率不用改                                                                               | 跑一遍指标表脚本确认                                                                                                                                                                                           |
| 14  | 证据里的路径占位符                                                            | `<repo>` / `<home>` 两个                                                                   | 需要第三个（如 `<workspace>`），否则新工作区的绝对路径会被脱敏成 `<repo>/...` 之外的怪东西 | **脱敏目前是手工的**（没有脚本！）——建议顺手把脱敏写成脚本，否则这步每次都靠人记得                                                                                                                             |
| 15  | `agent_builder_drafts.definition_json`（DB，1 行）                            | 含旧路径                                                                                   | 与本轮无关（草稿），可不动                                                                 | —                                                                                                                                                                                                              |
| 16  | `messages.content`（DB，2 行）                                                | 含旧路径                                                                                   | 聊天历史会被 `clear-history` 清掉                                                          | —                                                                                                                                                                                                              |

**不用动的**：只读 CLI 自己（`LOG_DIR` / `REPO` 都按 `import.meta.url` 相对定位）、
`data/sessions/<folder>`（Miniclaw 自己的会话目录，不是工作区）、`data/skills/<uid>`、
`~/.config/miniclaw-lab/lab.env`（旋钮文件，仓库外）。

## 三、执行顺序（顺序错了会把台子弄成半死状态）

1. **停服务**（`node dist/index.js` 的进程；只杀监听进程：`lsof -ti:3000 -sTCP:LISTEN | xargs kill`）。
2. `mv incident/workspace <新路径>`（**必须带 `.git` 一起搬**；服务仓库的历史不能断）。
3. 改 `custom_cwd`（DB UPDATE）、`mount-allowlist.json`、`docker-compose.yml`、
   `identity.json`（+ `sync-agent-profile.mjs`）、四个脚本里的路径常量。
4. `incident/lab.sh up -d --build`（重建容器：镜像构建上下文变了，必须重建）。
5. **起服务**，跑 `node incident/runs/run-round.mjs --fault F4 --dry-run`：
   P1–P12 全过 = 迁移成功（这几个闸门正好覆盖了上面 13 处）。
6. 跑闸门 W（新增）确认不变量成立。
7. 复核件里写明：**这一轮之后，路径脱敏占位符多了一个**。

## 四、回滚

`mv <新路径> incident/workspace` + 反向改回上表 13 处 + `lab.sh up -d --build` + 重启服务。
（服务仓库的历史在搬家过程中不受影响，回滚不损失任何提交。）

## 五、做完之后的诚实口径

对外可以说：「Agent 的工作区与答案键**不再相邻**，工作区提示词里不再出现仓库路径，
且有一条可执行的闸门 W 保证这一点」。
**不能**说：「答案键对 Agent 不可达」——外仓 git 历史与家目录仍然是可达的。

## 六、执行记录（2026-11-04）

### 6.1 结果

工作区已从 `<repo>/incident/workspace` 搬到 `/mnt/my-work/incident-lab/workspace`，
连它自己的 `.git` 一起搬（服务仓库历史链不断：`git log` 仍到 `34b43c8` 之后的链）。

**新增了路径唯一真相源 `incident/lab-paths.json`**：7 个脚本不再各自写死工作区路径。
搬家从此是「改一个文件 + 重跑 `sync-agent-profile.mjs` + `lab.sh up -d --build`」，
而不是「改 8 个常量，漏一个就静默损坏」。

### 6.2 实际改动 17 处（计划 14–16 + 执行中新发现 2 处）

| #      | 位置                                                                  | 改法                                                                                                                                                        |
| ------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1      | `incident/workspace/`                                                 | `mv` 到 `/mnt/my-work/incident-lab/workspace`（含 `.git`）                                                                                                  |
| 2      | `registered_groups.custom_cwd`（DB 1 行）                             | 停服务 → UPDATE → 起服务（`GroupPatchSchema` 无此字段）                                                                                                     |
| 3      | `config/mount-allowlist.json`                                         | 仓库根条目换成新工作区路径（`~` 条目保留——家目录仍可达，见 §五）                                                                                            |
| 4      | `incident/docker-compose.yml`                                         | build context 与 logs 挂载改成绝对路径                                                                                                                      |
| 5      | `incident/lab.sh`                                                     | 不用改（compose 位置不变）                                                                                                                                  |
| 6      | `incident/agent-profile/identity.json` + `sync-agent-profile.mjs`     | `LAB=` 换成新工作区路径；同步入库（profile v8 → v9）                                                                                                        |
| 7      | `incident/runs/run-round.mjs`                                         | `WORKSPACE` 读 `lab-paths.json`；**P2 断言**从「挂载源在仓库下」改成「挂载源 == 工作区」                                                                    |
| 8      | `incident/runs/channel-audit.mjs`                                     | `WORKSPACE` 读 `lab-paths.json`（越界判定直接依赖它）                                                                                                       |
| 9      | `incident/runs/leak-scan.mjs`                                         | `REPO` 读 `lab-paths.json`                                                                                                                                  |
| 10     | `incident/runs/rebuild-service-history.mjs`                           | `REPO` 读 `lab-paths.json`                                                                                                                                  |
| 11     | `incident/runs/metrics-range-control.mjs`                             | CLI 路径读 `lab-paths.json`                                                                                                                                 |
| 12     | `incident/runs/channel-audit-control.mjs`                             | 夹具路径读 `lab-paths.json`；A/D/E 三例改成**真能落到答案键**的相对路径；新增 I 例                                                                          |
| 13     | `round-table.mjs` / `score-report.mjs` / `calibrate-scorer.mjs`       | 不用改（不引用工作区路径）                                                                                                                                  |
| 14     | 证据路径占位符                                                        | 新增第三个占位符的**需求**仍在（脱敏仍是手工的，见 §6.5）                                                                                                   |
| 15     | `agent_builder_drafts.definition_json`                                | 不动（草稿，与本轮无关）                                                                                                                                    |
| 16     | `messages.content`                                                    | 不动（聊天历史会被 `clear-history` 清掉）                                                                                                                   |
| **17** | **`incident/faults/faults.mjs`（计划里没列）**                        | `TARGET_SERVICE_DIR` 默认值是 `../workspace/target-service/`（相对 `incident/`）→ 改读 `lab-paths.json`。**漏改 = 注入脚本往不存在的目录写 = 注入静默失败** |
| **18** | **`data/config/container-env/flow-mvkttud1-ah1b.json`（计划里没列）** | `INCIDENT_LAB` 指向旧 CLI 路径 → 改成新路径。**漏改 = Agent 的 `$INCIDENT_LAB` 断链**                                                                       |

> 第 17、18 两处是**执行时才发现**的：计划是从「读代码找路径字面量」列出来的，
> 而这两处一个是**相对路径**（grep `incident/workspace` 找不到，因为写的是 `../workspace/...`），
> 一个在 `data/` 下（不在 `incident/` 树里）。**计划漏项 = 静默损坏**，所以照单执行不算数，
> 执行中每一步都要自己再查一遍。

### 6.3 验证

| 检查                                                    | 结果                                                  |
| ------------------------------------------------------- | ----------------------------------------------------- |
| `node incident/runs/run-round.mjs --fault F4 --dry-run` | **P1–P12 全过**                                       |
| `docker inspect target-service` 挂载源                  | `/mnt/my-work/incident-lab/workspace/logs->/app/logs` |
| `app.log` 3 秒内增长                                    | 3252362 → 3252814 字节                                |
| 闸门 W `incident/runs/gate-w-workspace-isolation.mjs`   | 通过（退出码 0）                                      |
| 闸门 W 负对照 `gate-w-control.mjs`                      | **8/8**                                               |
| `channel-audit-control.mjs`                             | **7/7**（新增 I 例：短相对跳不再指向答案键）          |
| `metrics-range-control.mjs`                             | 5/5                                                   |
| `leak-scan.mjs`                                         | 正常拦截（上一轮历史还在，真实轮次先清）              |

### 6.4 闸门 W 的两个设计点（写下来免得以后改坏）

1. **「不在祖先链上」用 `path.relative` 判，不用字符串前缀判**：
   第一版用字符串前缀，把 `/mnt/my-work/incident-lab` 误判成 `/mnt/my-work/ai_coding`
   的子目录 → 新工作区被判成「还在仓库里」。**这个错是负对照抓到的**。
2. **提示词检查不只看「有没有仓库路径」，还看「LAB 指向哪」**：
   搬家后如果 `tools_prompt` 还指着旧路径，Agent 会去一个不存在的目录找 CLI——
   那不是污染，是**断链**，同样要红。

### 6.5 没做的（记下来，别以为已经解决）

- **脱敏仍是手工的**（§二 第 14 项）：证据件里的路径占位符现在需要第三个
  （`<workspace>`），而写脱敏这件事**仍然没有脚本**。这是 L1 留下的最大尾巴：
  上一轮刚因为「手工脱敏」让 `rescore-all.mjs` 静默跳过一轮。
- **家目录仍然可达**（`mount-allowlist.json` 的 `~` 条目保留）：`~/.config/miniclaw-lab/lab.env`
  那条路径还在，通道审计只能事后判污染。这属于实验室侧 L5（旋钮文件权限收紧）。
- **外仓 git 历史里的旧副本仍在**：`git show HEAD~n:incident/runs/ground-truth/F2.json` 照旧拿得到。
  要断这一条只能给 Bash 工具加沙箱或做 uid 隔离，底座目前两者都没有。
