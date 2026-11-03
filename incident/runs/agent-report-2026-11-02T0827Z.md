

---

## 诊断完成 — target-service 5xx 根因报告

**服务**：target-service ｜ **严重级**：critical ｜ **告警起始**：`activeAt` = 2026-11-02T08:45:49.991948342Z（pending 时刻），`for`=30s → **firing ≈ 2026-11-02T08:46:20Z**

---

### 三个锚点

| 锚点 | 值 | 口径与来源 |
|---|---|---|
| ① 告警起始 | pending `activeAt` = 08:45:49.99Z；**firing ≈ 08:46:20Z** | `metrics alerts` 返回 `activeAt`（Prometheus v1 无 `firedAt`）；`for` 取自 `/api/v1/rules` 的 `duration: 30` |
| ② 异常首次出现 | **2026-11-02T08:45:29.281Z**（首个 NPE） | `logs first 'NullPointerException' --since 2026-11-02T08:00:00Z` |
| ③ 最近一次部署 | **2026-11-02T08:45:20.224Z**（容器重建）；应用就绪 08:45:27.957Z | `runtime started` → `container_started_at` / `app_started_log` |

**Δ(③→②) = +9.06 秒**（若改用应用就绪口径则 +1.32 秒）→ 落在「T_dep ≤ T_err ≤ T_dep+15min」内，**高度相关**。全文统一采用**容器重建时刻**作 T_dep。

> ⚠️ ② 的保留窗口说明：`logs/app.log` 首行是 `2026-11-02 08:26:55.440`（容器重建时日志文件被重建），因此 08:26:55 之前的当日日志已丢失。该时刻已用指标交叉验证（见下文负证据）。

---

### 证据链（每条结论均标注来源）

**Step 1 · 异常形态 = 台阶，不是尖刺**（`metric-triage`）
- `metrics range` 5xx 比例：08:45 前为 0，08:46:00=0.066、08:46:30=0.0884、08:47:00=0.0886、08:48:00=0.0862 → **跳变后维持在新平台**，非抖动。
- `metrics range` 总请求速率：故障前后恒定在 ~2.87–2.91 req/s → **部分失败，非全挂**。
- 同规则组的 `SlowRequests`（P99>2s）**state=inactive** → 无延迟型故障。

**Step 2 · 故障定位到单一接口**（`metric-triage`）
- `metrics query` 按 uri 分组：**500 只出现在 `/api/orders/{id}`**；`/profiles/{userId}` 返回 404。
- 两者速率**完全相等**：`rate(.../profiles/{userId},status="404"[1m])` = **0.23636/s**，`rate(.../api/orders/{id},status="500"[1m])` = **0.23636/s**。
- 原始计数器 `http_server_requests_seconds_count{status="500", error="NullPointerException"}`：08:46:00=8 → 08:53:57=128，**线性增长无归零**，故障持续中。

**Step 3 · 异常栈顶与触发条件**（`log-triage`）
- 首个 NPE（08:45:29.281Z）：`java.lang.NullPointerException: Cannot invoke "java.util.Map.get(Object)" because "profile" is null`
- 栈顶：`com.example.target.OrderService.loadOrder(OrderService.java:29)` → `OrderController.get(OrderController.java:21)`
- 当前源码 `OrderService.java:29` 正是 `order.put("ship_to", profile.get("address"));`
- `DownstreamClient.fetchProfile` 在异常时 `return null`（第 37 行），日志为 `profile lookup failed userId=9999 cause=...HttpClientErrorException$NotFound: 404`
- `data.sql:8` 注释明写：**`Order 2 references user 9999, which has no profile row`** → 5 条压测路径中 order 2 命中 → 约 1/5 订单请求失败，与 `LOAD_PATHS=/api/orders/1..5` 吻合。

**Step 4 · 决定性对照：同一条 404，部署前后命运不同**（同一次运行内取数）
| 窗口 | 下游 404 (`userId=9999`) | NPE/500 |
|---|---|---|
| 08:26:55 → 08:45:29（部署前，旧代码有判空） | **240** | **0** |
| 08:45:29 → 取数时（部署后） | **118** | **118**（1:1） |

