诊断完成。以下是完整报告。

---

# target-service 5xx 故障诊断报告

**服务**：target-service ｜ **严重级**：critical ｜ **告警起始**：`activeAt=2026-10-30T04:23:49.991948342Z`（Prometheus v1 的 pending 时刻）
**告警规则**：`HighServerErrorRate`，`for=30s`，阈值 5xx 比例 > 0.05 → **firing ≈ 2026-10-30T04:24:19.99Z**（activeAt + for）
> 告警 labels 里**没有** `service`/`job` label（仅 `alertname`+`severity`），服务名由 `annotations.summary` 与 `metrics targets`（`job=service=target-service`）确定。当前仍 firing：`value=4.1605e-01`（04:28:48Z）。

## 三个锚点

| 锚点 | 时间 (UTC) | 来源 |
|---|---|---|
| ① 告警起始 | `activeAt` 04:23:49.991948342Z → firing ≈ 04:24:19.99Z | `metrics alerts`；`for` 取自 `/api/v1/rules`（`for=30`） |
| ② **异常首次出现** | **03:51:07.660Z**（首条下游读超时 → NPE → 500） | `logs first 'Read timed out' --since 2026-10-30` |
| ③ 最近一次部署 | **04:23:23.657Z**（容器重建） | `runtime started` → `container_started_at` |

**部署口径（全程只用这一个）**：以**容器重建** 04:23:23.657Z 为 T_dep（应用就绪 04:23:36.405Z 作为辅助）。

**Δ(②−③) = 03:51:07.660 − 04:23:23.657 = −32m16s** → 故障**早于**本次部署。

## 诊断链（每步：查询 → 输出 → 结论）

### 1. metric-triage：形态是「台阶」，不是尖刺也不是缓慢增长

```
metrics range 'sum(rate(http_server_requests_seconds_count{application="target-service",status=~"5.."}[1m]))
              / clamp_min(sum(rate(http_server_requests_seconds_count{application="target-service"}[1m])),0.001)'
```
输出要点（UTC）：02:14–03:51 基线 0（偶发 0.0061=1/164 单笔噪声）；**03:51:30 起 0.182 → 03:52:00 起 0.4337 并维持**；03:58–04:24 区间该序列**整体消失**（分子序列不存在＝该时段无 5xx）；04:24:00 起恢复 0.4326 / 0.4337。

→ 台阶形态（跳变后维持新值）⇒ 指向配置/发布后的稳态差异，走 `deployment-window`；**排除**资源耗尽型（那会是缓慢单调上升）。
→ `up{job="target-service"}` 输出：03:40:00=1、03:57:30=0、03:58:00=1、**04:23:30=0**、04:24:00=1 → 服务本身没有宕机 25 分钟，那段空洞是「无 5xx」而非「无服务」。
→ 受影响接口（`sum by (uri,status)` @04:27:00Z）：`500 /api/orders/{id}` = 1.2182/s，`200 /profiles/{userId}` = 1.2364/s，`200 /actuator/*` 合计 ≈ 0.42/s。总请求恒定 2.85 req/s。43% 是被应用自身内部流量（/profiles + actuator）稀释后的比例，**订单接口实际失败率 ≈ 98.5%**。

### 2. log-triage：异常首次出现 = 03:51:07.660Z

```
logs first 'Read timed out' --since 2026-10-30T00:00:00Z
→ 2026-10-30 03:51:07.660 ERROR [http-nio-8080-exec-1] com.example.target.DownstreamClient -
  profile lookup failed userId=1 cause=org.springframework.web.client.ResourceAccessException:
  I/O error on GET request for "http://127.0.0.1:8080/profiles/1": Read timed out
```
窗口计数（`--count`，只计带时间戳行）：

| 窗口 | Read timed out | NullPointerException |
|---|---|---|
| 00:00–03:51 | 0 | 8 |
| **03:51–03:58** | **389** | **389** |
| 03:58–04:23:30 | 0 | 0 |
| 04:23:30–04:40 | 196 | 198 |

