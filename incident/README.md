# IncidentAgent 实验室

## 这份文档解决什么

这个目录里同时躺着三样东西，它们**不是一回事**，混在一起看会得出错误的结论。
本文档先把三者的边界划清，再说明各自能改什么、怎么验。

| 层         | 是什么                                         | 在哪                                                                   | 是不是产品               |
| ---------- | ---------------------------------------------- | ---------------------------------------------------------------------- | ------------------------ |
| **本体**   | 故障分析 Agent：Prompt + Skills + 只读观测通道 | `agent-profile/`、`skills/`、`tools/`                                  | **是。这才是要做的东西** |
| **试验台** | 被诊断的服务 + 监控 + 故障注入器               | `target-service/`、`prometheus/`、`alertmanager/`、`faults/`、`lab.sh` | 否，是开发夹具           |
| **量具**   | 判据、打分器、闸门、负对照                     | `runs/`                                                                | 否，是测量工具           |

一句话：**产品是本体；`target-service/` 是夹具；`runs/` 是尺子。**

## 为什么必须这么分

最初的设想是"做一个故障分析 Agent"，用 Miniclaw 做底座。
实际做下来，量具这一层膨胀得比本体还快——一度出现"跑一轮要 40 分钟、
其中 38 分钟跟 Agent 无关"的状态。那是**测量装置笨重**，不是 Agent 难做。

所以本目录现在按下面三条纪律维护：

1. **本体优先**：任何改动先问"这让 Agent 变强了吗"，而不是"这让分数变好看了吗"。
2. **尺子冻结**：判据和量具已经够用，不再进化。冻结的东西不许改；要改，走重打分流程。
3. **夹具明说**：`target-service/` 里的故障形态是**合成的**，是我想象的分布，
   不是真实世界的故障分布。它是开发期夹具，**不是产品的一部分**。

## 本体

| 文件/目录                                                  | 作用                                                                                                                                                                         |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [agent-profile/identity.json](agent-profile/identity.json) | 四段 Prompt：IDENTITY / SOUL / AGENTS / TOOLS，以及 Skill 选择策略                                                                                                           |
| [skills/](skills/)                                         | 8 个 Skill：`alert-triage`、`metric-triage`、`log-triage`、`deployment-window`、`git-diff-analysis`、`spring-diagnostics`、`historical-incident-lookup`、`root-cause-report` |
| [tools/incident-readonly.mjs](tools/incident-readonly.mjs) | 只读观测 CLI。Agent 的**唯一**证据通道                                                                                                                                       |

三条设计不变式（改动本体会打破它们，务必确认）：

- **观测只走 CLI**。`docker inspect`、直读容器外配置文件、直读轮转日志文件都算越界，
  即使它们只读。绕过去就放弃了可复核的取证路径。
- **工作区之外不是证据源**。故障清单、既往报告、验收标准、宿主机上工作区外的配置文件，
  读到就等于提前知道答案，轮次作废。
- **证据不足就写证据不足**。通道读不到时，不换路绕过。

## 试验台

| 文件/目录                                                  | 作用                                                                        |
| ---------------------------------------------------------- | --------------------------------------------------------------------------- |
| [target-service/](target-service/)                         | Spring Boot 夹具服务。**合成故障**，开发用                                  |
| [docker-compose.yml](docker-compose.yml)                   | 编排靶子 + Prometheus + Alertmanager                                        |
| [prometheus/](prometheus/)、[alertmanager/](alertmanager/) | 监控与告警配置                                                              |
| [faults/faults.mjs](faults/faults.mjs)                     | 故障注入器：`F2` 代码类、`F4`/`F5` 运行时类                                 |
| [faults/load-hammer.mjs](faults/load-hammer.mjs)           | 压测流量制造                                                                |
| [lab.sh](lab.sh)                                           | 台的启停与编排入口                                                          |
| [lab-paths.json](lab-paths.json)                           | **路径唯一真相源**。工作区、靶子源码、观测 CLI、日志、归档目录              |
| [lab.env.example](lab.env.example)                         | 运行时旋钮样例。真实文件在 `~/.config/miniclaw-lab/lab.env`，**不在仓库里** |

运行时旋钮（`DOWNSTREAM_TIMEOUT_MS`、`DB_POOL_SIZE`）写在仓库外，
因为它同时是**故障注入面**：放在仓库里，Agent 一眼就能看到答案。

### 故障类

