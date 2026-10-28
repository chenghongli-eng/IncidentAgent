# IncidentAgent — 断点存档

最后更新：2026-10-27。本文件是**唯一下次会话的入口**，先读它再动手。

## 一句话状态

**F4 对照组复跑已在 2026-10-27 07:27Z 跑完并独立复核完：四条判定标准 4/4、
通道零越界；但取证环境并非完全干净——复核查出 1 处残留的答案提示（非承重，已披露）。**
复核件：`incident/runs/audit-2026-10-27T0727Z.md` §7。

简历包在仓库外：`/home/fs-user/Desktop/文档/overleaf/miniclaw_incident相关/`
（`paste-ready-最终版.md` 是成稿，`claim-ledger.json` 是唯一放行依据）。

发现的泄漏有七处，都不是 Agent 的错，是实验台自己的：

| 泄漏点 | 泄漏内容 | 处理 |
| --- | --- | --- |
| `incident/faults/faults.mjs` | 逐条列出注入了哪些故障、注入了什么代码 | 移出 Agent 工作区 |
| `incident/runs/agent-report-*.md`、`incident/RESUME.md` | 前两轮的分析结论 | 移出 Agent 工作区 |
| **F2 提交的 commit message** | 正文写着 `Fault-F2: unchecked downstream call raises NPE` | 重建服务仓库历史，去掉标签 |
| **git 通道连着实验台自己的历史** | `feat(incident): add fault-injection lab…` 等提交 | 工作区独立成仓，通道只看得到服务历史 |
| **`.env` 里的注释** | 写着「F2 已部署但休眠、旋钮才是触发源」 | 注释清空，只留旋钮值 |
| **聊天历史注入** | Agent 新 session 会把上一轮报告注入 prompt | 清空工作区聊天记录与 session |
| **服务仓库 `data.sql` 种子注释**（2026-10-27 复核时才发现） | 描述了**被 F2 删掉的判空兜底**（「degrades a missing profile to ship_to=UNKNOWN」），Agent 于 07:31:42Z 读到并写进报告 | 源文件与工作树已清（提交 `38b3705`）；git 历史里那半句仍残留（清掉要重建整条链，会让复核件与台账引用的 SHA 失效），如实披露在复核件 §7 |

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

**【2026-10-27 追加】清干净之后又查出四处更隐蔽的泄漏面**，都不在文件里，
在「运行时读的那份」里——改了源不同步，等于 Agent 还在用旧契约：

| 泄漏面 | 泄漏内容 | 处理 |
| --- | --- | --- |
| **工作区记忆 `lesson`** | 把上一轮的失效机制、旋钮值、已死的 commit SHA 原样写死；`historical-incident-lookup` 一召回就等于发答案 | 改写成只留方法（锚点口径、负证据、分层排查经验），去掉结论 |
| **工作区记忆 `open_loop`** | 状态已过期，内容同样写死结论 | 整条 forget（软删）**并把 tombstone 正文一起清空**（见下） |
| **Skill 契约里的示例** | `log-triage` 的输出示例直接填了异常类型与栈顶方法名 | 换成占位符，并写死「示例里不要填具体类名/方法名/行号」 |
| **Agent Profile 的 `agents_prompt`** | 「两层归因」小节写成了带结论的模板 | 改成「归因要分层」原则，不给场景模板、不预填结论 |

> ⚠️ **三个必须记住的坑**：
> ① **改了 `incident/skills/` 或 `identity.json` 不等于生效**——Agent 运行时读的是
> `data/skills/<userId>/*/SKILL.md` 与 `agent_profiles` 表里的行。
> `incident/runs/sync-skills.mjs` 与 `incident/runs/sync-agent-profile.mjs` 负责同步，幂等。
> ② **底座的 `forget` 是软删，`get` 不过滤 status**——拿着 id 仍能把原文整段取回来，
> 10-26 那一轮正是「search 拿 id、再 get 取全文」。作废一条记忆不等于 Agent 读不到它，
> 必须把 tombstone 正文一起清空（`memory-de-leak.mjs` 的 `scrubTombstone`）。
> ③ **手工去泄漏一定会漏「描述已删除行为」的残留**——`data.sql` 那半句种子注释
> 没有任何显式故障标签（`fault F2` 那种），只是描述了一个**已被删除的兜底逻辑**，
> 所以清标签式的手工扫描完全看不到它。开跑前一律跑 `node incident/runs/leak-scan.mjs`，
> 0 命中才开跑。

剩下的：① 重定义 F5；② 只读 MCP 工具通道；③ 底座 `forget`/trigram 检索这两个缺陷要不要单独立项。

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

### 服务仓库历史（Agent 能看到的那几条）

