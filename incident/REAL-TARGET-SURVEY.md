# 真实靶子勘察：10 个候选项目（脱敏版）

> 勘察日期 2026-11-04。方法：**只采集元数据**（构建文件、依赖名、目录结构、git 统计、
> 日志的异常签名），不读业务代码、不导出业务数据。
> 原因见 [REAL-TARGET.md](REAL-TARGET.md) 的合规章节——这份勘察本身就是那次原则的实操。

> **本文件是脱敏版。** 候选项目一律以 `P1`–`P10` 指代；内部制品库地址、内部产品代号、
> 内部包名与人员姓名已移除。完整版（真实项目对应关系、内部地址）**存在仓库外**，
> 路径见 `incident/lab-paths.json` 的 `archiveDir` 约定——
> 这与「答案键与工作区都不在仓库里」是同一条规则：**公司内部信息不进公开仓库**。
>
> **P1–P10 分别对应哪个真实项目**：对照表只存在仓库外那份完整版勘察文档里，
> 仓库内不保留副本。查的时候按 `lab-paths.json` 的 `archiveDir` 找到
> `target-survey/survey-2026-11-04.full.md`，其中的「P1–P10 ↔ 真实项目对照」一节
> 给出十个代号、真实项目名、制品名与各自定位。

## 候选清单

| 代号    | 技术栈                            |                git commits | 首末提交                    | 磁盘日志               | Actuator              | Prometheus registry | 活跃度           |
| ------- | --------------------------------- | -------------------------: | --------------------------- | ---------------------- | --------------------- | ------------------- | ---------------- |
| **P1**  | Java / Spring Boot / MyBatis-Plus |                       1477 | 2024-05-23 → **2026-11-04** | **174 文件 / 147.6MB** | **全关**              | 有                  | 昨天还在提交     |
| **P2**  | Java / Spring Boot                |                       1103 | 2024-11-11 → 2026-10-19     | 59 文件 / 16.7MB       | **开（health,info）** | 有                  | 半月前           |
| **P3**  | Java / Spring Boot                |                   **7642** | 2021-11-17 → 2026-11-02     | 0                      | 依赖在、无配置        | 无                  | 2 天前           |
| **P4**  | Java / Spring Boot                |                       1585 | 2025-08-02 → 2026-09-07     | 0                      | 全关                  | 有                  | 2 个月前         |
| **P5**  | Java / Spring Boot 多模块         |                        450 | → 2026-10-29                | 24 文件 / 0.7MB        | **无依赖**            | 无                  | 1 周前           |
| **P6**  | Java（+Python 子目录）            | 305+289+19（**3 个仓库**） | 2026-02-02 → 2026-10-29     | 15 文件 / 47.9MB       | 端口开、端点默认关    | 有                  | 1 周前           |
| **P7**  | Java / Spring Boot                |                        475 | 2025-01-10 → 2026-09-17     | 15 文件 / 15.6MB       | 全关                  | 有                  | 1 月前           |
| **P8**  | Python                            |                       1578 | → 2026-07-30                | 0                      | 无                    | 无                  | 3 月前           |
| **P9**  | Python + Java                     |                        326 | → 2026-05-22                | 0                      | 无                    | 无                  | 5 月前           |
| **P10** | Java / Spring Cloud               |                     **22** | → 2025-07-17                | 0                      | 默认开                | 无                  | **1 年半无提交** |

排除理由：

- `P10`：22 个提交、最后提交在一年半前。git 历史深度不够，Agent 无从练"部署归因"。
- `P8` / `P9`：Python 技术栈，无 actuator，观测方案要另起一套。不适合当**第一个**靶子。
- `P5`：**没有 actuator 依赖**，连健康检查都没有。

## 三个决定性发现

### 发现一：没有一个项目开着 `/actuator/prometheus`

`micrometer-registry-prometheus` 依赖在 P1 / P2 / P7 / P4 / P6 都在，
**但 actuator 端点全被关了**：

