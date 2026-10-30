

---

# target-service 5xx 故障诊断报告

> **环境说明**：环境变量 `$INCIDENT_LAB` 指向的路径已失效（`/persistent/home/.../incident-readonly.mjs` 不存在），本轮改用工作区内的 `incident/workspace/tools/incident-readonly.mjs`（`incident-readonly <channel>` 只读工具）。所有查询命令均基于该工具。
> **注意**：本工作区内的 `incident/faults/`（实验台故障定义）我**没有查阅**——那是出题方的答案键，不属于诊断证据链。以下结论全部来自运行时实际输出。

---

## 锚点

```
服务：target-service ｜ 严重级：critical ｜ 告警起始：2026-10-30T03:51:19.991948342Z
```

**告警起始口径（显式声明）**：`metrics alerts` 返回的 `activeAt` = **03:51:19.99Z，是告警进入 pending 的时刻，不是 firing 时刻**。`for` 值从 `/api/v1/rules` 读到 `duration: 30`（规则 `interval: 15s`），因此 **firing ≈ activeAt + 30s = 03:51:50Z**；`/api/v1/rules` 在 `lastEvaluation 03:52:34.99Z` 处确认 `state: firing`。

**服务名降级处理**：告警 labels 只有 `alertname` + `severity`，**缺失 `service`/`job` label**。按 alert-triage 规则声明："告警未指明服务，以下按告警中出现的服务名推断" —— 依据 `annotations.summary: "target-service 5xx error rate above 5%"` 与 `metrics targets` 的 `service="target-service"`，确定目标服务为 target-service（唯一 in-flight target，`health: up`）。

### 三个锚点

| 锚点 | 时间 | 来源 |
|---|---|---|
| ① 告警起始 | **2026-10-30T03:51:19.991948342Z**（pending）；firing ≈ 03:51:50Z | `metrics alerts` → `activeAt`；`/api/v1/rules` → `duration:30` |
| ② 异常首次出现 | **2026-10-30T03:51:07.660Z** | `logs first 'ResourceAccessException' --since 2026-10-29T00:00:00Z` |
| ③ 最近一次部署 | **2026-10-30T03:50:59.186Z**（容器重建） | `runtime started` → `container_started_at` |

**③ 的口径**：全程采用**容器重建时刻**（`container_started_at`），不使用 git commit 时间，也不用应用就绪时刻。作为参考：应用就绪 `app_started_log = 03:51:07.326Z`，旋钮文件 `knob_file_mtime = 03:50:58.645Z`（早于容器重建 0.54s）。

**Δ(② − ③) = 8.474 秒**（若改用应用就绪口径则为 0.334 秒；两者都远在 15 分钟窗口内，口径结论不受影响）。

---

## 1. alert-triage（告警载荷解析）

`metrics alerts` 实际输出：

```json
{ "labels": { "alertname": "HighServerErrorRate", "severity": "critical" },
  "annotations": { "description": "5xx ratio is 43.12% over the last 1m.",
                   "summary": "target-service 5xx error rate above 5%" },
  "state": "firing", "activeAt": "2026-10-30T03:51:19.991948342Z", "value": "4.3125e-01" }
```

同一服务的 warning 级规则 `SlowRequests`（P99 > 2s）当前 `state: inactive`、`alerts: []`，**不另起诊断线**（alert-triage 规则：只以最高级为锚点）。

## 2. metric-triage（异常形态与影响面）

**形态 = 台阶，不是尖刺也不是缓慢增长。** `metrics range`（15s 步长，对齐规则 interval）：

```
03:50:30 0.00%     03:51:15   3.95%
03:50:45  0.00%     03:51:30  18.22%   ← 台阶跳变
03:51:00  0.00%     03:51:45  32.89%
                    03:52:00  43.37% → 03:52:30 42.68%（维持）
```

**形态判读**：一次跳变后维持在新值 → 按 metric-triage 指引走 `deployment-window`，不先查资源类。

**流量未掉**：`sum(rate(http_server_requests_seconds_count{application="target-service"}[1m]))` 全程 2.87–2.91 req/s，03:51:30 后为 2.295→2.469→2.855→2.528。→ **部分失败，不是全挂**。

**受影响接口**（`sum by (uri,status)`，观测于 03:54:19Z）：