**Step 5 · 部署窗口与代码变更**（`deployment-window` + `git-diff-analysis`）
- `runtime started`：容器重建 08:45:20.224Z，应用就绪 08:45:27.957Z。
- `git log`：唯一 24h 内提交 `5f144fa` **2026-11-02T08:45:18Z** `feat(order): enrich response with downstream shipping address` —— 提交到生效仅 2.2 秒。
- `git diff 5f144fa` 删除了判空分支：
  ```diff
  -        if (profile == null) {
  -            order.put("ship_to", "UNKNOWN");
  -        } else {
  -            order.put("ship_to", profile.get("address"));
  -        }
  +        order.put("ship_to", profile.get("address"));
  ```
  **改动文件 `OrderService.java` 正是 NPE 栈顶方法所在文件，改动行正是栈顶行 `OrderService.java:29`** —— 强候选根因。
- 历史对照：`3ca923c`(10-26) 同样删判空 → `7bb726a`(10-30, `fix(order): tolerate missing downstream profile`) 补回判空 → **`5f144fa`精确回退了 `7bb726a`**（与 `3ca923c` 的 diff 逐字节一致）。

**Step 6 · 运行时证据**（`spring-diagnostics`）
- `actuator health`：`{"status":"UP","db":{"status":"UP","database":"H2"},"diskSpace":"UP","ping":"UP"}`
- `hikaricp_connections_active` = **1**，无 pending / timeout 序列 → 连接池未耗尽。
- 今日 `Read timed out` / `Connection refused` / `Connect timed out` 计数均为 **0**。
- `runtime env`：`DOWNSTREAM_TIMEOUT_MS=2000`、`DB_POOL_SIZE=10`、`LOAD_PATHS=/api/orders/1..5`；knob 文件 mtime 08:27:33.914Z。

**Step 7 · 历史召回**（`historical-incident-lookup`）
- 命中 1 条 `lesson`（`target-service.5xx.triage-method`），**仅为方法论**，未提供任何结论；按其要求独立取证，未把上次诱因套用本次。

---

### root-cause-report 收口

