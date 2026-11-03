

---

## 锚点（三行，后续全部引用它）

| 锚点 | 值 | 来源 |
| --- | --- | --- |
| **告警起始** | `activeAt = 2026-11-03T03:41:34.991948342Z`（**pending 时刻**，非 firing）；firing ≈ `2026-11-03T03:42:05Z`（`for=30s`） | `metrics alerts` + `metrics range 'ALERTS{...}'` |
| **异常首次出现** | `2026-11-03T03:41:02.561Z`（首个导致 500 的 NPE） | `logs first 'NullPointerException' --since 2026-11-03T00:00:00Z` |
| **最近一次部署** | 容器重建 `2026-11-03T03:40:56.799Z`；应用就绪 `2026-11-03T03:41:01.413Z`；对应 commit `35fb5a3`（`2026-11-03T03:40:55Z`） | `runtime started` + `git log` |

服务：`target-service` ｜ 严重级：`critical` ｜ 部署口径：**以应用就绪时刻 `03:41:01.413Z` 为 T_dep**（下文差值一律用它，容器重建时刻另行标注）。

---

## 1. Alert（alert-triage）

`metrics alerts` 实际输出：

```
alertname=HighServerErrorRate  severity=critical  state=firing
activeAt=2026-11-03T03:41:34.991948342Z  value=8.227848101265824e-02
description: 5xx ratio is 8.228% over the last 1m.
```

`for` 不在本 CLI 通道内（`/api/v1/rules` 未开放），改用告警序列的首次采样差推：

- `metrics range 'ALERTS{alertname="HighServerErrorRate",alertstate="pending"}'` → 首个采样 `1793677295` = **03:41:35**
- `metrics range 'ALERTS{...,alertstate="firing"}'` → 首个采样 `1793677325` = **03:42:05**
- 差 30s ⇒ `for = 30s`，firing ≈ 03:42:05。这与 `ALERTS_FOR_STATE = 1793677294`（=03:41:34，即 activeAt）一致，**activeAt 是 pending 起点，不是 firing 时刻**。

## 2. Metrics（metric-triage）

**形态：台阶 + 首分钟爬坡（ramp），不是缓慢增长。**

- 5xx 比例（`metrics range ... [1m]`，02:50–03:50）：**03:41:10 之前整条序列不存在**（分子缺失 ⇒ 该期间无 5xx），首个点 `03:41:10 = 1.29%`，随 1m 窗口填满线性爬升，`03:41:55 = 8.55%`，之后稳定在 **8.2%–9.9%** 的平台值。
- 总流量（同表达式去掉 status 过滤）：故障前 2.87–2.91 rps，故障中 2.67→2.46→2.78，**未塌陷** ⇒ 属于“部分失败”，不是“全挂”。
- `topk(5, sum by (uri) (rate(...status=~"5.."[1m])))` → **只有 `/api/orders/{id}`**，值 `0.2545/s`；`sum by (status,uri)` 显示全部 5xx 都是 `status=500`，无其他接口、无 4xx 抬升。
- 平台值自洽：`0.2545 / 2.9 ≈ 8.8%`，与告警的 8.228% 同一量级。

影响面：单一接口 `/api/orders/{id}`，恒定 `0.25/s`（= 每 4 秒 1 次）。

## 3. Logs（log-triage）

先说**陷阱**：`ERROR` 里绝大多数是长期存在的无害噪音——`DownstreamClient - profile lookup failed userId=9999 ... 404`，`--since 03:40:00` 起每 4 秒一条，故障前就有。**不能用“首个 ERROR 行”当锚点。**

首个导致 5xx 的异常（`logs first 'NullPointerException'`）：

```
2026-11-03 03:41:02.561 ERROR [dispatcherServlet] Servlet.service() ...
  threw exception [Request processing failed: java.lang.NullPointerException:
  Cannot invoke "java.util.Map.get(Object)" because "profile" is null] with root cause
```

- 负证据（用 `--count`，不数行数）：NPE 在 `03:00:00 → 03:41:00` 区间 **0 次**；`03:41:10 → 03:43:10` 区间 **30 次**（≈0.25/s，与 500 速率同频）。
- 栈顶（`logs grep 'at '`）：`com.example.target.OrderService.loadOrder(OrderService.java:29)` ← `OrderController.get(OrderController.java:21)`。
- 分布：**不是全量请求失败**，而是按 5 条固定路径轮转中的 1 条稳定失败（下面第 4 步给出计数）。
- 无 `TimeoutException`（03:00–03:41 计数 0）、无 `ConnectException`（03:00–现在 0）、无 `WARN`（03:41 起 0）。