```
83c26bf  2026-10-19T10:12Z  feat(service): add order and profile read endpoints
d306ad3  2026-10-21T14:35Z  chore(service): add downstream client, load driver and actuator exposure
35854c8  2026-10-26T07:23Z  feat(order): enrich response with downstream shipping address   ← 部署的那条
8061f59  2026-10-26T07:29Z  fix(tool): keep `git file` reads inside the repository root      ← 只动 tools/
38b3705  2026-10-26T07:29Z  chore(seed): clarify seed data note                              ← 补的：删掉残留注释
```

没有 `Fault-` 标签，没有回滚/重打的对子，没有实验台自己的提交。

> **【2026-10-27 补记】`38b3705` 是复核之后补的**：复核做全仓库扫描时发现
> `data.sql` 的种子注释还留着半句「the service degrades a missing profile to ship_to=UNKNOWN」
> ——那是**被 F2 删掉的判空兜底**的行为描述。Agent 在 07:31:42Z 读到过它。
> 已确证它**不承重**（根因推导完全不依赖它；必要条件那一层早 2 分 07 秒已由
> `git diff 35854c8` 独立得出），但仍然如实披露并修掉了。详见复核件 §7。
> 提交日期同样回填到 2026-10-26T07:29:40Z，**保持「所有提交都远在故障窗口之外」**。

> **【2026-10-27 换链】这四条 SHA 与 10-26 那版不同，因为历史又重建了一次。**
> 旧链 `c8d12f2 / e78a1c3 / 409d265 / e87d06f` 在 2026-10-27 被 `reset` 掉，
> 新链 `83c26bf / d306ad3 / 35854c8 / 8061f59` **提交信息、作者、作者时间完全一致**，
> 只有 blob 内容不同——差在三个去泄漏的文件上：
> `data.sql` 的种子注释、`schema.sql` 的索引注释、`pom.xml` 的 description。
> F2 缺陷（`OrderService.loadOrder` 删掉判空）**刻意保留**。
> 校验方式：`git log --all -p | grep -inE "fault F1|fault F2|Fault-injection|未判空"` → **0 命中**。
> 旧的 `backup-pre-clean` 分支已删，reflog 已过期，gc 已 prune。
>
> **⚠️ 那次手工去泄漏漏了半句（复核时才发现）**：换链时清掉了 `fault F2` 这种显式标签，
> 但 `data.sql` 的注释还留着「描述已删除行为」的半句 `to ship_to=UNKNOWN`。
> 源头 `incident/target-service/src/main/resources/data.sql` 原本写的是
> 「The baseline code degrades that to ship_to=UNKNOWN; **fault F2 turns it into an NPE**」
> ——手工清理只清了后半句。**源文件现已清干净**（`data.sql` / `schema.sql` / `pom.xml` 三处），
> 重建历史产出的基线 blob 与工作树逐字节一致，下次重建不会再带残留。
> **下次复跑前必须重建历史**，且 `node incident/runs/leak-scan.mjs` 必须 0 命中才能开跑。
> 当前扫描结果：**阻断 0、历史残留 2**（历史里那半句仍在，因为清掉它要重建整条链、
> 而链上每条 SHA 都被复核件与台账引用——取舍是保住证据链，把残留披露出来）。

最后一条 `8061f59` 是只读 CLI 的路径越界修复——工作区里那份一直没提交，
外层仓库的同一处修复早就在 `38f1af2` 里了。它**只改 `tools/incident-readonly.mjs`**，
`target-service/` 一行未动。提交日期回填为文件真实写作时间（mtime 2026-10-26 15:29:26 +0800），
理由见下文「已处理：工作区仓库的 dirty 状态」。

> **这四条提交的时间戳是回填的作者时间，不是它们的实际提交时刻。**
> `incident/workspace/.git/logs/HEAD` 里能看到重建过程：旧链
> （`dc8d2ca` → `3e1d458` → `62bf9ea`）在 2026-10-26 15:27:48 +0800 被两次 `reset`
> 掉，随后三条提交被带着原有的时刻重新提交（换成 +0800 表示），reflog 因此呈现乱序。
> 重建目的是去掉带 `Fault-` 标签的 commit body。`8061f59` 沿用同一写法——
> 日期取文件真实写作时间，这样它不会落在未来任何一次复跑的时间窗里。
> 换链后仍是同一条规则：**最晚一条提交是 2026-10-26T07:29:40Z**，
> 任何一次复跑的时间窗都在它之后，所以「窗口内无代码变更」永远成立。

### 干净的 F4 时间线（设计 + 实际执行到哪一步）

