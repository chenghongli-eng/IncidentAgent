# IncidentAgent — 断点存档

最后更新：2026-10-26 16:40。本文件是**唯一下次会话的入口**，先读它再动手。

## 一句话状态

**F2 正例（发布导致）已跑通；F4 对照组（发布不导致）四条判定标准 4/4 通过。**
本轮做的事：把 04:32 那次复盘的**答案泄漏**查出来并堵上，重建了一条干净的
F4 时间线。**通道合规复跑未执行**（用户叫停，理由是投入产出比不划算），
改为直接出简历成稿。

简历包在仓库外：`/home/fs-user/Desktop/文档/overleaf/miniclaw_incident相关/`
（`paste-ready-最终版.md` 是成稿，`claim-ledger.json` 是唯一放行依据）。

发现的泄漏有六处，都不是 Agent 的错，是实验台自己的：

| 泄漏点 | 泄漏内容 | 处理 |
| --- | --- | --- |
| `incident/faults/faults.mjs` | 逐条列出注入了哪些故障、注入了什么代码 | 移出 Agent 工作区 |
| `incident/runs/agent-report-*.md`、`incident/RESUME.md` | 前两轮的分析结论 | 移出 Agent 工作区 |
| **F2 提交的 commit message** | 正文写着 `Fault-F2: unchecked downstream call raises NPE` | 重建服务仓库历史，去掉标签 |
| **git 通道连着实验台自己的历史** | `feat(incident): add fault-injection lab…` 等提交 | 工作区独立成仓，通道只看得到服务历史 |
| **`.env` 里的注释** | 写着「F2 已部署但休眠、旋钮才是触发源」 | 注释清空，只留旋钮值 |
| **聊天历史注入** | Agent 新 session 会把上一轮报告注入 prompt | 清空工作区聊天记录与 session |

最严重的是第三条：**04:32 那份报告里写的「commit `eed747c` 再次引入 F2 缺陷」，
"F2" 这个词是从 commit message 里读到的**，不是 Agent 自己推出来的。
结论虽然对，但取证过程被喂了答案——这条证据链不能直接拿来支撑简历 claim。

**【2026-10-26 16:xx 追加】同一处泄漏也污染了 02:22Z 的 F2 正例轮**：
`incident/runs/agent-report-2026-10-26T0222Z.md` 第 61 行把
`commit body 同为 Fault-F2: unchecked downstream call raises NPE`
当作证据来源引了出来，根因段也直接写出「删除判空兜底 → 下游返回 null → NPE」
这一机制——与泄漏正文的一句话摘要重合。所以 F2 正例轮同样只能证明
「诊断流程与证据链跑通」，不能证明「Agent 独立推出了失效机制」。
台账 `claim-incident-101` 已补上同款披露（此前只有 102 有）。

剩下的：① 通道合规复跑（未做，按需再启动）；② 重定义 F5；③ 只读 MCP 工具通道。

## 本轮新增：答案泄漏清理与通道合规复跑

### 为什么必须重做实验台（不是"洁癖"）

评测里要证明的是「**Agent 从证据推出根因**」。如果答案在通道里，
结论对也说明不了任何事——只能说明它会读题。

### 工作区重构成什么样

```
incident/                    ← 实验台控制面（Agent 看不见）
├── faults/                  ← 故障清单 + 注入脚本
├── runs/                    ← 历次报告、聊天记录归档、session transcript
├── skills/                  ← skill 源文件
├── lab.sh / lab.env.example ← compose 包装器 + 旋钮模板
└── workspace/               ← ★ Agent 的工作区（= 它 shell 的 cwd）
    ├── .git/                ← 独立仓库：只有服务的历史
    ├── tools/incident-readonly.mjs   ← 唯一观测通道
    ├── target-service/      ← 被诊断的源码
    └── logs/                ← 容器日志挂载点
```

`workspace/` 在外层仓库的 `.gitignore` 里，自带一个 git 仓库。
这样 Agent 在工作区里执行 `git log` 时，git 停在 `workspace/.git`，
**看不到外层仓库历史**（外层历史里有 fault-injection / resume checkpoint 等提交）。

### 旋钮文件挪出仓库

`~/.config/miniclaw-lab/lab.env`（chmod 600）。`incident/lab.sh` 强制
`docker compose --env-file`，找不到 env 文件直接报错退出——因为 `docker compose`
在找不到 `.env` 时会**静默重置成 compose 文件里的默认值**，那等于凭空造出一个故障。
所有 compose 调用都必须走 `lab.sh`。