→ 故障**只存在于两个窗口**，中间 25 分钟完全健康。
→ 首个 NPE 栈顶：`at com.example.target.OrderService.loadOrder(OrderService.java:29)` ← `at com.example.target.OrderController.get(OrderController.java:21)`，异常文本 `Cannot invoke "java.util.Map.get(Object)" because "profile" is null`。
→ **基线噪声须与故障区分**：今日 02:13:43.726Z 起有 8 次 `userId=9999` 的下游 **404** → NPE；该路径 10-28 有 27 次、10-29 有 1 次，属长期存在的基线，**不是本次故障起点**（对应记忆里的锚点口径 1）。

### 3. deployment-window：部署不是起因，但把已存在的坏配置带进了新容器

```
runtime started
→ container_started_at: 2026-10-30T04:23:23.657177918Z
→ app_started_log:     2026-10-30 04:23:36.405 ... Started TargetServiceApplication in 11.149 seconds
```
完整重建序列（`logs grep 'Shutdown initiated'` + `runtime started` + `runtime env` 的 knob mtime）：

```
04:23:22.947Z  knob 文件 lab.env 被修改（runtime env: knob_file_mtime）
04:23:23.266Z  旧容器优雅关闭（HikariPool Shutdown initiated）
04:23:23.657Z  新容器启动          ← T_dep
04:23:36.405Z  应用就绪
04:23:37.043Z  第一条下游读超时（就绪后 638ms）
04:23:49.99Z   告警 activeAt（pending）
04:24:19.99Z   告警 firing
```
今日容器谱系（`logs grep 'Started TargetServiceApplication'`）：02:12:00.991（健康）→ **03:51:07.326（故障）** → 03:57:28.961（完全健康）→ **04:23:36.405（故障，即当前）**。

**判定（按 deployment-window 规则表）**：

| 条件 | 结论 |
|---|---|
| `T_err(03:51:07.660) < T_dep(04:23:23.657)` | **故障先于本次部署 ⇒ 排除该部署作为「起因」** |
| 部署窗口内无代码变更 | **排除发布/代码假设** |
| 部署窗口内存在运行期配置变更（knob 文件 04:23:22.947Z） | **配置假设成立** |

**为什么不是「过度归因到最近一次发布」**：本次告警确实是新容器产生的，但新容器只是**载体**——同一个坏配置在 03:51:07 的容器里就已经制造了完全相同的故障，中间 03:58–04:23 的健康窗口证明代码与基础设施无问题。故障型异常首次出现在 **03:51:07.660Z**，比任何可归因的变更都早。

### 4. git-diff-analysis：窗口内无代码变更

```
git log --since 2026-10-29T00:00:00Z --limit 20   → （空输出）
git log --limit 20  → 072d275 2026-10-26T07:29:26Z / 3ca923c 2026-10-26T07:23:25Z / 46ea5d5 2026-10-21 / a9c8957 2026-10-19
```
→ **部署窗口内无代码变更**（最近提交在 4 天前）。git 这条线查不出本次原因——原因在运行期配置层。

补充（**不在部署窗口内**，属放大因素）：`git diff 3ca923c` 显示该提交**删除了 null 兜底**：
```diff
-        if (profile == null) {
-            order.put("ship_to", "UNKNOWN");
-        } else {
-            order.put("ship_to", profile.get("address"));
-        }
+        order.put("ship_to", profile.get("address"));
```
→ `OrderService.java:29` 的 NPE 由此引入。`DownstreamClient.java:35-38` 按设计把下游失败折叠成 `return null`，`RestTemplateConfig.java:18-21` 用 `app.downstream.timeout-ms` 同时设置 connect/read timeout。

### 5. spring-diagnostics：排除资源类/依赖类；生效配置在 `runtime env` 里

```
runtime env → DOWNSTREAM_TIMEOUT_MS=1  DB_POOL_SIZE=10  LOAD_ENABLED=true
              LOAD_PATHS=/api/orders/1,/api/orders/3,/api/orders/4,/api/orders/5
              HIKARI_CONNECTION_TIMEOUT=30000  TZ=UTC
              knob_file=/home/fs-user/.config/miniclaw-lab/lab.env
              knob_file_mtime=2026-10-30T04:23:22.947Z
actuator health → db=UP, diskSpace=UP, ping=UP
actuator metrics/hikaricp.connections.* → active=1 pending=0 timeout=0 idle=9 max=10
actuator threaddump → 25 threads, blocked in socketRead = 0（13 个 Tomcat worker parked 等活）
actuator env → "app.downstream.timeout-ms":{"value":"******","origin":"System Environment Property \"DOWNSTREAM_TIMEOUT_MS\""}
```
→ **下游没有宕机，是客户端超时太短**：`/profiles/{userId}` 服务端 200 速率（1.2364/s）与 `/api/orders/{id}` 500 速率（1.2182/s）几乎相等（03:52 窗口同样是 1.0709 = 1.0709）——服务端每次都正常返回了 200，是调用方在 1ms 内放弃并收到 Read timed out。线程栈无阻塞、连接池全低位 ⇒ 排除资源耗尽与依赖宕机。

