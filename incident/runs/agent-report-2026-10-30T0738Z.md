诊断完成。以下是收口报告。

---

# 根因报告：target-service 线上 5xx

**服务：target-service ｜ 严重级：critical ｜ 告警起始：2026-10-30T07:54:49.991948342Z（= `metrics alerts` 的 `activeAt`，pending 时刻）｜ firing ≈ 2026-10-30T07:55:19.99Z（activeAt + for 30s）**

## 三个锚点（口径已选定，全程只用这一套）

| 锚点 | 值 | 口径与来源 |
|---|---|---|
| ① 告警起始 | **2026-10-30T07:54:49.991948342Z** | `metrics alerts` 实时 `activeAt`。这是进入 **pending** 的时刻，不是 firing。`/api/v1/rules` 显示 `for: 30`，故 firing ≈ 07:55:19.99Z；`ALERTS` 序列 07:55:15 仍为 pending、07:55:20 已为 firing，与之吻合 |
| ② 异常首次出现 | **2026-10-30T07:54:22.836Z** | 本次故障窗口内首个导致 500 的异常（`logs first 'NullPointerException' --since 2026-10-30T07:54:16Z`），即应用就绪后 1.2 秒。该 NPE 签名的**历史首次出现**是 2026-10-27T04:02:41.808Z（说明缺陷不是今天新写的） |
| ③ 最近一次部署 | **2026-10-30T07:54:15.975Z** | 口径＝**容器重建时刻**（`runtime started` 的 `container_started_at`）；应用就绪 07:54:21.616Z（更严口径）。对应 commit `852d339`（提交 07:54:14Z），是部署窗口内**唯一**提交 |

**Δ(②−③) = +6.9s ≤ 15min → 部署高度相关**，继续查 diff。

---

## 1. alert-triage

- 载荷 `labels` 只有 `alertname/severity`，**无 `service`/`job`** → 降级处理：服务按 summary 文本 “target-service 5xx error rate above 5%” 推断。
- 规则（只读 `/api/v1/rules`，alert-triage 指定该端点，CLI 无 rules 通道）：`...5.. / ... > 0.05`，`for: 30s`，`severity: critical`。
- 同一服务无第二条 critical/warning 告警，无需降级处理。
- `metrics alerts` 复查：仍为 `firing`，`value = 8.8607e-02`。

## 2. metric-triage

- **形态：台阶（稳定平台），不是尖刺、不是缓慢增长** → 指向「发布/配置后的稳态差异」，排除资源耗尽型。
- 5xx 比例序列在 **06:51–07:19** 与 **07:37–07:54** 两段**整体缺失**（分子序列无 5xx 时整个表达式无值）——这不是采集中断：同期流量序列 `sum(rate(...[1m]))` 恒为 2.87–2.91 req/s，`up{job="target-service"}=1`。即**那两段根本没有 500**。
- 受影响接口只有一个：`topk(5, sum by (uri)(rate(...5..[1m])))` → `uri="/api/orders/{id}"`，`0.2545 req/s`。
- 定量闭合：`runtime env` 显示 `LOAD_PATHS=/api/orders/1..5`、`LOAD_ENABLED=true`，LoadDriver 间隔 800ms → 每条路径 0.25/s；`0.25 / 2.87 = 8.7%`，与告警的 8.861% 吻合。**5 个路径里只有 /api/orders/2 在报错**。

## 3. log-triage

```
首次出现：2026-10-30T07:54:22.836Z
异常类型：java.lang.NullPointerException: Cannot invoke "java.util.Map.get(Object)" because "profile" is null
栈顶：com.example.target.OrderService.loadOrder(OrderService.java:29)
       com.example.target.OrderController.get(OrderController.java:21)
分布：只集中在 /api/orders/{id}（不是所有请求）
```