## 4. Deployment（deployment-window）

`runtime started`：

```
container_started_at: 2026-11-03T03:40:56.798753875Z
app_started_log:      2026-11-03 03:41:01.413  Started TargetServiceApplication in 3.92 seconds
```

`git log --since 2026-10-26`（UTC）：

```
35fb5a3  2026-11-03T03:40:55Z  feat(order): enrich response with downstream shipping address
7bb726a  2026-10-30T04:46:39Z  fix(order): tolerate missing downstream profile
072d275  2026-10-26T07:29:26Z  fix(tool): keep `git file` reads inside the repository root
3ca923c  2026-10-26T07:23:25Z  feat(order): enrich response with downstream shipping address
```

判定（`T_dep = 03:41:01.413`）：`Δ = T_err − T_dep = 1.15s`，落在 `[T_dep, T_dep+15min]` 内 ⇒ **高度相关**，继续查 diff。（以容器重建为口径 `Δ = 5.76s`，结论不变。）

**运行时配置层单独排除**（避免把重启一律算成代码变更）：

- `runtime env`：`LOAD_ENABLED=true`、`LOAD_PATHS=/api/orders/1,/api/orders/2,/api/orders/3,/api/orders/4,/api/orders/5`、`DOWNSTREAM_TIMEOUT_MS=2000`、`DB_POOL_SIZE=10`、`hikari connection timeout=30000`。
- `knob_file_mtime: 2026-11-03T03:24:53.073Z`（旋钮文件最后被编辑），日志里有 **`03:25:01.642` 一次容器重启**——即配置变更确实生效过，但 `03:25 → 03:41` 期间 **NPE 0 次、5xx 比例序列完全不存在**。**故配置层不是本次触发源。**
- 负载模式前后一致：`LOAD_PATHS` 未变，5 条路径 × 800ms ≈ 1.25 rps，与 `/api/orders` 200 速率 1.2545/s 吻合。

## 5. Git diff（git-diff-analysis）

`git diff 35fb5a3`（唯一改动文件 `OrderService.java`，1 insertion / 5 deletions）：

```diff
-        if (profile == null) {
-            order.put("ship_to", "UNKNOWN");
-        } else {
-            order.put("ship_to", profile.get("address"));
-        }
+        order.put("ship_to", profile.get("address"));
```

- `git diff 7bb726a` 是**反向**的同一段（`+` 空值兜底），即 10-30 加过防护；
- `git diff 3ca923c` 与本次 **逐字相同**（同样 1+/5-），即 10-26 曾以同样方式删过一次防护。

关联证据：改动的正是栈顶方法 `OrderService.loadOrder`（第 27–29 行），落在异常调用链上。
失效机制：`DownstreamClient.fetchProfile()` 对 404 返回 `null`（代码注释即 "Returns null when the profile does not exist"），删除判空后 `profile.get("address")` 直接 NPE → 500。

数据侧现实条件：`data.sql` 明确 `order 2 references user 9999, which has no profile row`——这条 NPE 的触发数据一直存在。

**关键前后对比（同一路径，同一速率，唯一差别是代码）**

| 观测 | 旧容器 03:30–03:40:50 | 新容器 03:41:10–03:43:10 |
| --- | --- | --- |
| `order 1/2/3/4/5 loaded` 计数 | 162 / **162** / 162 / 162 / 162 | 29 / **0** / 30 / 30 / 30 |
| NPE | 0 | 30 |
| `/api/orders` 200 速率 | 1.2545/s | ≈1.00/s（掉的正是 order 2 的 0.25） |
| `/profiles` 404 速率 | 0.2545/s | 0.2545/s（不变，属慢性噪音） |

即：order 2 **一直**在被压测（用户 9999 **一直**没有 profile），旧版本靠兜底返回 `UNKNOWN` 正常 200；新版把兜底删掉，同一条请求立刻变成 500。

## 6. Runtime / spring-diagnostics（部分使用：仅用于排除依赖类与资源类）