---

# root-cause-report

**服务 / 严重级 / 告警起始**：target-service / critical / activeAt=2026-10-30T04:23:49.991948342Z（firing ≈ 04:24:19.99Z）

## 【根因假设】
**置信度：0.90**

**机制**：运行期配置把下游读超时压到 **1ms**（容器内生效值 `DOWNSTREAM_TIMEOUT_MS=1`，来源 `System Environment Property`），使 target-service 对自身 `127.0.0.1:8080/profiles/{id}` 的调用**全部 Read timed out**；`DownstreamClient` 按设计把异常折叠成 `null`，而 `OrderService.loadOrder:29` 直接 `profile.get("address")` 未判空 → **NullPointerException → HTTP 500**，订单接口失败率 ≈98.5%、全局 5xx 比例 ≈43%。

**这是两个缺陷的叠加**：
- **触发条件**：下游读超时 = 1ms（运行期配置层，git 里查不到）。
- **放大条件**：`OrderService.java:29` 缺判空（`3ca923c` 于 2026-10-26 删除兜底）——没有它，下游超时只会降级为 `ship_to=UNKNOWN`（200），不会变成 500。
- **告警现状**：04:23:22.947Z 配置改动 → 04:23:23.657Z 容器重建 → 新容器继承 1ms → 04:23:37.043Z 起立即复现 → 04:23:49.99Z activeAt → 04:24:19.99Z firing。

## 【支持证据】
| 证据 | 来源（查询） | 时间 |
|---|---|---|
| 生效值 `DOWNSTREAM_TIMEOUT_MS=1`；knob 文件 mtime=04:23:22.947Z（容器重建前 0.71s） | `runtime env` | 2026-10-30T04:23:22.947Z |
| 首条下游读超时（故障起点） | `logs first 'Read timed out'` | 2026-10-30T03:51:07.660Z |
| 读超时窗口：389 / 0 / 196（NPE 同为 389 / 0 / 198） | `logs grep --count` 分窗统计 | 03:51–03:58 / 03:58–04:23:30 / 04:23:30+ |
| 栈顶 `OrderService.loadOrder(OrderService.java:29)` ← `OrderController.get(OrderController.java:21)` | `logs grep 'at com.example.target'` | 同上 |
| 下游服务端正常、调用方超时：/profiles 200 速率 ≈ /api/orders 500 速率（1.0709=1.0709 @03:52；1.2364 vs 1.2182 @04:27） | `metrics range 'sum by (uri,status)(rate(...))'` | 03:52 / 04:27 |
| 配置→重建→复现链：shutdown 04:23:23.266 → started 04:23:23.657 → ready 04:23:36.405 → 首超时 04:23:37.043（638ms） | `runtime started` + `logs grep 'Shutdown initiated'` | 04:23:22.9–04:23:37.0 |
| NPE 行由 3ca923c 引入（删掉 `if (profile == null)` 兜底） | `git diff 3ca923c` | 2026-10-26T07:23:25Z |
| 资源类/依赖类排除：hikaricp active=1 pending=0 timeout=0；health db=UP；threaddump 0 个 socketRead 阻塞 | `actuator metrics/*`, `actuator health`, `actuator threaddump` | 04:29 |
| 告警规则口径：for=30s，阈值 0.05，state=firing，value=0.416 | `/api/v1/rules` + `metrics alerts` | 04:28:48Z |