| uri | 200 | 500 |
|---|---|---|
| `/api/orders/{id}` | 0.0545 | **1.1818** |
| `/profiles/{userId}` | 1.2545 | 0 |
| `/actuator/health` | 0.2182 | 0 |
| `/actuator/prometheus` | 0.2000 | 0 |

另一条同刻查询（03:52:54Z）：`/api/orders/{id}` 5xx=1.2、总量=1.2202 → **订单接口 98.4% 的请求是 5xx**；同期 `/profiles/{userId}` 总速率 1.2364 全部是 200。

## 3. log-triage（异常首次出现 + 栈顶）

`logs first 'ResourceAccessException' --since 2026-10-29T00:00:00Z`：

```
2026-10-30 03:51:07.660 ERROR [http-nio-8080-exec-1] com.example.target.DownstreamClient -
  profile lookup failed userId=1 cause=org.springframework.web.client.ResourceAccessException:
  I/O error on GET request for "http://127.0.0.1:8080/profiles/1": Read timed out
```

紧随其后的完整栈顶：

```
java.lang.NullPointerException: Cannot invoke "java.util.Map.get(Object)" because "profile" is null
    at com.example.target.OrderService.loadOrder(OrderService.java:29)
    at com.example.target.OrderController.get(OrderController.java:21)
```

```
首次出现：2026-10-30T03:51:07.660Z异常类型：ResourceAccessException(Read timed out) → NullPointerException
栈顶：com.example.target.OrderService.loadOrder(OrderService.java:29)
分布：全部落在 /api/orders/{id}；/profiles 本身全部 200
```

**负证据（量化，不用数行数）**：

| 查询 | 结果 |
|---|---|
| `logs grep 'Read timed out' --since 2026-10-30T00:00:00Z --until 2026-10-30T03:50:59Z --count` | **0** |
| `logs grep 'Read timed out' --since 2026-10-30T03:50:59Z --count`（快照 03:55:59Z） | **329**，仍在增长 |
| `logs grep 'userId=9999' --since 2026-10-30T00:00:00Z --count` | **8**（全天） |
| `logs grep 'loaded for user' --since 2026-10-30T03:40:00Z --until 2026-10-30T03:50:59Z --count` | **824** 次成功加载 |

**关键辨析（两个不同故障，勿混淆）**：
- 03:50:57.645Z 有一条 `userId=9999 cause=HttpClientErrorException$NotFound: 404` + NPE。这是**旧的、长期存在的低频缺陷**（F2潜伏路径），全天仅 8 次，对应基线 0.6% 的 5xx；**它不是本次故障的诱因**（见"已排除假设"）。
- 03:51:07.660Z 起的 `Read timed out` 路径才是本次台阶式故障的异常，**首次出现 = 03:51:07.660Z**。

## 4. deployment-window（部署相关性判定）

`runtime started`：

```
container_started_at: 2026-10-30T03:50:59.186064107Z
app_started_log:      2026-10-30 03:51:07.326 ... Started TargetServiceApplication in 6.948 seconds
```

`runtime env`（运行时旋钮生效值）：

```
DOWNSTREAM_TIMEOUT_MS=1          ← 1 毫秒
DB_POOL_SIZE=10
LOAD_ENABLED=true
LOAD_PATHS=/api/orders/1,/api/orders/3,/api/orders/4,/api/orders/5
SPRING_DATASOURCE_HIKARI_CONNECTION_TIMEOUT=30000
knob_file: /home/fs-user/.config/miniclaw-lab/lab.env
knob_file_mtime: 2026-10-30T03:50:58.645Z (last edit of the knob file)
```

`docker-compose.yml:23` 的默认值是 `DOWNSTREAM_TIMEOUT_MS: "${DOWNSTREAM_TIMEOUT_MS:-2000}"`。

**判定：T_dep (03:50:59.186) ≤ T_err (03:51:07.660) ≤ T_dep + 15min → 高度相关**，继续 `git-diff-analysis`。

## 5. git-diff-analysis（时间相关 → 代码相关）

```
$ git log --since 2026-10-30T03:45:00Z --until 2026-10-30T04:00:00Z --limit 20
(空 —— 部署窗口内无代码变更)

$ git log --since 2026-10-30T00:00:00Z --limit 20
(空 —— 当天无任何提交)

$ git status --porcelain
(空 —— 无未提交改动)

$ git log -1
072d275d 2026-10-26T07:29:26Z fix(tool): keep `git file` reads inside the repository root
```