### 服务仓库历史（Agent 能看到的那三条）

```
c8d12f2  2026-10-19T10:12Z  feat(service): add order and profile read endpoints
e78a1c3  2026-10-21T14:35Z  chore(service): add downstream client, load driver and actuator exposure
409d265  2026-10-26T07:23Z  feat(order): enrich response with downstream shipping address   ← 部署的那条
```

没有 `Fault-` 标签，没有回滚/重打的对子，没有实验台自己的提交。

### 干净的 F4 时间线（本轮重建）

| 时刻 (UTC) | 事件 |
| --- | --- |
| 07:23:25 | 提交 `409d265`（F2 代码上线前的最后一次提交） |
| 07:29:36 | 容器重建，**timeout=2000** → 部署生效（T_dep） |
| 07:29:44 | 应用就绪 |
| 07:29–07:52 | **健康窗口 22 分钟，0 个 NPE、5xx 序列为空** |
| 07:51:5x | 只改一个旋钮：`DOWNSTREAM_TIMEOUT_MS` 2000 → 1 |
| 07:52:0x | 容器重建使新 env 生效（T2） |
| 07:52:1x | 首个下游 Read timed out → 首个 NPE → 500 |

设计要点：F2 提交距故障起点 **>15 分钟**，所以按 `deployment-window` 的判定表，
「最近一次代码变更」这一支落在**相关性弱**区间；而部署窗口（容器重建）内**无提交**，
按 `git-diff-analysis` 的规则这本身就是排除发布假设的依据。
两条路都把发布排除掉，Agent 只能从 `runtime env` 里那个旋钮上找触发源。

### 已知的方法论边界（写清楚，别夸大）

host 模式下 Agent 的 shell 有宿主机的完整文件访问权，**目录布局是引导，不是边界**。
所以合规性靠三件事一起成立，缺一不可：

1. 工作区里确实没有答案（可核查：列出目录即可）
2. Prompt 里明确写了「工作区之外的文件不是证据源」
3. **逐条审 transcript**（唯一能证明"确实没读"的证据）

只做 1 和 2 就宣称"没有泄漏"是不成立的——这是本轮 04:32→06:19 那一跑暴露的。

## 本轮新增：F4 对照组（过度归因防护的反方向）

F2 已经证明「**相关**」时 Agent 能查到底。F4 对照组证明的是反方向：
**最近一次发布就发生在故障前 17 分钟，但故障不是它造成的——Agent 必须排除它。**

### 先说清楚：原来的 F4/F5 定义跑不出故障（实测）

| 故障 | 注入方式 | 实测结果 |
| --- | --- | --- |
| F4 | `DOWNSTREAM_TIMEOUT_MS=50` | 基线代码下 **0 个 5xx**：`DownstreamClient` 吞掉所有下游异常并 `return null`，基线代码判空后降级成 `ship_to=UNKNOWN`，HTTP 仍是 200 |
| F5 | `DB_POOL_SIZE=2` | 基线代码下 **0 个 5xx**：容器内 `LoadDriver` 是 `@Scheduled(fixedDelay)` **严格串行**（每 tick 只发一个请求），永远打不满连接池 |

F5 加压实测（`incident/tools/load-hammer.mjs`，本轮新增）：

- `pool=2` + 30s 默认获取超时 + 64 并发 → 11,691 请求**全部 200**，p99 208ms：池被打满但请求只是变慢
- `pool=2` + `connection-timeout=250ms` + 64/256 并发 → 确有池耗尽
  （日志原文 `Connection is not available, request timed out after 250ms (total=2, active=2, idle=0, waiting=38)`），
  但 5xx 只有 **0.5%**，撑不起 `HighServerErrorRate`（阈值 5%，`for: 30s`）
- 想再压低超时 → **Hikari 硬性下限 250ms**，低于它 Spring 直接启动失败：
  `Failed to bind properties under 'spring.datasource.hikari' to com.zaxxer.hikari.HikariDataSource`

结论：**F4/F5 按原定义在基线代码上不可观测，本实验台不存在「纯运行时旋钮 → 5xx」的路径。**
唯一能产生 5xx 的运行时路径是「已部署的缺陷 + 运行时旋钮触发」——这正是对照组真正要考的东西。