## 【反对证据 / 尚未解释】
- **03:51 那个容器（C2）的 `DOWNSTREAM_TIMEOUT_MS` 实际值无法直接观测**（容器已被重建覆盖；knob 文件 mtime 只保留最后一次编辑 04:23:22.947Z）。「C2 用的是同一个 1ms」是**指纹推断**：首个请求（就绪后 334ms）即超时 + 同样的 `ResourceAccessException: Read timed out` + 两窗口 5xx 比例完全相同（0.4336767646163284 @03:52:00 与 @04:24:30）。这是本次唯一未取得直接观测的环节。
- 03:58–04:23 健康窗口说明该配置在 03:57 被改回过，但**中间值与那次编辑时间不可观测**（mtime 被覆盖）。
- 基线噪声（下游 404 → NPE）在健康窗口内消失，属请求分布所致，与本次故障无因果关系。

## 【已排除的假设及排除依据】
- **发布/代码变更**：窗口内无代码变更（`git log --since 2026-10-29` 为空；最近提交 2026-10-26T07:29:26Z），且 T_err 早于 T_dep **32m16s** ⇒ 故障先于该次部署，**发布不是起因**。
- **下游服务宕机/不可用**：`/profiles` 服务端 200 速率正常（1.07–1.24/s），异常是 `Read timed out` 而非 `Connection refused`；health db=UP。
- **资源耗尽（连接池/内存）**：hikaricp pending=0、timeout=0、active=1；错误率形态是台阶而非缓慢增长；threaddump 25 线程、0 阻塞。
- **流量下跌导致「全挂」**：总请求速率恒定 2.85 req/s，5xx 全部集中在 `/api/orders/{id}`。
- **下游 404 路径**：长期基线（10-28: 27 次、10-29: 1 次、今日 02:13 起 13 次），与 43% 台阶无关。
- **告警口径误读**：`activeAt` 是 pending 时刻，firing = activeAt + for(30s)，非 activeAt 本身。

## 【跳过的步骤及原因】
- **spring-diagnostics 的 `actuator configprops`**：跳过——`actuator env` 已证明该端点与 configprops 同为 `show-values=never`，值全被掩码为 `******`，只能证明「配置项存在且来源是环境变量」，再查一次不会改变任何结论。
- **git-diff-analysis 对「部署窗口」内的逐 commit 拆解**：跳过——`git log --since 2026-10-29` 返回空，窗口内无提交，无 diff 可拆；已明确写为排除依据而非「没查到」。
- **未读取实验台的 `faults/`、`runs/` 目录**：主动跳过——这是预置答案/实验台内部数据，不属于「从运行期证据取证」的合法通道，结论必须由遥测独立支撑。

## 【处置建议（仅草案，不执行）】
1. **回滚运行期旋钮并重建容器**（env 在容器创建时固化，改文件不重建不生效）：
   ```bash
   # 人工执行
   sed -i 's/^DOWNSTREAM_TIMEOUT_MS=.*/DOWNSTREAM_TIMEOUT_MS=2000/' ~/.config/miniclaw-lab/lab.env
   docker compose --env-file ~/.config/miniclaw-lab/lab.env up -d --force-recreate target-service
   ```
2. **验证**：`node "$INCIDENT_LAB" logs grep 'Read timed out' --since <重建时刻> --count` 应为 0；`metrics range` 的 5xx 比例表达式应恢复有值且 ≈0。
3. **代码侧加固（PR，防同类复发）**：恢复 `OrderService.loadOrder` 的 null 兜底（`profile == null` → `ship_to="UNKNOWN"`），并考虑对下游失败做降级而非 500；参考已删除的 `3ca923c` 旧实现。
4. **配置侧护栏**：启动时打印 `app.downstream.timeout-ms` 生效值，并对 <100ms 之类的值告警，避免 1ms 这类值静默生效。
5. **观测侧**：为「下游读超时」单独建告警指标，与 5xx 比例解耦——本次故障里 `/profiles` 服务端指标完全正常（200 正常、客户端全超时），只看服务端指标会漏判。

> 本次诊断全程只读：仅使用 `metrics` / `logs` / `git` / `actuator` / `runtime` 通道与 Prometheus 只读 GET，未对目标服务、数据或 git 历史做任何变更。

---

**已写入工作区记忆**（供后续会话复用）：① 下游失败被放大成 500 的结构性路径（OrderService:29 无判空，3ca923c 删除兜底）；② 运行期旋钮 `DOWNSTREAM_TIMEOUT_MS` 的生效机制与 1ms 危险值特征。