| 时刻 (UTC) | 事件 | 状态 |
| --- | --- | --- |
| 07:23:25 | 提交 `35854c8`（最后一次改**服务源码**的提交，F2 缺陷随它上线） | 已发生 |
| 07:29:26 | 提交 `8061f59`（只读 CLI 的路径越界修复，只动 `tools/`；2026-10-27 补提交，日期按 mtime 回填） | 已发生 |
| 07:29:36 | 容器重建，**timeout=2000** → 部署生效（T_dep） | 已发生，但已被 10-27 的重建取代 |
| 07:29:44 | 应用就绪 | 已发生 |
| 07:29:44–14:12:35 | **健康窗口 6 小时 43 分，0 个 NPE、0 个 ERROR**（`runs/log-archive/app.log.2026-10-26.0.gz`） | 已发生 |
| **2026-10-27 01:39:40** | **容器再次重建**（镜像、代码、旋钮均未变；重建原因未记录），应用 01:39:59 就绪 | 已发生 |
| 01:39:59 – 04:02:41 | 健康窗口。**除一次人为探测外 0 NPE / 0 ERROR**（`workspace/logs/app.log`）：2026-10-27 04:02:41 手工 `curl /api/orders/2` 触发 1 次 NPE + 2 条 ERROR——它顺带证明**F2 缺陷确实已部署**，缺陷静默只因 order 2 不在 `LOAD_PATHS` 里 | 已发生 |
| **07:24:20.061** | **只改一个旋钮**：`DOWNSTREAM_TIMEOUT_MS` 2000 → **1**（`~/.config/miniclaw-lab/lab.env` mtime） | **已执行** |
| **07:24:21.000** | 容器重建使新 env 生效（T_dep；镜像、代码、commit 均未变） | **已执行** |
| 07:24:29.198 | 应用就绪 | 已发生 |
| **07:24:29.509** | **首个下游 `Read timed out`** → 07:24:29.515 首个 NPE → 500 | 已发生 |
| 07:24:49.991948342 | 告警 `activeAt`（**pending 时刻**，firing = activeAt + `for`） | 已发生 |
| **07:27:27** | 起 Agent（`ws-run.mjs`），07:34 交付报告 `agent-report-2026-10-27T0727Z.md` | **已执行** |
| 07:40–07:52 | 本人独立复核（`runs/audit-2026-10-27T0727Z.md`） | **已执行** |

设计要点：F2 提交距故障起点 **>15 分钟**，所以按 `deployment-window` 的判定表，
「最近一次代码变更」这一支落在**相关性弱**区间；而部署窗口（容器重建）内**无提交**，
按 `git-diff-analysis` 的规则这本身就是排除发布假设的依据。
两条路都把发布排除掉，Agent 只能从 `runtime env` 里那个旋钮上找触发源。

> 实测出来的 Δ：携带 `35854c8` 的那次部署在 **2026-10-26T07:29:44.919Z** 就绪，
> 距 T_err（2026-10-27T07:24:29.509Z）是 **23h54m44.6s**（从 commit 时间算则是 24h01m04.5s）。
> Agent 的报告把这段写成了「20 小时 55 分」——**数字错了，结论方向没错**（都远超 15 分钟）。
> 见复核件 §3-D1。

### 已知的方法论边界（写清楚，别夸大）

host 模式下 Agent 的 shell 有宿主机的完整文件访问权，**目录布局是引导，不是边界**。
所以合规性靠三件事一起成立，缺一不可：

1. 工作区里确实没有答案（可核查：列出目录即可）
2. Prompt 里明确写了「工作区之外的文件不是证据源」
3. **逐条审 transcript**（唯一能证明"确实没读"的证据）

只做 1 和 2 就宣称"没有泄漏"是不成立的——这是本轮 04:32→06:19 那一跑暴露的。

## 本轮新增：F4 对照组复跑（2026-10-27 07:27Z，清过泄漏）与独立复核

**这一节是当前的主证据。** 10-26 04:32Z 那一轮已被它取代。

### 产出物

| 文件 | 内容 |
| --- | --- |
| `incident/runs/agent-report-2026-10-27T0727Z.md` | Agent 报告原件（**不改**） |
| `incident/runs/session-transcripts/2026-10-27T07-27-34-258Z_01a17c41-df72-7cdb-b3de-40a90cde8c17.jsonl` | 可审计的会话记录 |
| `incident/runs/audit-2026-10-27T0727Z.md` | 本人独立复核件：逐条复算 + 4 处数字问题 + F4 打分 |

### 复跑前做了什么（缺一不可）

1. **服务仓库历史重建**（换链，见上文），去掉三处带答案的文件内容与全部 `Fault-` 标签。
   ⚠️ **这一步当时是手工做的，漏了半句**（`data.sql` 注释里「描述已删除行为」的残留），
   是复核时才发现的。现在改成：先清源文件（已清），再重建历史，
   最后 `node incident/runs/leak-scan.mjs` 必须 0 命中。