### 对照组怎么设计的

时间规则要能真正判「无关」，就必须让**代码提交落在 15 分钟窗口之外**，同时**故障由一个
运行时旋钮单独引发**。做法：

1. **T1（04:08:48 / 04:11:46）** 部署 F2 代码，但让它**静默**：把 `order 2`（user 9999，
   唯一没有 profile 行的订单）从 `LOAD_PATHS` 里去掉 → 缺陷存在但不触发 → **零异常、零告警**
2. **等 17.5 分钟** → 提交 `eed747c` 落到 15 分钟窗口**之外**，代码提交期间一直健康
3. **T3（04:29:09 / 04:29:15）** **只改一个运行时旋钮**：`DOWNSTREAM_TIMEOUT_MS` 2000 → **1**，
   容器重建（**镜像不变、代码不变、无新提交**）→ 下游自调用全部读超时 → `fetchProfile` 返回 null
   → 已部署代码里的未判空解引用 → NPE → 5xx ≈ 43% → 告警 firing
4. 跑 Agent，按四条标准打分

### 时间线（全部 UTC）

| 时刻 | 事件 | 来源 |
| --- | --- | --- |
| 04:08:48 | commit `eed747c` 重新引入 F2 判空移除 | `git log` |
| 04:11:49 | 容器启动（带 `eed747c`，静默） | `logs grep 'Starting TargetServiceApplication'` |
| 04:11:49–04:29:18 | **17.5 分钟静默期：1,294 次订单成功、0 次 NPE、0 次下游失败** | `app.log` 逐行核对 |
| 04:29:09 | `.env` 改动：`DOWNSTREAM_TIMEOUT_MS` 2000 → 1 | `stat -c '%y' incident/.env` |
| 04:29:15.459 | 容器重建（env 生效，**无新提交**） | `docker inspect` |
| 04:29:25.257 | 应用 `Started` | 日志 |
| **04:29:25.622** | **首个下游错误**：`Read timed out`（不是 404） | `logs first 'profile lookup failed'` |
| **04:29:25.633** | **首个 NPE → 500** | `logs first 'NullPointerException'` |
| 04:29:34.991 | 告警 `activeAt`（**pending 时刻**） | `metrics alerts` |
| ≈04:30:05 | 告警真正 firing（= activeAt + `for: 30s`） | `/api/v1/rules` |

> ⚠️ **锚点语义更正（Agent 提的，我复核过，成立）**：Prometheus **v1** `/api/v1/alerts` 的
> `activeAt` 是告警**进入 pending** 的时刻，不是 firing 时刻；firing = `activeAt + for`。
> v2 才有 `firedAt`。上一轮 F2 报告把 `activeAt` 当成 firing 时刻，与这次的口径要统一。

### 三个锚点

| 锚点 | 时间 (UTC) | 来源 |
| --- | --- | --- |
| ① 告警起始 | 2026-10-26T04:29:34.991948342Z（pending） | `metrics alerts` → `activeAt` |
| ② 异常首现 | 2026-10-26T04:29:25.622Z（下游超时）/ .633Z（NPE） | `logs first` |
| ③ 最近部署 | **代码提交 04:08:48（20.6 分钟前）**；容器重建 04:29:15.459（10 秒前） | `git log` / `docker inspect` |

`Δ(②−③提交) = 20.6 分钟` → **提交在 15 分钟窗口之外**；`Δ(②−③重建) = 10.2 秒` →
重建与故障同时，但**重建没带任何代码变更**（`git log` 04:08:48 之后为空）。

### 四条判定标准的验收结果

| 标准 | 结果 | Agent 实际怎么写的 |
| --- | --- | --- |
| ① 判定本次故障与部署无关，并写出依据 | ✅ | 「已排除的假设 5」：`eed747c` **只对了一半**——它是 500 的必要条件，但 04:11:49 就已上线、连续 17.5 分钟零 500，**且 04:08:48 之后无任何提交 → 窗口内无代码变更** |
| ② 指出真正的变更类型是运行时配置 | ✅ | 「本次跃升的触发源（运行时配置层）」；证据是 `.env` mtime 04:29:09 → 容器重建 04:29:15 → 首个错误 +0.365 秒，三段严格咬合 |
| ③ 不把 commit 拉进根因 | ✅ | 明确拆成两层：**代码层是放大器/必要条件**（`OrderService.java:29`），**运行时配置层才是触发源**；并在「已排除」里点名 `eed747c` |
| ④ 根因落在运行时旋钮 | ✅ | 根因指向 `DOWNSTREAM_TIMEOUT_MS=1`；同时用 `hikaricp.connections.max=10 / active=1 / pending=0 / timeout=0` **显式排除**了连接池假设 |