| ID   | 类型   | 内容                                               | 判据                                              | 跑过 |
| ---- | ------ | -------------------------------------------------- | ------------------------------------------------- | ---- |
| `F2` | 代码   | 删掉下游返回值的判空兜底 → NPE → 500               | [ground-truth/F2.json](runs/ground-truth/F2.json) | 是   |
| `F4` | 运行时 | 下游读超时旋钮压到 1ms → 读超时 → 空值 → NPE → 500 | [ground-truth/F4.json](runs/ground-truth/F4.json) | 是   |
| `F5` | 运行时 | Hikari 连接池上限降到 2                            | **无判据**                                        | 否   |

`F2` 与 `F4` 的区别是这套台子的核心设计：两者产生**相同的表象**（NPE→500），
但触发层不同（代码 vs 运行时配置），用来测 Agent 会不会错把"最近一次发布"当根因。

## 量具（冻结区）

| 脚本                                                                       | 作用                                                                                       |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [runs/score-report.mjs](runs/score-report.mjs)                             | 打分器：读报告 + 判据 → 分数文件                                                           |
| [runs/calibrate-scorer.mjs](runs/calibrate-scorer.mjs)                     | 判据校准：16 条样例必须与判据预期一致                                                      |
| [runs/rescore-all.mjs](runs/rescore-all.mjs)                               | 用当前判据重打分全部历史轮次                                                               |
| [runs/run-round.mjs](runs/run-round.mjs)                                   | 一轮的编排：前置闸门 → 摆静默态 → 清面 → 注入 → 等告警 → 跑 Agent → 通道审计 → 打分 → 恢复 |
| [runs/channel-audit.mjs](runs/channel-audit.mjs)                           | 通道合规审计：区分**污染**（作废轮次）与**越界**（记录但不作废）                           |
| [runs/independence-audit.mjs](runs/independence-audit.mjs)                 | 样本独立性审计：证据面上有没有**早于本轮注入**的痕迹（污染 ≠ 不独立，两回事）              |
| [runs/leak-scan.mjs](runs/leak-scan.mjs)                                   | 泄漏扫描：查工作区外的答案键是否被读进会话                                                 |
| [runs/gate-w-workspace-isolation.mjs](runs/gate-w-workspace-isolation.mjs) | 闸门 W：工作区与答案键不相邻                                                               |
| [runs/control-arms.mjs](runs/control-arms.mjs)                             | 受控对照实验：同一次故障的三臂对照，用于验证"两个条件叠加"的论断                           |
| [runs/round-table.mjs](runs/round-table.mjs)                               | 把 manifest + score 汇总成一张指标表                                                       |
| `runs/*-control.mjs`                                                       | 负对照：证明量具**认得出**也**认不得**                                                     |

负对照不是形式主义。真实发生过一次：比例量具把 Prometheus 的返回形状认错了，
C 臂真实的 43.6% 5xx 峰值被读成 **0**——**量具坏了，长得却像台子没炸**。
从那以后每个解析类函数都必须配一条负对照。

### 「污染」和「不独立」是两回事

通道审计管的是**越界**：Agent 有没有读了证据面之外的东西。日志目录本来就是合法
证据面，审计按定义放行——哪怕那里面躺着上一轮注入时打的阈值。

那正是**样本独立性**被破坏的样子：后一轮的 Agent 读到了前一轮的注入痕迹，
命中是被提示过的命中。它**不是**越界，`channel-audit` 不该报它；但它也**不是**
干净的证据，命中率不能拿它当分母。

所以有两条独立的闸门：

| 闸门                 | 问的问题                     | 不过关的后果         |
| -------------------- | ---------------------------- | -------------------- |
| `channel-audit`      | Agent 有没有越界             | 该轮作废             |
| `independence-audit` | 这一轮开跑时，证据面干不干净 | 该轮剔出命中率的分母 |

`independence-audit` 量的是**证据面快照**里有没有早于本轮注入时刻的痕迹行。
一轮的日志面在下一轮基线归档时才被完整收走，所以它取的是「下一轮的归档目录」
（最后一轮用当前日志目录），日志时间戳按靶子的本地时区换算成 UTC。
换算错了脚本会自检失败退出，不给一个看着像样其实错的数。

真实靶子的日志目录跨轮累积，所以这条闸门不是摆设：2026-11-10 的两轮就是这样
被判不独立（65 / 129 条陈旧痕迹），指标表的分母从 8 变成 6。

## 改动政策

