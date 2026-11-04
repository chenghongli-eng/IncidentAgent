# 真实靶子勘察：10 个候选项目（脱敏版）

> 勘察日期 2026-11-04。方法：**只采集元数据**（构建文件、依赖名、目录结构、git 统计、
> 日志的异常签名），不读业务代码、不导出业务数据。
> 原因见 [REAL-TARGET.md](REAL-TARGET.md) 的合规章节——这份勘察本身就是那次原则的实操。

> **本文件是脱敏版。** 候选项目一律以 `P1`–`P10` 指代；内部制品库地址、内部产品代号、
> 内部包名与人员姓名已移除。完整版（真实项目对应关系、内部地址）**存在仓库外**，
> 路径见 `incident/lab-paths.json` 的 `archiveDir` 约定——
> 这与「答案键与工作区都不在仓库里」是同一条规则：**公司内部信息不进公开仓库**。

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

## 还需要确认的四件事

1. **`<BUILD_TAG>` 是什么？**
   k8s 清单里是 `<内部制品库>/<服务名>:<BUILD_TAG>`。
   仓库里**没有 CI 配置文件**（`.gitlab-ci.yml` / `Jenkinsfile` / `.github/` 全都没有），
   说明 CI 在另一个仓库或平台侧。
   **如果 BUILD_TAG 就是 git commit sha**，那部署锚点直接闭环：
   镜像 tag → commit → 代码与时间戳，一步到位，不需要 Jira。
   如果是构建号，则需要一张「构建号 → commit」的对照表。

2. **有没有生产日志可拿？**（k8s 容器日志 / ELK / Loki）
   磁盘上的是开发日志，生产日志的回放素材价值高得多。

3. **公司内部有没有能跑大模型的服务器或 AI 网关？**
   换个说法：除了外部的商业模型服务，**公司自己有没有一台带 GPU 的机器，
   或者一个统一的内部 AI 接口**（能填 base_url 的那种）？
   有 → 公司代码不外发；没有 → 接公司项目时只能降级为"只喂脱敏事实，不喂源码"。

4. **本地跑起来依赖什么？**
   配置文件里有指向外部配置源的 `config:` 段，加上 Druid 多数据源、Redis、Kafka。
   确认本地开发环境已经能连上这些（离线能跑，还是要连内网服务）。

## 靶子描述文件（草案）

接真实靶子需要把 `tools/incident-readonly.mjs` 里硬编码的路径与指标名改成配置。
建议形状如下——**这是草案，等上面第 4 问确认后再落地**：

```json
{
  "id": "<靶子代号>",
  "application": "<spring.application.name>",
  "repoPath": "<本地检出路径>",
  "logsDir": "<本地运行时确认>",
  "prometheusUrl": "http://localhost:9090",
  "actuator": { "baseUrl": "http://localhost:<port>", "mode": "web" },
  "metricLabel": { "application": "<spring.application.name>" },
  "deploy": { "imageRegistry": "<内部制品库>", "tagPattern": "<BUILD_TAG>" },
  "notes": "本项目的 actuator 默认暴露 health,info；prometheus 端点需显式开启"
}
```

## 相关

- [README.md](README.md) — 实验室定位与改动政策
- [REAL-TARGET.md](REAL-TARGET.md) — 接入方案与合规前置