四条全过。另外它还独立做对了三件事：证明 `userId=9999` 本轮出现 **0 次**（前两轮的触发源
已不存在）、识别出 1ms 超时是**竞态**（失败率在 7.6%–43% 间抖动，我用 `metrics range` 复核：
峰值 43.12% @04:31，之后衰减到 7.93% @04:36）、以及用 `ps` 确认没有压测进程在跑 →
排除「流量冲击」。

### 复核过的数字（我逐条验算，全部对得上）

- 静默期 1,294 次 `order N loaded`、**0** NPE、**0** 次 `profile lookup failed`
- 首个下游错误确实是 `ResourceAccessException: ... Read timed out`，不是 404
- `git log` 在 04:08:48 之后**无提交**（`git-diff-analysis` 的「窗口内无代码变更」成立）
- `actuator env` 的三个旋钮键存在但值全被 `******` 掩码；`actuator configprops` 也一样
  （`showValues=never`）→ **只读通道读不到生效配置**，这是本轮最大的工具缺口
- 5xx 比例序列在 04:30 之前**根本不存在**（故障前 = 0，不是 8.75%）

### 本轮发现的四个问题（按处理优先级）

1. **【Agent 报告的硬伤】数字与自己的证据表冲突。** 报告在根因段写「5xx 从 **8.75%** 跃升到
   41.46%」，处置建议写「把 5xx 从 41% 压回 ~8.75%」。但它自己的 §7 明明写着
   「此前无样本（无 5xx 序列 ⇒ 0%）」——**故障前是 0%**，8.75% 是它把 30s 步长序列**衰减的
   尾部**误读成了基线。根因结论不受影响（触发源/机制/排除发布都有独立证据），但这个数字
   出现在**处置建议**里（回滚 timeout 后应该是 0%，不是 8.75%，因为 `order 2` 已移出负载）。
   **这类「结论数字与证据表不一致」正是本项目要防的失败模式，出现在自己的报告里。**
2. **【越界读取，Agent 主动声明了】** 只读 CLI 没有「生效运行时配置」通道（`actuator env` /
   `configprops` 全掩码），Agent 于是用了 `docker inspect` + `stat`/`cat incident/.env`。
   它在「跳过的步骤及原因」里明确声明了这点，没有隐瞒——但**通道越界本身是缺口**。
   另外 `incident/.env` 是 gitignore 的，但**在仓库目录里可读**，等于把「故障旋钮写成了明文」。
   下轮应把 env 文件挪到仓库外（`docker compose --env-file /tmp/xxx.env`）。
3. **【实验台坑】** `docker compose up <service>` 会**顺带重建依赖服务**并按**默认值**回填环境变量
   ——本轮两次因为这个把 `LOAD_PATHS` 打回默认（含 `order 2`），凭空造出两次假故障。
   已用 `incident/.env`（compose 自动读取）把旋钮固化，但**每次 compose 调用仍要带完整 env**。
4. **【实验台缺口】** `docker-compose.yml` 新增了 `SPRING_DATASOURCE_HIKARI_CONNECTION_TIMEOUT`
   透传（默认 30000 = Hikari 原值，行为不变），用于复现连接池耗尽；这是本轮唯一改过的 compose 行。

## 跑通步骤（F4 对照组）

```bash
cd /persistent/home/fs-user/IdeaProjects/ai_coding/study/miniclaw-main/miniclaw-main

# 0. 确认 agent-runner 已构建
ls container/agent-runner/dist/pi-index.js

# 1. 确认实验栈在跑
cd incident && docker compose ps && cd ..

# 2. 起 Miniclaw（没在跑的话）
node dist/index.js

# 3. 重建 cookie → 发消息 → 取 agent_reply
node incident/runs/mc-auth.mjs > /tmp/mc-cookie.txt
node incident/runs/ws-run.mjs "web:8ff36e4b-e8da-4dfd-be0a-b55d70fd9edb" \
     incident/runs/diag-prompt.txt
```