2. **工作区记忆去泄漏**（`incident/runs/memory-de-leak.mjs`）：
   `lesson` 改写成只留方法、`open_loop` 整条作废并清空 tombstone 正文。
3. **Skill 与 Profile 去泄漏 + 同步回运行时**
   （`incident/runs/sync-skills.mjs`、`incident/runs/sync-agent-profile.mjs`）：
   改的是源文件，运行时读的是 `data/skills/<userId>/` 与 `agent_profiles` 表——不同步等于没改。
   本次同步后 profile version 3 → 4，agents_prompt 1148 → 1156 字。

### 复核结论

| 项 | 判定 |
| --- | --- |
| 四条 F4 判定标准 | **4/4 通过**（复核件 §4） |
| 通道合规 | **零越界**：8 次 Skill 读取全是本会话自己的 SKILL.md，1 次 memory_search，36 次 bash 的绝对路径全在 `incident/workspace/` 之下；无 `docker inspect`、无 `lab.env`、无 `faults/`、无既往报告、无 `messages.db` |
| 取证环境 | **主要几处已清；仍残留 1 处非承重提示**（服务仓库 `data.sql` 种子注释，Agent 07:31:42Z 读到并在报告 119–120 行引用）→ 复核件 §7 |
| 报告数字 | 多数可回指；**1 处硬错 + 3 处过度声称**（复核件 §3） |

### 复核查出来的四个问题（写出来，别藏）

1. **【硬错】** 距上次部署的时间差写成「20 小时 55 分」，实为 **23h54m44.6s**。
   方向不变（都远超 15 分钟，仍排除该发布作为触发源），但这数字一算就戳得破。
2. **【过度声称】** 「流量全程 2.87–2.91 req/s 恒定」——它自己的采样是 **0.95–2.91**。
   结论（不是流量激增）成立：故障前均值 2.879 → 故障后 2.828。
3. **【过度声称 + 漏掉更值得讲的性质】** 「5xx 比例稳定 0.36–0.435」「平台」——
   实际是**台阶起、边际衰减**：服务端失败率从 07:25 的 ~100% 一路衰减到 07:37 后的 3–5%。
   **1ms 不是「远低于」回环调用所需的 2.5ms，是卡在边上**：失败率是「1ms 预算 vs 回环耗时」的赛跑，
   JVM 预热后回环变快，失败率就掉下来。这条比原报告写的更有价值。
4. **【快照当稳定值】** 「88.5% 出站调用被中断」是 07:32:26 的读数，07:39 复测为 73.7%。
   数字本身对，但会漂。

另外补两条：**历史事件时间戳差 10ms**（.808 vs 实际 .798）；
Agent 自己标为「未直接验证」的 **LoadDriver 复用 `@Primary` 1ms RestTemplate**，
本人读源码确认**成立**（`probeRestTemplate` 无 `@Primary` 也无 `@Qualifier`，实际从未被使用）。

### 顺带挖出来的两个底座缺陷（不是这轮的错）

1. **`forget` 是软删、`get` 不过滤 status** → 作废一条记忆不等于 Agent 读不到它。
   本轮靠 `scrubTombstone` 额外清空 tombstone 正文绕开，**但底座本身该修**。
2. **FTS5 trigram 短语匹配** → 堆在一起的关键词必然 0 命中，
   而 skill 又写着「0 命中 = 无历史记录」，于是 Agent 会把**检索失败**当成**历史上没有**。
   已改 `historical-incident-lookup` 的示例与口径（commit `0cb8033`），**但全局还没查一遍**。

## 历史：2026-10-26 04:32Z 那轮 F4 对照组（已被 10-27 复跑取代，但设计思路保留）

F2 已经证明「**相关**」时 Agent 能查到底。F4 对照组证明的是反方向：
**最近一次发布就发生在故障前 17 分钟，但故障不是它造成的——Agent 必须排除它。**

### 先说清楚：原来的 F4/F5 定义跑不出故障（实测）

| 故障 | 注入方式 | 实测结果 |
| --- | --- | --- |
| F4 | `DOWNSTREAM_TIMEOUT_MS=50` | 基线代码下 **0 个 5xx**：`DownstreamClient` 吞掉所有下游异常并 `return null`，基线代码判空后降级成 `ship_to=UNKNOWN`，HTTP 仍是 200 |
| F5 | `DB_POOL_SIZE=2` | 基线代码下 **0 个 5xx**：容器内 `LoadDriver` 是 `@Scheduled(fixedDelay)` **严格串行**（每 tick 只发一个请求），永远打不满连接池 |

F5 加压实测（`incident/faults/load-hammer.mjs`，本轮新增）：

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
cd incident && ./lab.sh ps && cd ..

# 2. 起 Miniclaw（没在跑的话）
node dist/index.js