- `actuator health` → `{"status":"UP", "db":{"status":"UP","database":"H2"}}`，无 DOWN 依赖。
- `hikaricp_connections_active{...} = 1`（池上限 10），连接池无积压。
- 下游行为是**业务性 404**（`HttpClientErrorException$NotFound`），且速率故障前后完全一致；无超时、无拒连。
- 未取 `threaddump`：不取的理由不是“省事”，而是假设不需要它——错误按 1/5 请求确定性复现、`health` UP、连接池 active=1，不存在阻塞或耗尽的形态。若后续怀疑资源类再补。
- 未用 `actuator env/configprops`：其值全部掩码为 `******`，只能证明配置项存在，不能证明生效值；生效值一律用 `runtime env`。

## 7. Historical（historical-incident-lookup）

`workspace_memory_search(query="target-service 5xx", kind="lesson")` → **命中 1 条**（`wmi_2bcb9ad3…`，importance 0.7，仅方法/口径，无历次结论）。对本次的意义：它给出的口径（activeAt≠firing、ERROR 噪音≠首个异常、部署用容器/就绪时刻、指标空洞即负证据）已逐条在本次落地复核，**没有**用它替代取证。

日志与 git 的纵向核对（同一服务、同一症状）：

```
首个 NPE（全量历史）：2026-10-27 04:02:41.808
上一轮结束：        2026-10-30 09:06:25.801   ← 修复 commit 7bb726a 是 04:46:39，生效滞后约 4h20m
此后至 03:41:02：     NPE 0 次
```

即同一失效机制历史上出现过一轮（10-26 `3ca923c` 引入 → 10-30 `7bb726a` 修复），本次是**修复被同一段 diff 再次删掉**。

---

## 8. 根因报告（root-cause-report 收口）