```text
服务 / 严重级 / 告警起始
  target-service / critical / activeAt=2026-11-02T08:45:49.991948342Z (pending)，firing≈08:46:20Z

【根因假设】
  置信度：0.97
  机制：部署 5f144fa 删除了 OrderService.loadOrder 中对下游 profile 为空的判空保护，
        使既有且持续存在的「order 2 → user 9999 无 profile 行 → /profiles/9999 返回 404
        → fetchProfile 返回 null」这一常态数据条件，直接升级为
        profile.get("address") 的 NPE → /api/orders/{id} 返回 HTTP 500。

【支持证据】
  - 5xx 全部落在 /api/orders/{id}，且与 /profiles/{userId} 的 404 速率精确相等(0.23636/s)
    来源: metrics query sum by (uri,status) rate(...)  时间: 08:53Z  - NPE 栈顶 = OrderService.loadOrder(OrderService.java:29) = 5f144fa 改动的同一行
    来源: logs first 'NullPointerException' / git diff 5f144fa  时间: 08:45:29.281Z
  - 部署前 240 次下游 404 → 0 次 NPE；部署后 118 次 404 → 118 次 NPE（1:1）
    来源: logs grep --count（同一进程内取数）  时间: 08:26:55–08:53Z
  - 部署窗口高度相关：Δ(容器重建 08:45:20.224Z → 首异常 08:45:29.281Z) = +9.06s
    来源: runtime started + logs first  时间: 08:45Z
  - 上一实例(08:29:18Z, 含判空代码)整个 16 分钟生命周期内 500 序列不存在
    来源: metrics query increase(...status="500"[16m] @ 1793609120) → 空向量  时间: 08:29–08:45Z
  - 数据前提在代码库中明写: data.sql 注释 "Order 2 references user 9999, which has no profile row"
    来源: grep -rn 9999 target-service/src/  时间: 工作区文件
  - 5f144fa 是 7bb726a「fix(order): tolerate missing downstream profile」的精确回退
    来源: git diff 5f144fa / git diff 7bb726a / git diff 3ca923c

【反对证据 / 尚未解释】
  - 今日更早的容器实例(07:18:41Z、08:18:56Z)也出现同一 NPE 500 签名(计数器 07:25=93→07:35=242、
    08:20=14)，但 git log 在 10-30 04:46Z 与 11-02 08:45:18Z 之间无提交，这些实例显然不是由仓库 HEAD 构建。只读通道无法确定其镜像对应的提交。不影响本次结论（当前实例的代码已直接取证）。
  - knob 文件于 08:27:33.914Z 被编辑，其历史值不在版本库内、无法比对；但承载该变更的 08:29:18Z
    实例在其 16 分钟全生命周期内 500 计数为 0，故该配置变更本身未造成 5xx。
  - 404 速率(0.23636/s)略低于成功路径速率(0.99998/s 对应 4 条路径)，差异原因未查，未影响归因。

【已排除的假设及排除依据】
  - 下游依赖不可用/拒连：今日 Connection refused=0、Connect timed out=0、Read timed out=0；
    下游返回的是业务性 404 而非连接失败。
  - 资源类（连接池/内存/线程）：hikaricp_connections_active=1，无 pending/timeout 序列，
    总请求速率平稳，SlowRequests(P99>2s) 规则 inactive。
  - 数据库故障：actuator health db=UP（H2，validationQuery 通过）。
  - 超时/延迟类：DOWNSTREAM_TIMEOUT_MS=2000 且今日无超时日志，P99 告警规则未触发。
  - 流量突增/负载变化：总请求速率故障前后恒定 ~2.87 req/s。
  - 瞬时尖刺或阈值误报：形态为跳变后持续的平台（500 计数器 08:46=8 → 08:53:128 线性增长），
    且可定位到具体栈顶与具体代码行，非抖动。
  - 运行时配置变更（knob 08:27:33Z）：承载它的08:29:18Z 实例全程 500计数为 0。

【跳过的步骤及原因】
  - actuator/env、actuator/configprops：按技能说明其值全部掩码为 ******，只能证明配置项存在，
    无法证明生效值；生效值已由 runtime env 取得，故不引用。
  - actuator/threaddump：无「线程阻塞在连接获取或下游调用」的假设可检验（无 pending/timeout、
    P99 正常、请求速率平稳），跳过不影响结论。
  - git-diff-analysis 未跳过：已执行，并定位到与栈顶一致的文件与行。
  - historical-incident-lookup 未跳过：已执行，命中 1 条方法论条目（不含结论）。

【处置建议（仅草案，不执行；本 Agent 无写权限，未执行任何变更）】
  - 止血（首选）：回滚本次发布到 7bb726a，或直接 git revert 5f144fa 后重建镜像并重建容器。
     草案: git -C <repo> revert 5f144fa && <build> && <compose-up --build target-service>
  - 等价的最小热修：把 OrderService.loadOrder 恢复为 7bb726a 的判空版本 if (profile == null) { order.put("ship_to", "UNKNOWN"); } else { order.put("ship_to", profile.get("address")); }
  - 数据侧（可选，非本次止血项）：为 user 9999 补 profile 行，或让 order 2 不再引用无 profile 的 user。
  - 防复发：给「order 2 引用了无 profile 的 user」补一条回归测试；该缺陷历史上已造成      10-27 约 606 次、10-30 约 2837 次 NPE（同一 NPE 签名），属重复发生的已知失效模式。
  - 监控：当前告警仍 firing（1m 值 8.75%），500 计数器08:53:57=128 且仍在增长，
      当前无新发布；回滚前应先确认处置路径。
```

---

**当前状态**：故障**仍在持续**。截至取数时（2026-11-02 08:53:57Z），告警仍为 `firing`（1m 值 8.75%），`process_start_time_seconds` 仍为 1793609120.422（无新发布），500 计数器 128 且线性增长。

**本轮副作用说明**：仅执行只读查询；新增了一个只读格式化脚本 `tools/fmt.mjs`（把 Prometheus range 结果转成 ISO 时间戳，零写入目标服务），并向工作区记忆写入一条**方法论**条目（live `app.log` 随容器重建被重建、日志缺口不等于未发生），未写入本次故障的任何结论。