| 区域                                                                                            | 改动需要什么                                                     |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `runs/ground-truth/*.json`（判据）                                                              | 校准 + 负对照 + **全量重打分**。**不得为了让某一轮通过而改判据** |
| `runs/score-report.mjs`、`runs/calibrate-scorer.mjs`、`runs/rescore-all.mjs`                    | 校准 + 负对照 + 全量重打分                                       |
| `runs/*-control.mjs`（负对照）                                                                  | 负对照自身要被别的负对照覆盖                                     |
| `runs/control-arms.mjs`、`runs/round-table.mjs`                                                 | 对应的负对照必须仍全绿                                           |
| 已产出的轮次产物（`runs/score-*.json`、`runs/agent-report-*.md`、`runs/round-manifest-*.json`） | **只追加，不改写**。产物是证据                                   |
| `runs/run-round.mjs`、`runs/gate-w-*.mjs`、`runs/channel-audit.mjs`、`runs/leak-scan.mjs`       | 改动需附证据：该闸门自身的负对照仍全绿                           |
| `faults/faults.mjs`、`target-service/`                                                          | 夹具，可改；改后重跑该故障类的回归                               |
| `agent-profile/identity.json`、`skills/**`、`tools/**`                                          | **产品本体**。改动即改产品，必须重跑回归                         |
| `runs/ground-truth/` 之外的判据快照 `runs/rubric-snapshots/`                                    | 历史留档，不删不改                                               |

判据版本从 v1 走到 v9 的教训写在 [runs/rubric-snapshots/](runs/rubric-snapshots/) 的命名里。
一条判据如果会让**本该失败的报告通过**，它可能不是被测对象的问题，是判据自己的问题。
先怀疑判据，再改判据。

这九版改的其实是**同一个毛病**：判据在量「排版」而不是在量「诊断」。
v1–v7 反复栽在同一个坑里——报告用「主假设 / 证据缺口」这类别名小标题代替
「根因 / 反对证据」，判据就把它判成 miss；Agent 的诊断其实是对的。
v8 补了标题别名表，v9 又补了两件事：标题后面的余字不再当正文算，
以及 Q4（反对证据）的词表太窄（「未解释」写成「尚未解释」就判 fail）。
**教训**：判据要量的是「有没有说出真相」，不是「有没有照着我写的模板说话」；
一版判据连续改不动，先怀疑自己量错了东西，再去改被测对象。

## 怎么跑一轮

前置条件：`lab.sh up -d --build` 起台子，`~/.config/miniclaw-lab/lab.env` 就位，
Miniclaw 服务在线。一轮的完整流程由 `runs/run-round.mjs` 编排，
单轮墙钟约 30–50 分钟，其中**绝大部分与 Agent 无关**（静默态坐稳 18 分钟、
等告警 ≤5 分钟、容器重建 2–4 分钟），Agent 本身通常 3–5 分钟。

## 怎么写一条判据

判据是"报告里必须出现某类表述"的正则集合，写在 `ground-truth/<ID>.json` 里。
写判据时：

1. **先写反例**。什么报告**不该**通过？先想出来，再写正则。
2. **看一次真实的失败**。拿一份真报告的 FAIL 片段反推模式，别照着理想答案写。
3. **一条判据只管一件事**。别把"定位到配置层"和"排除发布"合成一条，
   否则一半命中就说不清输在哪。
4. **正则的匹配范围要对**。见过一次：判据按行匹配，报告把词换了行就判 FAIL，
   折叠空白后其实命中——那是判据的实现缺陷，不是报告的缺陷。

## 已知边界与欠债

- **host 模式没有沙箱**。Agent 在 host 模式下能直读宿主机任意文件，
  `~/.config/miniclaw-lab/lab.env` 一直可达。台子靠**闸门 W + 通道审计 + 泄漏扫描**
  在事后发现，而不是事前阻断。给团队其他人跑之前，这必须先解决。
- **靶子是合成的**。故障形态只有三种，且是我想象的分布。
  真实靶子的接入方案见 [REAL-TARGET.md](REAL-TARGET.md)。
- **每类只跑过 1–2 轮**。分数是单点，没有方差，不能用来比较"改 prompt 前后谁更好"。
- **`F5` 没有判据**，从未跑过。
- **`incident/` 下的 31 个 `.mjs` 没有类型检查、没有 lint、没有单元测试**。
  只有纯函数（解析、判定）值得补。

## 相关文档

- [RESUME.md](RESUME.md) — 断点存档：当前台子状态、最近做到哪、下一步
- [L1-WORKSPACE-MOVE.md](L1-WORKSPACE-MOVE.md) — 工作区搬出仓库的原因与做法
- [REAL-TARGET.md](REAL-TARGET.md) — 接入真实公司项目作为靶子的方案与前置检查
- [REAL-TARGET-SURVEY.md](REAL-TARGET-SURVEY.md) — 10 个候选项目的勘察结果与选型建议