```text
服务 / 严重级 / 告警起始
  target-service / critical / 2026-11-03T03:41:34.99Z（activeAt = pending 起点）
  firing ≈ 2026-11-03T03:42:05Z（for=30s，由 ALERTS pending/firing 首次采样差推得）

【根因假设】
  置信度：0.92
  机制：commit 35fb5a3（03:40:55Z）删除了 OrderService.loadOrder 中的 profile 空值兜底，
        使「订单 2 → 用户 9999 无 profile 记录 → fetchProfile 返回 null」这条长期存在的
        数据路径由 200+ship_to=UNKNOWN 变为 NullPointerException → HTTP 500；
        该 commit 随后在 03:41:01 的应用重启中生效，order 2 每 4 秒一次的压测请求
        恒定失败，把 5xx 比例抬到 ~8.5%。

【支持证据】
  - 告警 firing，value 8.228%→8.805%，仅 /api/orders/{id} 有 5xx（0.2545/s，全为 500）
    来源：metrics alerts / metrics query topk by(uri) / by(status)  时间：03:42:28–03:44:02
  - 5xx 比例序列 03:41:10 前不存在，03:41:10 起由 1.29% 爬升至 03:41:55 的 8.55% 后成台阶
    来源：metrics range（[1m] 比值）  时间：02:50–03:50
  - 首个 NPE 03:41:02.561，栈顶 OrderService.loadOrder(OrderService.java:29)
    ← OrderController.get(OrderController.java:21)；00:00–03:41:00 NPE 计数 0
    来源：logs first 'NullPointerException' / logs grep --count / logs grep 'at '  时间：同上
  - 03:41:10–03:43:10 NPE 30 次（0.25/s），与 order 2 的请求节奏一致；同期 order 2 成功加载 0 次
    来源：logs grep --count / logs grep 'order N loaded' --count  时间：03:41:10–03:43:10
  - 旧容器 03:30–03:40:50 order 1..5 各成功加载 162 次（含 order 2），NPE 0 次
    来源：logs grep 'order N loaded' --count  时间：03:30–03:40:50
  - 同一请求量下 /api/orders 200 速率由 1.2545/s 降到 ≈1.00/s，跌幅 0.25/s = order 2 的占比
    来源：metrics range  时间：03:20–03:45
  - 部署窗口内唯一 commit 就是 35fb5a3，diff 删掉 profile==null 分支，与栈顶方法同一调用链
    来源：git log / git diff 35fb5a3  时间：commit 03:40:55Z
  - 同段 diff 曾在 3ca923c 出现过、被 7bb726a 修复；上一轮 NPE 一直持续到 10-30 09:06
    来源：git diff 3ca923c / git diff 7bb726a / logs grep --count  时间：10-26–10-30

【反对证据 / 尚未解释】
  - 旋钮文件在 03:24:53 被编辑、03:25:01 有过一次容器重启，但该窗口 NPE 0 次、
    5xx 比例序列不存在 ⇒ 配置层无因果贡献。03:24 那次编辑的具体内容读不到
    （actuator 全掩码；工作区外配置文件不作为证据源），只能证明它未造成本故障。
  - `profile lookup failed userId=9999 ... 404` 的 ERROR 在故障前已每 4 秒一条，
    是长期噪音；它解释了「为什么首个 ERROR 行不能当锚点」，但不构成本次根因
    （404 速率故障前后完全一致）。
  - 5xx 比例观测到 9.9% 的瞬时高点（03:42:45 一带）略高于 8.5% 平台值，
    归因于 1m 窗口边界与总流量 2.46–2.91 rps 的抖动，不影响结论。

【已排除的假设及排除依据】
  - 发布变更以外的“配置变更”: 03:25:01 应用就绪 vs 03:41:02 首次异常，相差 16 分钟，
    且该窗口 5xx 序列缺失、NPE 计数 0 → 排除该次配置变更。
  - 下游依赖故障: /profiles 404 速率故障前后均为 0.2545/s；无 TimeoutException、
    无 ConnectException；health 中 db UP、无 DOWN 组件 → 排除依赖类。
  - 资源耗尽（连接池/线程/内存）: hikaricp_connections_active=1（上限 10），
    总流量未塌陷、错误形态是台阶而非缓慢增长 → 排除资源类。
  - 数据变更: order 2 → user 9999 的“无 profile”关系自 data.sql 起就存在，
    旧版本同一条请求返回 200 → 排除数据层变更。

【跳过的步骤及原因】
  - spring-diagnostics 的 threaddump / env / configprops：只做了 health + Hikari 的
    排除性取证后跳过。原因：错误按 1/5 请求确定性复现、health UP、连接池 active=1、
    无超时/拒连，资源与阻塞类假设已被证伪，threaddump 不会提供新的判别信息；
    env/configprops 全掩码，读了也无法证明生效值（生效值已用 runtime env 取得）。
  - 无其他跳过：alert / metric / log / deployment / git-diff / historical / root-cause 均已执行。

【处置建议（仅草案，不执行）】
  1. 回滚该行改动（最快恢复）：
       git revert --no-edit 35fb5a3     # 或手工恢复 7bb726a 的 null 分支
       重建镜像并重启容器，使修复真正生效（注意：commit 不等于生效，
       上一轮 7bb726a 到实际生效滞后约 4h20m）
  2. 把兜底改成显式契约，避免第三次回归：
       Map<String,Object> profile = downstream.fetchProfile(userId);
       order.put("ship_to", profile == null ? "UNKNOWN" : profile.get("address"));
     或将 fetchProfile 返回 Optional<Map<String,Object>>，让“可能不存在”成为编译期可见的事实。
  3. 补回归测试：以 order 2 / user 9999（无 profile 行）为核心用例，断言 HTTP 200
     且 ship_to=UNKNOWN，纳入 CI 必跑。
  4. 降噪（可并行）：user 9999 的 404 属预期业务分支，建议由 ERROR 降为 DEBUG/INFO，
     否则每轮诊断的首个 ERROR 行都会被它误导。
  5. 人工复核后用 metrics 验证收敛：
       metrics range 'sum(rate(http_server_requests_seconds_count{application="target-service",status=~"5.."}[1m]))' <T0> <T1> 30s
     期望序列消失、Alertmanager 在 for 之后转 resolved。
```

**一句话结论**：这不是依赖或资源问题，也不是 03:24 那次配置变更；是 `35fb5a3` 把 `7bb726a` 加过的空值兜底又删了一遍（与 `3ca923c` 逐字相同），在 03:41:01 重启生效后，让“订单 2 → 用户 9999 无 profile”这条一直存在的路径从 200 变成 NPE 500，5xx 稳定在约 8.5%。