Agent 文本在 `agent_reply` 事件里，不在 `message`/`stream` 里——这个坑踩过一次。
`ws-run.mjs` 把输出写到 `/tmp/agent-out.txt`。

**重放对照组的完整配方**（三段式，约 25 分钟，见上节设计）：

```bash
cd incident

# 1. 重新注入 F2 并提交（基线代码带判空时才能注入）
node faults/faults.mjs inject F2

# 2. 部署「静默版」：order 2 不进负载 → 零异常
docker compose up -d --build --force-recreate target-service

# 3. 等 >15 分钟，让提交落到窗口外

# 4. 只改一个旋钮 → 触发
sed -i 's/^DOWNSTREAM_TIMEOUT_MS=.*/DOWNSTREAM_TIMEOUT_MS=1/' .env
docker compose up -d --force-recreate target-service

# 5. 等告警 firing（约 90 秒）→ 跑 Agent
```

## 还没做的

- **【新增·高优先】给只读 CLI 补 runtime-env 通道**：现在 Agent 要拿「生效的超时/连接池配置」
  必须 `docker inspect` 越界。应该补 `runtime env`（只吐实验台那几个旋钮）+ `runtime started`
  （容器启动时间），让整条链留在通道内。
- **【新增】F5 需要重定义**：按原定义（只调 `DB_POOL_SIZE`）在本实验台不可观测。
  可选方向：把连接获取超时纳入 F5 定义 + 配套负载发生器（`incident/tools/load-hammer.mjs`
  已写好），但 Hikari 250ms 下限决定了失败率只能在 0.5% 量级，**达不到 5% 告警阈值**——
  要么改告警阈值做专项演练，要么放弃 F5 走别的资源类故障。
- **【新增】`.env` 挪出仓库**：放 `/tmp/lab.env` + `docker compose --env-file`，避免「旋钮明文可读」。
- **只读 MCP 工具通道**（`pending`）。CLI 通道已经验证可用且够用，MCP 封装一直没做，
  因为 Pi SDK 的 MCP 兼容性和 `@modelcontextprotocol/sdk` 都不是本项目依赖。没验证之前别急着写。
- **logs 通道支持 `.gz`**（F2 那轮踩到，本轮又踩到一次：Agent 为了数「静默期 0 次 NPE」
  又越过通道直接读了轮转文件）。顺带：`.env` 固化的 `.gz` 这次是真 gzip
  （`app.log.2026-10-26.1.gz`），而手工 `mv` 出来的那两个仍是明文。
- **告警锚点口径统一**：`activeAt` = pending 时刻，firing = activeAt + `for`。
  后续所有报告按这个口径写，并在 `alert-triage` skill 里写死。

## 简历包状态

`claim-incident-101`（F2 正例）已从 `pending` 翻成 `confirmed`（2026-10-26），
路径 `/home/fs-user/Desktop/文档/overleaf/miniclaw_incident相关/claim-ledger.json`。

本轮新增 `claim-incident-102`（F4 对照组 / 过度归因防护），同样 `confirmed`，
`allowed_uses` 仍是 `["audit", "interview"]`——**没有**放行到 `resume_draft` / `resume_final`，
放行与否由本人决定。

`agent-project-model.json` 里对应的 artifact 已同步为 `Implemented`（本轮新增
`artifact-incident-007`，`agent_layer: Eval`），避免台账自相矛盾；`coverage.eval`
由 `absent` 改为 `weak`（有对照组实测，但完整八类故障指标表仍未跑）。

> 顺带修掉三处**台账自相矛盾**——它们不是新写的，而是上一轮把 artifact 从 `Design-only`
> 翻成 `Implemented` 时漏改的 `source_fact` / `boundary` / `risk_notes`：
> `claim-incident-002` 仍写「仓库中尚无任何 SKILL.md」、`claim-incident-003` 仍写「方案尚未搭建」、
> `claim-incident-001` 仍写「项目处于设计完成、编码未开始阶段」。审计时这三条会直接与
> artifact 注册表打架。三条已改为「本条只保留设计判断本身，实现与实测口径以 101 为准」。

> ⚠️ 对外引用时的口径纪律：这轮**不能**说「Agent 完美排除了所有误判」。准确的说法是
> 「四条判定标准 4/4 通过，同时报告里有一个与自己证据表冲突的数字、两次越过只读通道」。
> 主动写出缺陷比藏起来更经得起追问。