# 3. 重建 cookie → 发消息 → 取 agent_reply
node incident/runs/mc-auth.mjs > /tmp/mc-cookie.txt
node incident/runs/ws-run.mjs "web:8ff36e4b-e8da-4dfd-be0a-b55d70fd9edb" \
     incident/runs/diag-prompt.txt
```

Agent 文本在 `agent_reply` 事件里，不在 `message`/`stream` 里——这个坑踩过一次。
`ws-probe.mjs` 把 `agent_reply` 全文累积并写到 `/tmp/agent-out.txt`；`ws-run.mjs` 只逐条打印
事件（每条截断 220 字符），排查事件流时用它。

> chatJid `web:8ff36e4b-e8da-4dfd-be0a-b55d70fd9edb` = 工作区「incident-lab」，
> `custom_cwd` 指向 `incident/workspace`（host 模式），所以 Agent 的 cwd 就是那个隔离仓库。
> 若工作区被重建，JID 会变，用 `GET /api/groups` 重新查。

**重放对照组的完整配方**（三段式，约 25 分钟，见上节设计；
**2026-10-27 07:27Z 那一轮就是照这个跑的**，只多了 §「复跑前做了什么」里的去泄漏与同步步骤）：

> ⚠️ 所有 compose 调用必须走 `incident/lab.sh`。裸跑 `docker compose` 会在找不到
> `.env` 时**静默把旋钮重置成 compose 里的默认值**——那等于凭空造出一次故障。
> `lab.sh` 强制 `--env-file`，缺文件直接报错退出。

```bash
cd incident

# 0. 旋钮文件必须存在
ls ~/.config/miniclaw-lab/lab.env

# 0.5 【2026-10-27 新增】复跑前必须做的去泄漏 + 同步（顺序不能颠倒）
cd ..
node incident/runs/memory-de-leak.mjs      # 工作区记忆：lesson 去结论、open_loop 作废+清正文
node incident/runs/sync-skills.mjs          # incident/skills/*/SKILL.md → data/skills/<userId>/
node incident/runs/sync-agent-profile.mjs   # incident/agent-profile/identity.json → agent_profiles 表

# 0.6 【2026-10-27 新增】开跑前的最后一道闸：扫 Agent 可读面上有没有残留的答案
#     扫四个面：服务仓库工作树 + git 历史、工作区记忆（含软删条目）、运行时 Skill、Agent Profile
#     必须 0 命中。当前链有 2 处**历史残留**（旧 blob 里的注释），
#     所以下一轮复跑前要先按上文重建历史——源文件已清干净，重建出来就是干净的。
node incident/runs/leak-scan.mjs
cd incident

# 1. F2 缺陷已注入并已部署（服务仓库 HEAD = 8061f59，其中服务源码仍是 35854c8 那版，
#    镜像里带该缺陷：curl /api/orders/2 返回 500 NPE）。当前任务是让它「静默」——
#    order 2 不在 LOAD_PATHS 里 → 零异常。
#    只有把服务仓库退回基线时才需要重新注入（重复注入会报
#    "baseline text not found (already injected?)"）：
#    node faults/faults.mjs inject F2

# 2. 部署「静默版」（--no-deps，不顺带重建依赖服务）
./lab.sh recreate target-service

# 3. 等 >15 分钟，让提交落到窗口外

# 4. 只改一个旋钮 → 触发
sed -i 's/^DOWNSTREAM_TIMEOUT_MS=.*/DOWNSTREAM_TIMEOUT_MS=1/' ~/.config/miniclaw-lab/lab.env
./lab.sh recreate target-service

# 5. 等告警 firing（约 90 秒）→ 跑 Agent