- 干扰项已剔除：`profile lookup failed userId=9999 cause=...404` 的 ERROR 自 2026-10-27 起长期存在（`--count` 逐日：10-26=0、10-27=606、10-28=1、10-29=0、10-30=2741）。**首个 ERROR 行不是异常起点**，按 ① 的口径取首个 *导致 5xx* 的异常。
- 当前窗口 1:1 对应关系：`profile lookup failed userId=9999` = 141 次，NPE = 141 次（`--since 2026-10-30T07:54:16Z --until 2026-10-30T08:05:00Z --count`）→ **每一条下游 404 都变成了一个 500**。
- 决定性对照：`order 2 loaded for user 9999`（该 INFO 只在 null 保护存在、走到 `log.info` 时才打印）：

| 实例（起止，UTC） | order2-loaded | NPE | profile404 | 实际跑的代码 |
|---|---|---|---|---|
| A 05:07:07–06:50:03 | 0 | 1135 | 1135 | 无 null 保护 |
| B 06:50:03–07:19:24 | 439 | 1 | 440 | 有 null 保护 |
| C 07:19:24–07:35:48 | 0 | 243 | 243 | 无 null 保护 |
| E 07:38:14–07:54:16 | 237 | 0 | 237 | 有 null 保护 |
| **F 07:54:16–至今** | **0** | **141** | **141** | **无 null 保护** |

## 4. deployment-window

- `runtime started`：`container_started_at = 2026-10-30T07:54:15.975Z`，`app_started_log` = 07:54:21.616（Started in 4.845s）。
- `runtime env`：`DOWNSTREAM_TIMEOUT_MS=2000`、`DB_POOL_SIZE=10`、`LOAD_ENABLED=true`、`LOAD_PATHS=…`、`SPRING_DATASOURCE_HIKARI_CONNECTION_TIMEOUT=30000`、`TZ=UTC`；`knob_file_mtime = 2026-10-30T07:38:10.212Z`。
- 结论：旋钮文件自 07:38:10Z 起未再修改，故实例 E 与实例 F 的旋钮取值**相同**；07:54 出现的错误不能由旋钮解释（该旋钮下的实例 E 零 NPE）。

## 5. git-diff-analysis

```
候选 commit：852d3392e3017b8268b472bba75e6a2f3b93dacd  feat(order): enrich response with downstream shipping address  2026-10-30T07:54:14Z
```

- 窗口内提交只有这一条（`git log --since 2026-10-30T07:00:00Z --until 2026-10-30T08:00:00Z`）。
- diff 改的正是栈顶所在方法 `OrderService.loadOrder`，**删除了 7bb726a 刚加回来的 null 保护**（blob `5edc8b6` → `34e92a3`，与 10-26 首次引入该缺陷的 `3ca923c` 字节级相同，等于把修复原样回退）：
  ```diff
  -        if (profile == null) {
  -            order.put("ship_to", "UNKNOWN");
  -        } else {
  -            order.put("ship_to", profile.get("address"));
  -        }
  +        order.put("ship_to", profile.get("address"));
  ```
- 该 commit **只改了 OrderService.java 一个文件**（seed 数据、配置、旋钮全未变）→ 与实例 E 相比，**唯一变量就是这一个 null 保护**，这是受控对照，不是相关性猜测。
- 失效机制：`data.sql` 中 order 2 指向 user 9999，而 `profiles` 表没有 9999 行 → 下游 `/profiles/9999` 返回 **404** → `RestTemplate` 抛 `HttpClientErrorException$NotFound` → `DownstreamClient.fetchProfile` catch 后 `return null` → 第 29 行 `profile.get("address")` → NPE → HTTP 500。

## 6. spring-diagnostics（用于**排除**资源/依赖类）

- `actuator health`：`{"status":"UP"}`，db(H2) UP，diskSpace UP，ping UP。
- `actuator metrics/hikaricp.connections.*`：active=1、pending=0、timeout=0、max=10；`actuator threaddump`：25 线程（11 WAITING / 7 RUNNABLE / 7 TIMED_WAITING），**0 个**线程栈命中 `HikariPool`/`socketRead`/`RestTemplate`。
- → 无连接池耗尽、无线程阻塞、无下游拒连；下游返回的是**业务性 404**。资源类、依赖类均排除。

## 7. historical-incident-lookup