| 代号    | 配置                                                                                                             | 实际效果                     |
| ------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| P1      | `management.enabled: false`、`endpoints.enabled-by-default: false`、`endpoint.enabled: false`、`server.port: -1` | 完全无 actuator              |
| P7 / P4 | 同上（`server.port: -1`）                                                                                        | 完全无 actuator              |
| P6      | `endpoints.enabled-by-default: false`                                                                            | 端口开、端点全关             |
| P2      | `exposure.include: "health,info"`、`security.enabled: true`                                                      | **只有 health 和 info 开着** |

`management.server.port: -1` 是 Spring Boot 的真开关，会让管理端口整体不启动。
`management.enabled` 反而不是标准属性（大概率是各框架自造的、实际无效）。

**但这不是死路**：Spring Boot 的 relaxed binding 让环境变量覆盖 yaml，
本地跑起来时三个环境变量就能开：

```bash
MANAGEMENT_SERVER_PORT=0                 # 用随机端口，避免与业务端口冲突
MANAGEMENT_ENDPOINTS_ENABLED_BY_DEFAULT=true
MANAGEMENT_ENDPOINTS_WEB_EXPOSURE_INCLUDE=health,info,prometheus,metrics,env,threaddump,loggers
```

**零源码改动**，只在本地副本的启动命令里加环境变量。
`P2` 因为 actuator 本来就在 web 端口上，反而最省事。

### 发现二：P1 的指标标签与 Agent 现有 PromQL 直接兼容

该项目自研了一个 Micrometer starter（内部模块 `<自研 monitor starter>`），
里面只有一个自动配置：

```java
registry.config().commonTags("application", applicationName);
```

它给所有指标打了 `application` 公共标签——**和现有 Agent PromQL 里
`application="target-service"` 的写法完全同构**。换成该服务自己的 application 值
就能直接用同一套查询模板，不需要新写指标适配层。

这个 starter 同时含 `TraceFilter` / `BizTraceAspect`（链路追踪），
意味着日志里有 traceId 可用于关联。

### 发现三：P1 磁盘上有一份**真实故障语料**，48 类异常签名

174 个日志文件、跨 2026-07-07 → 2026-10-30。按异常签名聚合后的高频项：

| 次数 | 异常签名                                                                  | 性质                                     |
| ---: | ------------------------------------------------------------------------- | ---------------------------------------- |
|  536 | `java.io.IOException: 连接被对方重设`                                     | 环境噪声                                 |
|  500 | `org.redisson.client.handler.Error`                                       | 环境噪声（Redis）                        |
|  494 | `SimpleAsyncUncaughtException`                                            | **真信号**：异步任务失败                 |
|  446 | `javax.validation.ConstraintViolationException`                           | **真信号**：入参校验缺陷                 |
|  400 | `RedisTimeoutException: Command execution timeout (PING)`                 | 环境噪声                                 |
|  392 | `org.json.JSONException: No value for database`                           | **真信号**：代码缺陷                     |
|  314 | `java.lang.StringIndexOutOfBoundsException: String index out of range: 8` | **真信号**：代码缺陷                     |
|   92 | `GlobalException`                                                         | **真信号**：业务异常                     |
|   58 | `MySQL CommunicationsException: Communications link failure`              | 环境噪声                                 |
|   24 | `BeanCreationException` / 22 `UnsatisfiedDependencyException`             | **真信号**：Bean 装配失败 = 典型启动故障 |
|   22 | `HttpMediaTypeNotSupportedException`                                      | **真信号**：接口契约缺陷                 |
|   17 | `BadSqlGrammarException` / 16 `SQLSyntaxErrorException`                   | **真信号**：SQL 缺陷                     |

**这份语料最有价值的地方不是数量，是"噪声与信号混杂"。**

约一半的异常是开发机环境问题（Redis 没起、MySQL 连不上、网络不可达），
另一半是真实代码缺陷。合成靶子里**永远不存在这种区分**——
那里所有 500 都来自注入的那一个 bug。

而这恰恰是真实诊断里最难的一步：**先把环境噪声剥掉，再在剩下的信号里找根因**。
合成靶子测不出来这一层能力，所以这是接真实靶子最硬的理由。

### 附带发现：这些日志是**本地开发跑**的，不是生产的

采样 40 个日志文件，全部命中：