**窗口内无代码变更** —— 这本身就是排除"本次发布引入缺陷"的依据，不是"没查到"。

为完整起见，仍检查了服务代码最近一次变更 `3ca923c`（2026-10-26T07:23:25Z）：

```diff
-        if (profile == null) {
-            order.put("ship_to", "UNKNOWN");
-        } else {
-            order.put("ship_to", profile.get("address"));
-        }
+        order.put("ship_to", profile.get("address"));
```

它**删除了 null 兜底**，使 `OrderService.loadOrder:29` 在 `profile == null` 时必然 NPE。这解释了**失效链的第二段**，但**不是本次故障的触发因**（该提交4 天前就已上线，且上一容器从 02:12:00 跑到 03:50:58 全程健康）。

**代码层完整失效链**（三段全部由本次证据闭合）：

| 环节 | 证据 |
|---|---|
| ① 旋钮被改成 1ms | `runtime env` → `DOWNSTREAM_TIMEOUT_MS=1`；`knob_file_mtime = 03:50:58.645Z`（容器重建前 0.54s）；compose 默认值 2000 |
| ② 1ms 进入 RestTemplate 超时 | `application.yml:23` `timeout-ms: ${DOWNSTREAM_TIMEOUT_MS:2000}`；`RestTemplateConfig.java:20-21` `setConnectTimeout/setReadTimeout(Duration.ofMillis(timeoutMs))` |
| ③ 超时 → null → NPE → 500 | `DownstreamClient.java:35-38` catch 后 `return null`；`OrderService.java:29` `profile.get("address")` 无判空；日志栈顶 NPE + `Read timed out` |

## 6. spring-diagnostics（排除资源类/依赖类）

```
actuator health: {"status":"UP","components":{"db":{"status":"UP","database":"H2"},"diskSpace":"UP","ping":"UP"}}

actuator metrics/hikaricp.connections.active   = 1.0
actuator metrics/hikaricp.connections.idle     = 9.0
actuator metrics/hikaricp.connections.pending  = 0.0    ← 无排队
actuator metrics/hikaricp.connections.timeout  = 0.0    ← 无获取超时
actuator metrics/hikaricp.connections.max      = 10.0
actuator metrics/http.client.requests.active   = 0 (ACTIVE_TASKS)
actuator metrics/process.uptime                = 201.432 s

actuator threaddump: 25 线程，状态 {RUNNABLE:7, WAITING:11, TIMED_WAITING:7}
  http-nio-8080-exec-1..10 全部 WAITING（Unsafe park，即 Tomcat 线程池空转）
  无任何线程阻塞在 HikariPool.getConnection 或 socketRead
```

**运行时证据**：连接池 active=1/idle=9/pending=0/timeout=0，无线程阻塞在连接获取或下游 socket读取，health 全 UP。
**结论方向**：**排除资源耗尽类与外部依赖宕机类**；故障是客户端超时参数导致的确定性竞态失败。

---

# root-cause-report**服务**：target-service ｜ **严重级**：critical ｜ **告警起始**：2026-10-30T03:51:19.991948342Z（activeAt/pending；firing ≈ 03:51:50Z，for=30s）

## 【根因假设】

**置信度：0.95**

**机制**：容器重建时随环境注入的 `DOWNSTREAM_TIMEOUT_MS=1`（1 毫秒）把 `RestTemplate` 的 connect/read timeout 压到 1ms，导致 `OrderService.loadOrder` 内部发往本机 `http://127.0.0.1:8080/profiles/{userId}` 的自调用读超时；`DownstreamClient.fetchProfile` 捕获异常后 `return null`，`OrderService.loadOrder:29` 未判空直接 `profile.get("address")` → NullPointerException → `/api/orders/{id}` 返回 500，告警随之 firing。

> 定性：**运行期配置变更类（旋钮层）故障**，而非代码发布类故障。

## 【支持证据】

