# 靶子描述文件（target descriptor）

`tools/incident-readonly.mjs` 是 Agent 的**唯一**证据通道。靶子（被诊断的服务）
因此必须是**数据**，不是代码：新增一个靶子不改 CLI、不改编排脚本。

描述文件就是一个 JSON，告诉 CLI 这个靶子叫什么、日志在哪、代码在哪、
Prometheus 在哪、actuator 在哪、它的指标带什么标签。

## 怎么被找到

按顺序，第一个命中为准：

| 顺序 | 环境变量               | 含义                                                                                                         |
| ---- | ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1    | `INCIDENT_TARGET_FILE` | 描述文件的绝对路径                                                                                           |
| 2    | `INCIDENT_TARGET`      | 靶子**名字**，在 `INCIDENT_TARGET_DIR`（冒号分隔）里找 `<名字>.json`；找不到再到 CLI 旁边的 `../targets/` 找 |
| 3    | （都没有）             | 用内置默认值——实验室的合成夹具走的就是这条                                                                   |

环境变量（`PROMETHEUS_URL`、`TARGET_URL`、`LOG_DIR`、`TARGET_REPO`、`TARGET_CONTAINER`）
**优先级高于描述文件**：轮次编排用它们把通道指向当时的工作区。

## 字段

| 字段                 | 必填 | 说明                                                          |
| -------------------- | ---- | ------------------------------------------------------------- |
| `id`                 | 是   | 靶子代号（报告与台账里用它）                                  |
| `application`        | 是   | 靶子**自己的**指标带的标签值                                  |
| `metricLabelName`    | 否   | 标签名，默认 `application`                                    |
| `metricLabelAliases` | 否   | 需要被改写成 `application` 的旧字面量（见下）                 |
| `prometheusUrl`      | 是   | Prometheus 基址                                               |
| `actuatorBaseUrl`    | 是   | actuator 基址                                                 |
| `logsDir`            | 是   | 日志目录                                                      |
| `repoPath`           | 是   | 目标服务的 git 仓库（`git` 通道在这里执行）                   |
| `container`          | 否   | docker 容器名；用于 `runtime started` 取启动时刻              |
| `appStartedPattern`  | 否   | 应用启动日志的标志串，默认 `Started TargetServiceApplication` |
| `startedAt`          | 否   | 非容器靶点的启动锚点（ISO）；docker inspect 不可用时兜底      |
| `logFiles`           | 否   | 只读这些日志文件（支持 `*`）；不填就读目录下全部 `.log`       |
| `ledgerPath`         | 否   | 部署台账（append-only JSONL）的绝对路径；`deploy` 通道用      |
| `notes`              | 否   | 给人看的备注，会出现在 `target info` 里                       |

## 部署台账：也是环境变量优先

`deploy` 通道读的是一份**仓库外**的 JSONL（设计见 `incident/DEPLOY-LEDGER.md`）。

| 环境变量                         | 默认  | 说明                                      |
| -------------------------------- | ----- | ----------------------------------------- |
| `DEPLOY_LEDGER`                  | —     | 台账路径，**覆盖**描述文件的 `ledgerPath` |
| `DEPLOY_LEDGER_STALE_HOURS`      | `24`  | 超过多久没采集就算过期                    |
| `DEPLOY_MATCH_TOLERANCE_SECONDS` | `600` | `deploy current` 锚点配对的容差           |

和日志/仓库/容器一样，环境变量赢过描述文件。**`deploy` 通道不联网、不持凭据**：
采集是另一个进程的事，CLI 只读文件。

## actuator 认证：走环境变量，不走描述文件

真实靶子的 actuator 几乎都在鉴权后面。凭据**只从环境变量读**：

| 环境变量                                  | 含义                                              |
| ----------------------------------------- | ------------------------------------------------- |
| `ACTUATOR_TOKEN`                          | 直接放进 `Authorization` 头（不带 `Bearer` 前缀） |
| `ACTUATOR_USERNAME` + `ACTUATOR_PASSWORD` | 走 Basic 认证                                     |

**凭据不进描述文件**：描述文件是可以被复制的，凭据不该跟着描述文件一起走。
两个都不设时，actuator 通道发匿名请求（靶子没开鉴权时可用）。

## 两条容易踩的规则

**指标标签别名。** Skill 里的 PromQL 例子按合成夹具的字面量写
（`application="target-service"`）。换靶子时这个字面量要变成靶子自己的标签值。
做法是把它写进 `metricLabelAliases`，由 CLI 改写——**CLI 是唯一证据通道，
映射归它管**。改写发生时，CLI 会在 **stderr** 打印实际执行的查询
（stdout 保持纯 JSON，因为打分器和负对照要解析它）：

```
effective query: sum(rate(http_server_requests_seconds_count{application="<目标应用>",status=~"5.."}[1m]))
```

`{{APP}}` 是显式占位符，效果相同。

**日志文件选择。** 靶子可能按级别分文件（`all.log` / `info.log` / `warn.log`），
同一行会出现在多个文件里——`--count` 会**数两遍**。
用 `logFiles` 指定只读哪几个（例如 `["all.log", "all-*.log"]`），计数才只有一个含义。

## 真实靶子的描述文件不在仓库里

真实靶子的描述文件含内部路径与内部制品库地址，**存在仓库外**
（`lab-paths.json` 的 `archiveDir` 约定），和答案键、工作区同一条规则。

仓库里只留这份说明。合成夹具不需要描述文件——它的路径由 CLI 相对自身位置推出，
行为与改动前逐字节一致。