```
on <本机名> with PID ... started by <用户> in <本地检出路径>
The following 1 profile is active: "dev"
```

注意路径与当前实际挂载点不一致——**说明这些日志产生于另一台机器或另一次挂载布局**。

含义：

- 好消息：这些是**真实运行的真实失败**，且可与 git 历史对齐
  （日志时间 ↔ commit 时间），完全够做回放
- 需要澄清：**有没有生产环境的日志**（k8s 里的容器日志、ELK、Loki）？
  如果拿得到生产日志，回放素材的质量会有量级差别

## 推荐：分工用两个项目，不要一个项目全包

### 第 0 步（回放历史故障）→ **P1**

理由：语料最厚（147.6MB / 4 个月 / 48 类签名）、git 最活（1477 commits，昨天的提交）、
多作者（5 位主要贡献者）、自研 tracer 与 metrics starter 都在。

做法的雏形：拿 `StringIndexOutOfBoundsException` 或 `BeanCreationException`
某一次出现的**精确时间窗**，配合同时段的 git 提交和当时版本的代码，
让 Agent 独立定位。不注入任何故障，纯回放。

### 第 1 步（体检 + 指标链 + 可逆注入）→ **P2**

理由：actuator **本来就开着**且 `health` 是 `show-details: always`，
prometheus registry 依赖也在——**指标链最顺，最少改动**。
1103 commits、16.7MB 日志也够用。

先在这里把「Prometheus 抓取 → Agent 读指标」这条链打通，
再迁到 P1（那边要先用环境变量把 actuator 撬开）。

### 为什么不用 P1 一包到底

P1 的 actuator 是**显式关闭**的（`server.port: -1`），
在它身上第一次打通指标链时，会把"环境变量能不能覆盖掉关闭的 actuator"
这种不确定性混进来。先在 P2 上把链路走通，是**先易后难**。

## 四个问题的答复（2026-11-05）

> 本节记录勘察问题的答复与**据此产生的设计变更**。
> 答复涉及内部地址与内部平台名，按脱敏约定一律不写进本文件；
> 原文与 P1–P10 的真实项目对照存在仓库外（路径见 `incident/lab-paths.json` 的 `archiveDir` 约定）。

### 答复一：`<BUILD_TAG>` 是 **Jenkins 构建号**，不是 commit sha

这**否定了**原先「tag → commit 一步闭环」的乐观假设：构建号与 commit 之间
没有机器可读的直接对应，必须补一条映射。

现场核查（2026-11-05，只读构建文件与元数据，不读业务代码）：

| 探针                                    | 结果                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------ |
| 三个候选项目是否有 `git-commit-id` 插件 | **都没有** → 应用**不能自己报出 commit**（`/actuator/info` 里也没有）                |
| 是否有 `build-info-maven-plugin`        | **都没有** → jar 内不会有 `git.properties` / `build-info.properties`                 |
| 内部制品库可达性                        | 可达，但 `GET /v2/` 返回 **401** → 需凭据才能 `docker manifest inspect` 看镜像 label |

于是「tag → commit」只剩四条路，按可靠度排：

| #   | 路径                                                                  | 可靠度 | 代价                                         |
| --- | --------------------------------------------------------------------- | ------ | -------------------------------------------- |
| 1   | **Jenkins 构建历史**（构建号 → commit + 构建时间）                    | 高     | 需只读访问 Jenkins API，或人工导出一张对照表 |
| 2   | **镜像 label**（`docker manifest inspect` 看 revision）               | 中     | 需制品库凭据；取决于构建流水线有没有打 label |
| 3   | **人工对照表**（构建号 → commit，缓存后复用）                         | 中     | 一次性问清，之后当账本用                     |
| 4   | **时间邻近推断**（构建号递增 ⇒ 构建时刻 ⇒ 候选 commit 收窄到 1–3 个） | 低     | 无外部依赖，但需人确认                       |

**部署锚点本身不受影响**：`T_dep` 有更硬的来源（容器/进程启动时间、k8s rollout 时刻、
Agent 已有的 `runtime started` 通道）；受影响的只是「**这次部署改了什么**」这一环——
它需要 commit。现有 15 分钟窗口规则要判的正是「commit 的改动」，
所以结论是：**需要一张构建号 → commit 的台账**，而不是需要 Jira。