| # | 证据 | 来源 | 时间 |
|---|---|---|---|
| 1 | `DOWNSTREAM_TIMEOUT_MS=1`，compose 默认值为 2000 | `runtime env` / `docker-compose.yml:23` | 观测 03:52Z |
| 2 | 旋钮文件 `knob_file_mtime = 03:50:58.645Z`，容器重建 `03:50:59.186Z` | `runtime env` / `runtime started` | 03:50:58–59Z |
| 3 | 首个5xx 异常 `Read timed out` + NPE，栈顶 `OrderService.loadOrder(OrderService.java:29)` | `logs first 'ResourceAccessException'` | **03:51:07.660Z** |
| 4 | 重建前当天 `Read timed out` 计数 **0**；重建后 **329**（持续增长） | `logs grep --count` | 快照 03:55:59Z |
| 5 | 重建前 03:40–03:50:59 共 **824** 次 `order loaded` 成功；最后成功一次03:50:58.501Z | `logs grep 'loaded for user'` | 03:50:58.501Z |
| 6 | 代码链：yml `timeout-ms: ${DOWNSTREAM_TIMEOUT_MS:2000}` → `RestTemplateConfig:20-21` → `DownstreamClient:35-38 return null` → `OrderService:29` 无判空 | 源码 + `git diff 3ca923c` | 代码现状 |
| 7 | 形态为台阶（0% → 18.22%@03:51:30 → 43.37%@03:52:00 并维持），与容器重建精确对齐 | `metrics range` 15s | 03:51–03:52Z |
| 8 | 订单接口 98.4% 请求为 5xx（1.2/1.2202）；同期 `/profiles/{userId}` 1.2364 全部 200 | `metrics query` by(uri) | 03:52:54Z |
| 9 | 部署窗口内无提交、当天无提交、无未提交改动 | `git log --since2026-10-30`、`git status` | 03:52Z |
| 10 | 连接池 active=1/idle=9/pending=0/timeout=0；25 线程无阻塞；health 全 UP | `actuator metrics/health/threaddump` | 03:53–03:55Z |
| 11 | 重建后仍有零星成功（`order 1 loaded for user 1` 首现 03:52:18.188Z，之后零星） | `logs grep 'loaded for user'` | 03:52:18Z 起 |

**证据 8 + 3 的联合解读**：客户端1ms 超时先放弃、Tomcat 线程随后仍把 `/profiles` 请求处理完并返回 200 —— 所以"下游看起来完全健康"恰恰是超短客户端超时的指纹，而不是排除超时类的依据。

**证据 11 的意义**：失败是竞态（96% 失败 / 4% 成功）而非逻辑必然，指向超时边界，而非数据或代码分支问题。

## 【反对证据 / 尚未解释】

1. **下游服务本身完全正常，与"故障在下游"不矛盾但需说明**：本次故障的失败发生在调用方（订单线程）侧，下游返回的是 200，这已由证据 8/3 闭合；但若要完全排除"下游在某些时刻确实变慢"，还缺一份"自调用在 1ms 内成功所需的 P99耗时"基线 —— 不过**该基线不影响结论**，因为同一份代码在重建前以 2000ms 超时全程 0 次超时（证据 4/5）。
2. **`/api/orders/2` 的调用来源未查明**：`http.client.requests` 的 uri 标签只含 `/api/orders/1,3,4,5` 与 `/profiles/1,3,4,5`，不含 `/api/orders/2`，但日志里确有8 次 `userId=9999` 请求 → 请求 `/api/orders/2` 的是**外部探针**而非负载驱动。这属于 F2 潜伏路径的触发者，不影响本次根因，但来源未定位。
3. **旋钮文件的变更人与变更意图未知**：文件 mtime 只给出"何时被改"，不给出"谁改的/为什么"。这不影响技术根因判定，但影响后续治理。
4. **未验证"把超时调回 2000ms 即可恢复"** —— 本 Agent 无写权限，无法做因果验证实验。该动作列为处置建议草案。

## 【已排除的假设及排除依据】

