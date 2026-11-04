# L1 方案 A：把 Agent 的工作区整体挪出仓库

**状态**：待执行（2026-11-04 用户拍板选 A）。
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
