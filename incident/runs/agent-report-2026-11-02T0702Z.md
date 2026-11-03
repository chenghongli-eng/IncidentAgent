

---

# target-service 5xx 根因诊断报告

**服务：target-service ｜ 严重级：critical ｜ 告警起始：2026-11-02T07:19:19.991948342Z（`activeAt`，即 pending 时刻）**
firing ≈ activeAt + for = **2026-11-02T07:19:49.99Z**（`for`=30s，来源：`/api/v1/rules` 的 `duration:30`）

---

## 三个锚点

| 锚点 | 时间 | 口径与来源 |
|---|---|---|
| ① 告警起始 | **2026-11-02T07:19:19.99Z** | `metrics alerts` 返回的 `activeAt`（**pending 时刻**，非 firing）。firing ≈ 07:19:49.99Z（= activeAt + for 30s） |
| ② 异常首次出现 | **2026-11-02T07:18:49.343Z** | `logs first 'NullPointerException' --since 2026-11-02T07:18:48Z`。异常类型：`java.lang.NullPointerException: Cannot invoke "java.util.Map.get(Object)" because "profile" is null`；栈顶：`com.example.target.OrderService.loadOrder(OrderService.java:29)` → `OrderController.get(OrderController.java:21)` |
| ③ 最近一次部署 | **2026-11-02T07:18:41.573Z（容器重建）/ 07:18:48.056Z（应用就绪）** | `runtime started`：`container_started_at=2026-11-02T07:18:41.573Z`，`app_started_log=2026-11-02 07:18:48.056 Started TargetServiceApplication` |

**口径声明**：③ 全程采用**容器重建时刻 07:18:41.573Z**（与应用就绪 07:18:48.056Z 相差 6.5s，不影响任何判定）。

**Δ(②−③) = 07:18:49.343 − 07:18:41.573 = +7.77 秒** —— 异常在部署后 7.8 秒即出现，落在「T_dep ≤ T_err ≤ T_dep+15min」区间内。

---

## 根因假设

**置信度：0.95**

**机制**：容器重建上线了 commit `5f12098`，该提交把 `7bb726a` 已修复的空值防护**删除**，使 `OrderService.loadOrder` 第 29 行重新变成 `order.put("ship_to", profile.get("address"))`。当订单对应的用户在下游 profile 表中不存在（`/profiles/9999` 返回业务性 404），`DownstreamClient.fetchProfile` 按契约返回 `null`，第 29 行对 null 调用 `.get("address")` 触发 NPE → HTTP 500。

**失效链条**：`orders.id=2 → user_id=9999`（`data.sql` 注释显式说明 "Order 2 references user 9999, which has no profile row"）→ `GET /profiles/9999` 返回 404 → `fetchProfile` 捕获后 `return null` → `profile.get("address")` NPE。

---

## 支持证据

| 证据 | 来源 | 时间 |
|---|---|---|
| 栈顶行号 `OrderService.java:29` 正是 `profile.get("address"))`（`git file 5f12098:.../OrderService.java` 第 29 行 = 该语句；`7bb726a` 同一行是 `if (profile == null) {`，不可能抛此 NPE） | `git file` + 日志堆栈 | 2026-11-02T07:18:49.343Z |
| `5f12098` 的 diff 恰好删除了判空分支：`-if (profile == null) { order.put("ship_to","UNKNOWN"); } else { ... }` / `+order.put("ship_to", profile.get("address"));` | `git diff 5f12098` | commit 2026-11-02T07:18:39Z |
| blob 归属反证：运行产物的 `OrderService.java` blob = `34e92a3`，与 `5f12098`/`3ca923c`/`072d275` 相同，与 `7bb726a`（blob `5edc8b6`，有防护）不同 | `git rev-parse <commit>:<path>` | 同上 |
| 部署窗口内**唯一**提交 = `5f12098`，且与容器重建仅差 2.6 秒 | `git log --since 07:02:00Z --until 07:19:30Z` | 2026-11-02T07:18:39Z |
| 形态=**台阶**：5xx 比例在部署后由 0 阶跃到 3.1%→7.3%→8.86% 并维持，非尖刺、非缓慢增长 | `metrics range` 5xx 比例，07:19:00=0.0313 / 07:19:30=0.0727 / 07:20:00=0.0886 | 07:19:00–07:21:00Z |
| 失败面限定：5xx 全部落在 `uri=/api/orders/{id}`（0.236/s），`/profiles/{userId}` 走 404 而非 5xx | `metrics query topk(5, sum by (uri)(rate(...5xx)))` | 07:21Z |
| 只有 order 2 失败：order 1/3/4/5 各成功 185 次，order 2 成功 0 次 | `logs grep "order N loaded for user" --count` | 07:18:48Z 起 |
| 下游 404 与 NPE 严格 1:1：部署后 `profile lookup failed`=57、`NullPointerException`=57、`userId=9999`=57 | `logs grep --count` | 07:18:48Z 起 |
| **决定性负证据**：带防护的 boot（07:02:46–07:18:48）中，下游 404 照常发生 **239 次**，但 NPE **= 0** | `logs grep --count`（窗口07:02:46Z→07:18:48Z） | 07:02:46–07:18:48Z |
| 运行时代码与修复版 blob 不同：`5f12098` 第 29 行无防护；`7bb726a` 第 29 行为 `if (profile == null) {` | `git file` 逐 commit 对齐行号 | 同上 |