| 假设 | 结论 | 排除依据 |
|---|---|---|
| **发布变更（代码）引入缺陷** | **排除** | `git log --since 2026-10-30T00:00:00Z` 为空；`git log --since 2026-10-30T03:45:00Z --until 04:00:00Z` 为空；`git status --porcelain` 为空。服务代码最后变更 `3ca923c` 停留在 2026-10-26T07:23:25Z。**同一份代码**在上一容器（02:12:00.991Z 启动）中从 02:12 跑到 03:50:58.501 全程健康（824 次成功加载、0 次 Read timed out）→ 代码未变而行为突变，变化量只能来自运行时环境 |
| **代码缺陷 `3ca923c`（删掉 null 兜底）** | **不是触发因**（是失效链的放大器） | 该缺陷需 `profile == null` 且订单被实际请求才显现。`data.sql:8` 显示订单 2→user 9999 无 profile；容器 `LOAD_PATHS` 不含 `/api/orders/2` → 该路径处于休眠态，全天仅 8 次（`userId=9999 --count` = 8），对应0.6% 基线噪声。且本次 329 次失败**全部**为 `Read timed out` 路径，与404 路径在日志文案上可区分 |
| **下游服务故障 / 依赖宕机** | **排除** | `actuator health` → `db:UP`、`ping:UP`、`diskSpace:UP`；异常类型是 `ResourceAccessException: Read timed out`（读超时）而非 connection refused / 5xx；`/profiles/{userId}` 1.2545 req/s 全部 200（服务侧处理正常）；`http.client.requests.active = 0`（无卡住的外部调用） |
| **资源耗尽（连接池/线程/内存）** | **排除** | `hikaricp.connections.pending = 0`、`timeout = 0`、`active = 1`、`idle = 9`、`max = 10`；threaddump 25 线程无阻塞在 `HikariPool.getConnection` 或 socketRead，exec 线程全为 WAITING(park)；指标形态是**台阶**而非缓慢增长，不符合资源耗尽特征 |
| **数据库故障** | **排除** | `actuator health` → `db:UP`（H2, validationQuery isValid()）；`OrderService.java:23` 的 `jdbc.queryForMap` 在栈顶之前完成（栈顶在第 29 行），DB 调用未报错 |
| **慢查询 / 索引问题** | **排除** | `schema.sql` 的 `idx_orders_create_time` 与本次按主键 `id` 查询无关；DB 查询未出现在异常栈中；进程运行时长仅 201s，无堆积 |
| **告警阈值过敏 / 误报** | **排除** | 5xx 速率 1.18 req/s 是真实 HTTP 500（`by(uri,status)` 实测），且与329 条后端 NPE 堆栈一一对应；不是指标抖动 |
| **`ALERTS_FOR_STATE` 可用于推 `for`** | **排除（口径修正）** | 该指标实测值 1793332279 = activeAt 的 epoch 秒，而非 `for` 时长。`for` 实际取自 `/api/v1/rules` 的 `duration: 30` |

## 【跳过的步骤及原因】

| 步骤 | 状态 | 原因 |
|---|---|---|
| `actuator env` / `actuator configprops` 判读生效值 | **跳过（主动）** | 实测 `actuator env` 中 `app.downstream.timeout-ms = ******`、`app.load.paths = ******` 全被掩码，只能证明配置项存在、不能证明生效值；生效值改由 `runtime env` 取得（spring-diagnostics 技能明示要求）。执行 `actuator env` 仅用于确认掩码事实，未用于任何结论 |
| `git-diff-analysis` 中"逐个看窗口内 commit 的 diff" | **部分跳过** | 部署窗口（03:50:59前后）内**无任何提交**，故无需逐 commit 分析；已额外检查服务代码最近一次提交 `3ca923c` 以将其判定为"无关变更/放大器"而非触发因。"窗口内无代码变更"本身即写入了排除依据 |
| `historical-incident-lookup` | **已执行，不作为结论来源** | 召回 1 条 `lesson`（`target-service.5xx.triage-method`），内容为方法论与症状词汇，**不含任何一次故障的结论**。本轮仅采用其方法（锚点口径、负证据用 `--count`、部署锚点用容器重建而非 commit 时间）；其结论未被套用，全部锚点与机制均独立取证 |
| `faults/` 目录（实验台故障定义） | **主动不查** | 属于实验设计/答案键，不是运行时证据；查它会使结论失去诊断意义。已在报告开头声明 |
| 因果验证实验（改回 2000ms 验证恢复） | **跳过** | 本 Agent 在诊断阶段无写权限。改为在"处置建议"中给出人工执行的命令草案 |
| `alertmanager` 通知链路 / `metrics targets` 的多实例比较 | **跳过** | `metrics targets` 仅1 个 target（`instance: target-service:8080`，`health: up`），无第二实例可比对；告警经 Prometheus 规则直接产生，不影响根因 |

## 【处置建议（仅草案，不执行）】