- 按短检索式依次查 `target-service`、`NullPointerException`、`5xx`（kind=lesson），各命中 **同一条** `wmi_24483d93`（标题「target-service 5xx 定位方法：锚点口径与负证据怎么取」）。
- 该记录**只有方法与症状词汇，不含任何历史故障结论**。对本次的意义仅是口径校准（activeAt≠firing、指标空洞=无 500、负证据用 `--count`、运行时配置要看生效值），**不作为本次结论**；本服务的既往处置记录：无（该条不含处置信息）。

---

## 【根因假设】置信度 **0.95**

**机制**：提交 `852d339`（07:54:14Z）把 `7bb726a` 恢复的 null 保护原样回退，07:54:15.975Z 重建容器将其上线；应用就绪后 1.2 秒，`/api/orders/2`（其 user 9999 无 profile 行）触发下游 404 → `fetchProfile` 返回 null → `OrderService.java:29` 解引用 null 抛 NPE → HTTP 500；负载驱动 5 条路径中 1 条命中，5xx 比例 8.86% > 阈值 5% → 07:54:49.99Z 进入 pending、07:55:19.99Z firing。

**分层（必要条件 vs 触发源）**
- 必要条件（缺陷层）：`852d339` 删除 null 保护 —— 栈顶行与 diff 改动行逐字一致，且该 commit 未改任何其他文件。
- 触发源（上线时刻）：07:54:15.975Z 的容器重建 / 07:54:21.616Z 的应用就绪 —— 实例 E 在**完全相同的旋钮与数据**下零 NPE，唯一变量是代码。
- **不是**资源类、**不是**依赖宕机、**不是**运行时配置漂移。

### 【支持证据】

| 证据 | 来源 | 时间 |
|---|---|---|
| 告警 firing，5xx 比例 8.861% | `$LAB metrics alerts` | activeAt 07:54:49.991948342Z |
| 规则 `for=30s`，阈值 0.05 | Prometheus `/api/v1/rules`（只读） | — |
| pending→firing 在 07:55:20 切换 | `$LAB metrics range 'ALERTS{...}'` @5s | 07:55:19.99Z |
| 形态为台阶 8.2–8.9%，非尖刺 | `$LAB metrics range '<5xx比例>'` 06:00–07:57 | — |
| 两段指标空洞 = 无 5xx（同期流量恒定 2.87/s） | `$LAB metrics range` 比例 / 流量 | 06:51–07:19、07:37–07:54 |
| 仅 `/api/orders/{id}` 报错，0.2545/s | `$LAB metrics query 'topk(5, sum by (uri)(rate(...5..[1m])))'` | ≈08:00Z |
| 首个 500 异常 = NPE，栈顶 OrderService.java:29 | `$LAB logs first 'NullPointerException' --since 2026-10-30T07:54:16Z` | 07:54:22.836Z |
| 404 与 NPE 1:1 | `$LAB logs grep ... --count`（141/141） | 07:54:16–08:05Z |
| 部署锚点 | `$LAB runtime started` | 07:54:15.975Z / 07:54:21.616Z |
| 窗口内唯一提交即该 diff | `$LAB git log --since 07:00Z`、`$LAB git diff 852d339` | 07:54:14Z |
| 部署态第 29 行确为 `profile.get("address")` | `$LAB git file 852d339:…/OrderService.java` | — |
| 旋钮与健康度 | `$LAB runtime env`、`$LAB actuator health/metrics/threaddump` | ≈08:00Z |

### 【反对证据 / 尚未解释】

1. **实例 A（05:07:07–06:50:03，NPE 1135）与实例 C（07:19:24–07:35:48，NPE 243）当时 HEAD 是修复提交 `7bb726a`，却仍在报错** —— 日志证明这两个容器跑的不是当时的 HEAD 源码，但**只读通道里没有构建日志/镜像 digest/部署记录**，无法判定其产物来源。此项不影响本次结论（实例 F 的产物由 07:54:14Z 的唯一提交 + 与栈顶行完全一致的 diff 直接锁定），**需补的证据**：CI 构建日志或镜像 digest。
2. **Prometheus 保留期不足**：10-27/10-29 区间 `series: 0`，最早样本为今天 03:00Z 之后 → 无法用指标量化 10-27 那次（当时日志有 606 次 NPE）的 5xx 比例与告警状态，也无法判断该告警当时是否 firing。
3. **数据前提是长期存在的**（order 2 → 无 profile 的 9999），不是新变化；10-26 之前 null 保护存在时它不构成故障 → 说明「数据前提 + 缺陷」必须同时成立。