---

## 反对证据 / 尚未解释

1. **本次之前已有一模一样的故障（06:48:53.346Z）**：同栈顶 `OrderService.loadOrder(OrderService.java:29)`、同 order 2 失败（order 1/3/4/5 各成功 ~20 次）。该次发生在 06:48:52 的容器重建之后，而当时仓库 HEAD 仍是 `7bb726a`（有防护）。**未被本次证据完全解释**：可能是更早的镜像/更早的提交被上线过（reflog 只有一次 commit，无 checkout 痕迹，容器内也无版本信息——`actuator info` 返回 `{}`，日志中无 commit 标记）。此点不影响当前故障归因（当前运行的 blob 已由行号+blob 双重锁定为 `34e92a3`），但意味着"防护被删除"这件事可能发生过不止一次。
2. **告警起始与异常首次出现相差 30.6 秒**，期间比例仅 3.1%（低于 5% 阈值），故告警晚于异常起算——符合延迟告警，非漏报。
3. `metrics alerts` 返回的 firing告警载荷**不含 `service`/`job` label**（只有 `alertname`/`severity`），服务名由 `summary` 文本与 Prometheus 唯一抓取目标（`job=target-service`）推断，非 label 直取。

---

## 已排除的假设及排除依据

| 假设 | 排除依据 |
|---|---|
| **下游依赖不可用（拒连）** | `logs grep 'Connection refused' --since 2026-11-02T00:00:00Z --count` = **0**；下游返回的是**业务性 404**（用户无 profile 记录），不是拒连；`actuator health` 中 `db=UP`、`diskSpace=UP`、`ping=UP`，无组件 DOWN |
| **下游超时** | `logs grep 'Read timed out' --since 2026-11-02T00:00:00Z --count` = **0**（历史 10-27 的超时是另一时段）。`DOWNSTREAM_TIMEOUT_MS=2000` 生效且未被触及 |
| **资源类（连接池耗尽/线程阻塞）** | `hikaricp_connections_active=1`、`idle=9`、`max=10`、`pending=0`、`timeout` 序列无值；`actuator threaddump`：25线程，状态 `WAITING 11 / RUNNABLE 7 / TIMED_WAITING 7`，**无 BLOCKED**，栈帧中 `HikariPool`/`socketRead` 命中数 = **0** |
| **资源耗尽型缓慢增长** | 形态是部署后 7.8 秒的**台阶**，不是单调上升；`SlowRequests` 规则 `state=inactive`；JVM 内存与 `jvm.gc.*` 无异常值 |
| **运行时配置漂移** | `runtime env` 生效值 `DOWNSTREAM_TIMEOUT_MS=2000`、`DB_POOL_SIZE=10`、`LOAD_PATHS=/api/orders/1..5`、`LOAD_ENABLED=true`；knob 文件 `lab.env` mtime =2026-11-02T07:02:37.967Z，**早于**本次部署 16 分钟，且窗口内无编辑。`actuator env`/`configprops` 值全为 `******`，不能作为生效值依据，故只用于确认配置项存在 |
| **流量塌陷导致比例虚高** | 总请求速率在故障前后恒定 ~2.87 req/s；仅 `/api/orders/{id}` 的 5xx 上升，为**部分失败**而非全挂 |
| **指标空洞 = 采集中断**（即 07:04–07:18:30 无 5xx 是假象） | 空洞期 `up{job="target-service"}` **全程为 1**（07:02→07:20 每分钟一条），总流量序列**连续无断点**（2.87 req/s 稳定），故空洞是"该期间确实无 500"的真实证据，而非采集缺失 |
| **无关告警 /阈值过敏** | 5xx 绝对速率 0.236/s、比例 8.86%，有真实业务影响（order 2 100% 失败），且与代码变更精确对齐 |
| **历史故障复发即可结案** | 历史召回（`workspace_memory_search "target-service"`）仅命中 1 条**方法类 lesson**，无任何既往故障处置记录；本次全部独立取证，未套用历史结论 |