因此新增一条待建设施：**部署台账（deploy ledger）**——
一份仓库外的 `tag → {commit, build_time}` 映射，由 `incident-readonly` 的 `git` 通道读取，
而不是让 Agent 去猜。

### 答复二：日志有三处来源，各有分工

生产日志在生产环境所在的主机上（代号见仓库外），可复制；
测试环境在 Rancher 上，日志好拿；本地开发环境的旧日志 P1 已有 147.6MB。

「故障不可能只分析一次」这个顾虑成立，解法不是每次重新制造故障，
而是**采集一次、回放多次**：

| 来源                | 拿到什么                      | 适合测什么                             | 缺点                             |
| ------------------- | ----------------------------- | -------------------------------------- | -------------------------------- |
| 生产日志            | 真实故障分布 + **人写的结论** | 回放对照（Agent vs 当年人的结论）      | 素材会过期，要趁早抓；需人工归档 |
| 测试环境（Rancher） | 真实部署产物 + 真实依赖       | **部署归因**（有镜像 tag、有 rollout） | 需自己制造故障，但可逆、隔离     |
| 本地开发旧日志      | 噪声与信号混杂的现成语料      | 信号/噪声剥离能力                      | **无部署锚点**，练不了部署归因   |

关键差别在第三行：本地开发日志能测「从一堆异常里剥出真信号」，
但**测不了「这次发布是不是原因」**——开发环境的部署没有构建号、没有 rollout 时刻。
所以三类不是替代关系。

### 答复三：内网自建推理已具备 → 合规档位 **A** 成立

公司在内网自建平台上部署了 minimax 模型，走公司内网地址，配置由公司自己设置。
这正是 [REAL-TARGET.md](REAL-TARGET.md) 定义的**档位 A**，
「公司代码不外发」的前提**已解除**：真实项目的源码可以进入 prompt。
Miniclaw 侧只需把 Provider 的 `base_url` 指向内网端点，Agent 逻辑不用改。

仍需落实三项（尚未验证）：

- 端点是否 **OpenAI 兼容**（Miniclaw 的 Provider 配置依赖这一点）
- 模型是否支持 **tool calling**（Pi runtime 的工具循环依赖它）与 **streaming**
- 这台开发机能否**直连**该内网地址

⚠️ **换 provider 会分裂模型队列**：合成靶子那 4 轮有效证据属于 deepseek 队列，
内网模型是另一个队列，**两者不能放进同一张「谁更强」的表**。
新模型的轮次要么只跟新模型的轮次比，要么先补一轮新模型下的基线。

### 答复四：所有项目本地都能跑起来

第 4 问（离线还是连内网）不再是阻塞。actuator 端点缺失仍按「发现一」的
三个环境变量处理（零源码改动），与能否启动无关。

## 靶子描述文件（**已落地**）

接真实靶子需要把 `tools/incident-readonly.mjs` 里硬编码的路径与指标名改成配置。
**2026-11-05 已实现**：字段定义与解析规则见
[targets/README.md](targets/README.md)，CLI 侧新增了 `target info` 通道，
并支持按描述文件改写指标标签与限定日志文件。

要点（详细规则见那份 README）：

- 解析顺序：`INCIDENT_TARGET_FILE` → `INCIDENT_TARGET`(+`INCIDENT_TARGET_DIR`) →
  内置默认值。环境变量优先级高于描述文件（轮次编排靠它指向当时的工作区）。
- 合成夹具**不需要**描述文件，行为与改动前逐字节一致（已用旧版 CLI 逐条比对过）。
- **真实靶子的描述文件存在仓库外**（含内部路径与制品库地址），
  和答案键、工作区同一条规则。
- `deploy` 段（构建号 → commit 台账）**尚未实现**——台账的设计见
  [REAL-TARGET.md](REAL-TARGET.md) 的「部署台账」一节，落地时再补这个字段。

## 相关

- [README.md](README.md) — 实验室定位与改动政策
- [REAL-TARGET.md](REAL-TARGET.md) — 接入方案与合规前置