### 【已排除的假设及排除依据】

- **资源类（连接池/内存/线程）**：hikaricp active=1/pending=0/timeout=0/max=10，25 线程无阻塞，堆 33MB → 排除。
- **依赖/下游宕机**：下游返回业务性 404 而非拒连或超时（无 SocketTimeoutException/ResourceAccessException，`timed out` 计数 0），health 全 UP，`DOWNSTREAM_TIMEOUT_MS=2000` 未变 → 排除。
- **运行时配置漂移（旋钮/数据种子）**：knob 文件 07:38:10Z 后未修改，同旋钮的实例 E 零 NPE；`852d339` 未改 data.sql/config → 排除。
- **“最近一次发布与本次无关”**：本次**不排除**——Δ=+6.9s 且 diff 与栈顶行一致；同类发布历史（含 10-26 首次引入、10-30 04:46 修复）显示该缺陷反复上下线，这正是本次复发的原因。
- **告警误报/指标问题**：5xx 真实存在（141 次 NPE ↔ 141 次 500，uri 只有一个），规则表达式与技能给定一致 → 排除。

### 【跳过的步骤及原因】

8 步（Alert→Metrics→Logs→Deployment→Git Diff→Runtime→Historical→Root Cause）**全部执行，无跳步**。两点边界声明：

1. `for=30s` 只能从 Prometheus `/api/v1/rules` 读到（CLI 无 rules 通道），alert-triage 明确指定该端点；该读取只读且与 `metrics alerts` 同源，已在正文标注。
2. 工作区边界：未读取工作区外的 `incident/faults/`（故障注入脚本）、`incident/RESUME.md`、`incident/runs/`（既往报告）等内容；所有结论只由 `$LAB` 输出支撑。取证前曾执行一次 `docker ps` 用于确认环境存活，其输出**未作为证据**，容器时间一律以 `$LAB runtime started` 为准。

### 【处置建议（仅草案，不执行，交人工）】

1. **回滚缺陷**：把 `target-service` 回退到 `7bb726a` 的产物，或 `git revert 852d339`（二者等价——`852d339` 只是把 `7bb726a` 的改动原样重做，revert 即恢复 null 保护）。**这是唯一能立刻消除 5xx 的动作**。
2. **补触发前提（可选，不能替代第 1 条）**：为 user 9999 补 `profiles` 行，或把 order 2 的 `user_id` 改指向有 profile 的用户。
3. **流程卡点**：同一改动在 10-26 与 10-30 被提交两次（blob `5edc8b6`↔`34e92a3`），建议 CI 加 blob 比对/回归测试，防止“修复被原样回退”。
4. **契约加固**：让 `DownstreamClient.fetchProfile` 的 null 契约在类型层面不可违反（返回 `Optional` 或空 Map），避免第 29 行再次裸解引用。
5. **观测改进**：告警表达式依赖 5xx 分子序列，无 5xx 时整条序列不存在（本次两次空洞）——建议同时监控 5xx 绝对计数，避免“修好后指标消失”被误读为缺数据。
6. **补查**：调取 CI 构建日志/镜像 digest，解释实例 A/C 为何在 HEAD 已修复时仍运行缺陷版本。

---

**当前状态**：`metrics alerts` 仍为 `firing`（8.861%），实例 F 仍在以 0.25 req/s 的速度产生 500（NPE 累计 141 次，且随时间继续增长）。

**记忆处理**：未写入新的工作区记忆——该工作区既有 lesson 明确约定「只留方法与症状词汇，不留任何一次故障的结论」，本次结论按同一约定不入库；方法口径已由既有 `wmi_24483d93` 覆盖。