---

## 跳过的步骤及原因

| 步骤 | 原因 |
|---|---|
| `historical-incident-lookup` 的实质结论复用 | 召回仅命中 1 条方法论 lesson（`target-service.5xx.triage-method`），无既往故障处置记录。按 skill 要求仅作线索，未当结论 |
| `spring-diagnostics` 的 `actuator env` / `configprops` 取生效值 | 二者值被掩码为 `******`，只能证明配置项存在；改用 `runtime env` + `docker inspect` 取生效值（已做） |
| `git-diff-analysis` 的"窗口内无提交"结论 | 不适用——窗口内**有**提交且为唯一提交 `5f12098`，已完成 diff 与栈顶行号对齐 |
| 写入型处置动作 | 本诊断无写权限，`docker restart` / 回滚等仅作为草案输出 |

---

## 处置建议（仅草案，不执行）

```bash
# 1) 回滚到带空值防护的版本（最高优先，回滚即可止血）
cd /path/to/target-service
git checkout 7bb726a -- target-service/src/main/java/com/example/target/OrderService.java
# 或直接回滚到上一发布标签后重建镜像并重启容器

# 2) 备选（若不回滚）：在第 29 行前补回判空
# if (profile == null) { order.put("ship_to", "UNKNOWN"); }
#    else { order.put("ship_to", profile.get("address")); }

# 3) 重建镜像并重启（人工执行；会中断流量，请在窗口内操作）
docker compose --env-file <lab.env> up -d --build target-service

# 4) 验证（重启后）
node "$INCIDENT_LAB" logs grep 'NullPointerException' --since <T_restart> --count   # 期望 0
node "$INCIDENT_LAB" metrics query \
  'sum(rate(http_server_requests_seconds_count{application="target-service",status=~"5.."}[1m])) / clamp_min(sum(rate(http_server_requests_seconds_count{application="target-service"}[1m])),0.001)'  # 期望 ≈0
```

**附加建议**：
- 该提交标题 `feat(order): enrich response with downstream shipping address` 与 `3ca923c` **完全相同**，且两者的 `OrderService.java` blob 均为 `34e92a3`——`5f12098` 是把已修复的缺陷重新引入的一次回退。建议在 CI 中对"移除判空/兜底分支"的 diff 加检查，并核实 `3ca923c`→`7bb726a`→`5f12098` 的提交意图是否被误读。
- 建议评审"用 null 表示下游业务性 404"的契约（`DownstreamClient` 类注释明写 "Returns null when the profile does not exist"），改为返回可选对象或抛业务异常，避免再次被单点解引用。
- 补充 `actuator info` 的构建信息（当前返回 `{}`），使运行产物与 commit 的对应可从运行时直接读出，无需依赖栈顶行号反推。

---

## 诊断链完整性

`alert-triage` → `metric-triage` → `log-triage` → `deployment-window` → `git-diff-analysis` → `spring-diagnostics`（排除用）→ `historical-incident-lookup` → `root-cause-report` — 全流程已走完，无静默跳步。

> 附注：`logs grep` 默认按时间**升序**返回最早匹配项，直接 `grep 'ERROR'` 会返回 2026-10-27 的历史错误而非本次故障；本次所有日志查询均显式加了 `--since/--until` 时间窗。