**A. 立即止血（恢复下游超时）** —— 交人工执行：

```bash
# 1) 备份当前旋钮
cp ~/.config/miniclaw-lab/lab.env ~/.config/miniclaw-lab/lab.env.bak.$(date -u +%Y%m%dT%H%M%SZ)

# 2) 恢复下游超时到 compose 默认值（2000ms）
sed -i 's/^DOWNSTREAM_TIMEOUT_MS=.*/DOWNSTREAM_TIMEOUT_MS=2000/' ~/.config/miniclaw-lab/lab.env
grep '^DOWNSTREAM_TIMEOUT_MS' ~/.config/miniclaw-lab/lab.env   # 期望输出 DOWNSTREAM_TIMEOUT_MS=2000

# 3) 以新旋钮重建容器（该服务为 --no-deps 独立重建，不触碰 prometheus/alertmanager）
cd <incident-dir> && ./lab.sh recreate

# 4) 验证（只读通道）
node tools/incident-readonly.mjs runtime env      # 期望 DOWNSTREAM_TIMEOUT_MS=2000
node tools/incident-readonly.mjs runtime started  # 期望 container_started_at 为新的时刻
node tools/incident-readonly.mjs logs grep 'Read timed out' --since <重建时刻> --count   # 期望 0
```

**B. 恢复后预期**：5xx 速率应回落至本次事故前的基线 —— 即 **约 0.6%**（全天 8 次 `userId=9999` 的 F2 潜伏路径 500，出现在 03:02–03:19 等时点）。若恢复后 5xx 未归零，说明止血未生效，请回到 `runtime env` 复核生效值。

**C. 代码层加固（独立于止血，建议排期）**：

1. `OrderService.loadOrder` 恢复 null 兜底（`3ca923c` 删除的那段），或让 `DownstreamClient.fetchProfile` 返回 `Optional`/空 Map 而非 null；否则任何下游 404 或超时都会直接变成 500 —— 本次事故中「1ms 超时」与「订单 2 无 profile」两种完全不同的问题都汇聚到同一行 `OrderService.java:29`。
2. `DownstreamClient` 区分「下游 404（业务性缺失）」与「超时（可重试）」，不要用同一个 `return null` 抹平，否则日志文案不区分、告警归因困难（本次差点被 `userId=9999` 的 404 噪声带偏）。
3. 给 `app.downstream.timeout-ms` 加**下限校验**（如 `< 50ms` 视为配置错误并拒绝启动），避免再次出现 1ms 这类"合法但荒谬"的值。
4. `DownstreamClient` 调用的是 `http://127.0.0.1:8080/profiles/{id}`（同一 JVM 自调用）。这既制造了不必要的线程切换，也是超时参数被调小的真实风险点；建议改为进程内 `ProfileService` 调用，或在配置中明确标注该 base-url 为自调用。

**D. 治理**：旋钮文件在容器外、无变更审计（只有 mtime）。建议对 `$HOME/.config/miniclaw-lab/lab.env` 的修改加审计日志，否则"谁把超时改成 1ms"永远查不到（见"反对证据"第 3 条）。

---

## 附：本轮写入的工作区记忆

新增1 条 `lesson`（`target-service.5xx.selfcall-timeout-heuristic`，id `wmi_1b2a6934-888d-456e-9daa-57e0d5a0714f`），只记录可复用的方法：该服务的"下游"是同 JVM 自调用，超短 read timeout 会表现为**下游 200 速率正常 + 调用方大面积 500**，下次排查不要据此排除超时类；以及"生效值只能从 `runtime env` 读"。未写入本次事故的结论。

---

## 一句话结论

**target-service 的 5xx 不是代码发布引起的，而是03:50:59 容器重建时注入的运行期旋钮 `DOWNSTREAM_TIMEOUT_MS=1`（1 毫秒）导致的**：1ms 的读超时让订单接口对本机 `/profiles/{id}` 的自调用全部超时，`DownstreamClient` 吞掉异常返回 null，`OrderService.loadOrder:29` 未判空抛 NPE，订单接口 98% 请求返回 500，03:51:20 告警进入 pending、约 03:51:50 firing。同一份代码在重建前运行 1.5 小时零超时、零连接池压力、依赖与线程栈全部健康，可排除发布类、依赖类与资源类假设。