# 6. 跑完把实验台恢复健康（否则下一轮会被上一次的故障态污染）
sed -i 's/^DOWNSTREAM_TIMEOUT_MS=.*/DOWNSTREAM_TIMEOUT_MS=2000/' ~/.config/miniclaw-lab/lab.env
./lab.sh recreate target-service
```

> ⚠️ **第 6 步别漏。** 10-27 那一轮跑完后实验栈一直停在故障态（旋钮 = 1），
> 我做复核时 5xx 比例还在 0.01–0.05 漂着。复现实验前务必先把旋钮调回 2000 再重建。

## 存档：暂缓执行的两项（2026-10-26 18:30 归档；第一项已于 2026-10-27 07:27Z 完成）

| 项 | 当前状态 | 恢复入口 |
| --- | --- | --- |
| ~~**通道合规复跑 + transcript 审计**~~ | **✅ 已完成（2026-10-27 07:27Z）**：改旋钮 → 重建容器 → 跑 Agent → 逐条审 transcript → 独立复核。四条标准 4/4、零越界；**取证环境残留 1 处非承重提示**（复核件 §7），已披露并修复。产出物与复核件见上文「F4 对照组复跑」一节。 | — |
| **F5（连接池类故障）重定义** | 按原定义不可观测（详见下节实测）。`incident/faults/load-hammer.mjs` 已写好。 | 见下节「F5 需要重定义」 |

**约束**：F5 重定义完成前，简历里 101/102 的取证口径说明**不得删除**。
但要注意 101/102 的披露内容**已经变了**：
10-26 那一轮说「证明的是结论正确、流程跑通，不是取证过程干净」；
**10-27 这一轮是清掉泄漏之后跑的**，所以披露要改成「复跑 + 报告里仍有 4 处数字问题主动列出
+ 取证环境残留 1 处非承重提示」——不是把旧的披露整段删掉，也不是假装没有问题，
更不能写成「无泄漏环境」（复核件 §7 查出了残留）。
⚠️ 复核件 §7 之后口径又变了一次：**下一轮开跑前必须重建服务仓库历史并让
`leak-scan.mjs` 0 命中**，否则那条披露还得继续挂着。

### 已处理：工作区仓库的 dirty 状态（2026-10-27 已提交，随后又换链一次）

原先 `incident/workspace/tools/incident-readonly.mjs` 相对它自己的 HEAD（当时的 `409d265`）
是 **modified**——就是「`git file` 路径越界」那处修复：外层仓库已提交，Agent 实际用的那份改了但没提交。

麻烦在于 `$LAB git diff <sha>` 比的是**提交 vs 工作区**，所以复跑时它会把这个工具文件的改动
一起带进 diff 输出，Agent 可能把它读成「窗口内有代码变更」——而 F4 对照组正是靠
「窗口内无代码变更」来排除发布假设的。

**已选方案 (b)：在工作区仓库提交这个修复**，提交 `e87d06f`（2026-10-27 换链后为 `8061f59`）。

| 项 | 结果 |
| --- | --- |
| 工作区是否干净 | 是，`git status` 无输出 |
| 提交动了什么 | 只有 `tools/incident-readonly.mjs`；`target-service/` 一行未动 |
| 服务源码 | 仍是 `35854c8` 那版（换链前是 `409d265`），F2 缺陷照旧在镜像里 |
| 提交日期 | 回填为文件真实写作时间 **2026-10-26T07:29:26Z**（mtime），不是提交当天——否则新提交会紧贴提交当天，复跑时可能被读成「窗口内有代码变更」 |
| 「最近一次提交」 | 变成 `8061f59`。对 F4 判定**无影响**：复跑无论何时发生，它都远在 15 分钟窗口之外，「窗口内无代码变更」这条前提仍然成立 |
| `Δ=20.6 分钟` | 那是 10-26 04:29Z 那一轮对当时 HEAD 算出的历史事实，**不改**。新一轮复跑按新 HEAD 重算 Δ，取届时的新值 |
| **10-27 复跑实测的 Δ** | `8061f59` / `35854c8` 都在 2026-10-26，距 T_err **23h54m44.6s**（换链前后作者时间都没变） |

提交正文里没有任何泄漏实验台身份的信息（不出现 agent / 诊断 / 故障 / F2 / 实验台字样），
Agent 看到的是一条只动 `tools/` 的普通修复提交。

## 已完成（别重做）

这几项曾列在待办里，实际早已落地，不要再当待办排期：

| 项 | 落地形态 | 位置 |
| --- | --- | --- |
| **只读 CLI 的 runtime-env 通道** | `$LAB runtime env` 吐实验台那几个旋钮的生效值 + 旋钮文件 mtime；`$LAB runtime started` 吐容器重建时刻与应用就绪时刻。工具内部调 `docker inspect`，所以从 Agent 侧看整条链仍留在通道内。 | `incident/tools/incident-readonly.mjs`（`case 'runtime'`）；`incident/agent-profile/identity.json` 的 `tools_prompt` 已把这两条命令写给 Agent |
| **旋钮文件挪出仓库** | 旋钮在 `~/.config/miniclaw-lab/lab.env`（chmod 600），仓库内已无 `incident/.env`；`incident/lab.sh` 强制 `docker compose --env-file` | `incident/lab.sh`、`incident/lab.env.example` |
| **服务仓库历史去泄漏并换链** | 新链 `83c26bf / d306ad3 / 35854c8 / 8061f59`，`git log --all -p` 里 `Fault-` 字样 0 命中 | `incident/workspace/`（独立仓） |
| **工作区记忆去泄漏** | `lesson` 改写成只留方法；`open_loop` 作废 + tombstone 正文清空 | `incident/runs/memory-de-leak.mjs` |
| **Skill / Profile 同步回运行时** | 改了源不同步 = Agent 还在用旧契约 | `incident/runs/sync-skills.mjs`、`incident/runs/sync-agent-profile.mjs` |
| **通道合规复跑 + transcript 审计** | 4/4、零越界；**残留 1 处非承重提示**（`data.sql` 种子注释，Agent 于 07:31:42Z 读到并引用，不承重）；复核件 `runs/audit-2026-10-27T0727Z.md` §7 | `incident/runs/agent-report-2026-10-27T0727Z.md` + transcript |
| **答案泄漏扫描闸门** | 扫 Agent 能读到的四个面（服务仓库工作树 / 完整 git 历史 / 工作区记忆含软删条目 / 运行时 Skill + Agent Profile），命中即 exit 1。当前：**阻断 0、历史残留 2** | `incident/runs/leak-scan.mjs` |

## 还没做的

- **【新增】F5 需要重定义**：按原定义（只调 `DB_POOL_SIZE`）在本实验台不可观测。
  可选方向：把连接获取超时纳入 F5 定义 + 配套负载发生器（`incident/faults/load-hammer.mjs`
  已写好），但 Hikari 250ms 下限决定了失败率只能在 0.5% 量级，**达不到 5% 告警阈值**——
  要么改告警阈值做专项演练，要么放弃 F5 走别的资源类故障。
- **【新增】底座 `forget` 不过滤 `get` 的 status**：`forgetWorkspaceMemory` 只置
  `status='deleted'`，`search` 会过滤掉它，但 `getWorkspaceMemory` 不过滤——
  拿着 id 仍能取回原文。本轮靠额外清空 tombstone 正文绕开，**底座本身该修**。
- **【新增】FTS5 trigram 短语匹配的全局排查**：底座检索用 `ftsPhrase(query)`，
  查询串必须是原文里**连续的一段**。已改 `historical-incident-lookup` 的示例（commit `0cb8033`），
  但其它 skill / 提示词里可能还有堆关键词的检索式，**全局还没查**。
- **只读 MCP 工具通道**（`pending`）。CLI 通道已经验证可用且够用，MCP 封装一直没做，
  因为 Pi SDK 的 MCP 兼容性和 `@modelcontextprotocol/sdk` 都不是本项目依赖。没验证之前别急着写。
- **logs 通道支持 `.gz`**（F2 那轮踩到，10-26 那轮又踩到一次：Agent 为了数「静默期 0 次 NPE」
  越过通道直接读了轮转文件）。**10-27 这一轮没有踩**——`logs` 通道已能读 `app.log.*`
  （gzip 与未压缩都读），本轮 Agent 全程没越界。
- **告警锚点口径统一**：`activeAt` = pending 时刻，firing = activeAt + `for`。
  10-27 这一轮已经按这个口径写了（且明说 `for` 值本通道不可读，不据此做任何推断）。

## MVP 缺口（2026-10-28 分析，下次先看这一节再排期）

先纠正一个容易跑偏的判断：**上面那几条「还没做的」大多是技术债，不是 MVP 阻塞项。**
按 `docs/PRD.md` §8 三周计划对表，现在的位置是 **W1 完成 + W2 的一个纵切面**，
不是「补三个小尾巴就收工」。PRD 原文：「**W2 是项目的分水岭**」。

| 计划 | 交付 | 现状 |
| --- | --- | --- |
| W1 | 栈 + 8 Skill + 只读通道，手工能走完一次诊断 | **完成**（8 Skill 全在，CLI 通道已替代 MCP 且验证可用） |
| W2 | 故障脚本 + 样本生成器 + **scorer** + 重放 runner → 完整指标表 | **部分**：故障定义只有 3 条，跑过 2 轮，**scorer 不存在** |
| W3 | 演示录制 + README + 简历素材 | 未做（简历素材另有 `overleaf` 目录，不算这周） |

### 真正的 MVP 缺口（四件）

1. **scorer 不存在**。`grep -rln 'scorer\|ground_truth\|root_cause_accuracy' incident/ scripts/`
   → **0 命中**。判定口径 PRD §7.1 已写死（命中 1.0 / 部分 0.5 / 未命中 0.0），
   落地成脚本只是把口径翻译一遍。没有它，指标表只能手算，不可复现。
2. **样本生成器 + 重放 runner 不存在**。PRD §3.3 定义的
   `{sample_id, alert, symptom, injected, ground_truth}` schema **一个样本都没生成过**。
3. **故障库 3 → 8**。当前 `incident/faults/faults.mjs` 只有 F2（代码）/ F4、F5（运行时）。
   缺 F1（缺索引慢 SQL）、F3（`@NotNull`）、F6（Redis 断连）、F7（OOM）、F8（配置改错）。
   其中 **F1 / F5 / F6 正是"测过度归因到发布"的那三类**——缺了它们，
   这个项目最核心的论点（SOP 存在过度归因偏置）就没有数据支撑。
4. **缺一轮干净复跑**。现有 F4 那轮只能证明「通道打通」；10-26 的 F2 轮有泄漏且无干净版。

### 建议把 MVP 重定义为「3–5 条故障 × 各 2 次 × 有 scorer × 有指标表 × 干净取证」

不是 8×3。理由：

- **成本**：单轮 ≈ 重置 + 注入 + 部署 + 等告警（>15 min）+ 跑 Agent（~30 min）≈ 1 小时。
  8×3 = 24 轮是两天纯等待，还没算失败重跑。
- **3 条就够立论**：F1（该跳过发布归因）+ F2（变更类，该归因）+ F6（非代码变更，该跳过 git），
  正好覆盖「会不会过度归因」的三种情形，比 8 条平均分更有说服力。
- **scorer 不需要复杂**：30 行读 `ground_truth` + 报告打分即可。

### 收尾顺序（约 5 天）

```text
1. 重建服务仓库历史 → leak-scan 0 命中            （半天，前置闸门）
2. 写 scorer                                       （半天，纯代码）
3. 写 sample 生成器 + replay runner                （1 天，纯代码）
4. 补 F1 / F6 两条故障定义                          （半天）
5. 跑 3 故障 × 2 次 = 6 轮                          （2 天，主要是等）
6. 出指标表 + 结论                                  （半天）
```

上面「还没做的」那几条里，**只有第 1 项（leak-scan 历史残留）在这条路径上**。
底座 `forget` 缺陷已用 `scrubTombstone` 绕开、只读 MCP 通道已被 CLI 通道等效替代，
两者都可以挂账不阻塞 MVP——写简历时口径改成「只读 CLI 通道」即可，不要写成 MCP。

## 简历包状态

`claim-incident-101`（F2 正例）与 `claim-incident-102`（F4 对照组 / 过度归因防护）
路径 `/home/fs-user/Desktop/文档/overleaf/miniclaw_incident相关/claim-ledger.json`。

**【2026-10-26 18:xx 本人决定】两条均已放行到 `resume_draft` / `resume_final`**，
放行条件是把各自的取证口径说明写进同一条简历表述。成稿见
`paste-ready-当前可贴.md`（5 条，直接贴）与 `paste-ready-最终版.md`（同样 5 条 + 复核记录 + 禁写清单）。

**【2026-10-27 更新】102 的主证据换成清过泄漏的那一轮复跑**（10-27 07:27Z 报告 + 复核件），
`last_verified` 改为 2026-10-27。101 的证据仍是 10-26 02:22Z 那一轮
（F2 正例轮没有清过泄漏的复跑版本，**披露不变**）。

披露口径随之调整（不是删掉旧披露，是换成新披露）：

| claim | 旧披露 | 新披露 |
| --- | --- | --- |
| 101 | 取证环境有答案泄漏 → 只能说「流程跑通」 | **不变**（仍只有 10-26 那一轮） |
| 102 | 取证环境有答案泄漏 + 一个自相矛盾的数字 + 两次越界 | **清过泄漏后的复跑 + 报告里仍有 4 处数字问题（1 处硬错、3 处过度声称）+ 取证环境残留 1 处非承重提示**，全部主动列出 |

`agent-project-model.json` 里对应的 artifact 已同步为 `Implemented`（`artifact-incident-007`，
`agent_layer: Eval`），避免台账自相矛盾；`coverage.eval` 由 `absent` 改为 `weak`
（有对照组实测，但完整八类故障指标表仍未跑）。

> 顺带修掉三处**台账自相矛盾**——它们不是新写的，而是上一轮把 artifact 从 `Design-only`
> 翻成 `Implemented` 时漏改的 `source_fact` / `boundary` / `risk_notes`：
> `claim-incident-002` 仍写「仓库中尚无任何 SKILL.md」、`claim-incident-003` 仍写「方案尚未搭建」、
> `claim-incident-001` 仍写「项目处于设计完成、编码未开始阶段」。审计时这三条会直接与
> artifact 注册表打架。三条已改为「本条只保留设计判断本身，实现与实测口径以 101 为准」。

> ⚠️ 对外引用时的口径纪律：这两轮**都不能**说「Agent 完美排除了所有误判」。
> 10-26 那轮的准确说法是「四条判定标准 4/4 通过，同时报告里有一个与自己证据表冲突的数字、
> 两次越过只读通道、取证环境有答案泄漏」。
> 10-27 那轮的准确说法是「四条判定标准 4/4 通过，通道零越界，但报告里仍有一处时间差算错
> （20h55m vs 23h55m）与三处过度声称，且取证环境残留 1 处非承重的答案提示，全部主动列出」。
> **不要说「无泄漏环境」**——复核件 §7 就是反例。主动写出缺陷比藏起来更经得起追问。
