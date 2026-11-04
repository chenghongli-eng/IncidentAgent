

---

## 目标服务诊断报告：target-service HighServerErrorRate (critical)

---

# 一、三个锚点（先确定基准，后续全部结论都引用它）

| 锚点 | 取值 | 口径说明 |
|---|---|---|
| **① 告警起始** | `2026-11-04T08:12:49.992Z`（= 16:12:49.992 +08:00） | 这是 `metrics alerts` 返回的 `activeAt`，即**告警进入 pending 的时刻**，不是 firing 时刻。真实 firing ≈ activeAt + `for`；因为只读工具没有 rules 通道，`for` 读不到（见“跳过的步骤”），所以这里只标注 pending 口径。 |
| **② 异常首次出现** | `2026-11-04T08:12:31.839Z` 首个导致 5xx 的超时异常；`08:12:31.845Z` 首个 NPE（栈顶 `OrderService.loadOrder(OrderService.java:29)`） | 这里取“**首个导致 5xx 的异常**”，并未取“首个 ERROR 行”。日志时区为 UTC（容器 `TZ=UTC`）。 |
| **③ 最近一次部署** | `2026-11-04T08:12:24.694Z` 容器重建；`08:12:31.506Z` 应用就绪 | **本报告统一采用“应用就绪时刻”作为 T_dep 口径**，即 `08:12:31.506Z`；容器重建时刻仅作背景。**不采用 git commit 时间**（见第五节）。 |

**Δ(②−③) = +0.339 秒**（按容器口径为 +7.151 秒）。两者都远小于 15 分钟 → 部署与异常**高度相关**。

服务：target-service ｜ 严重级：critical（唯一一条告警，无同级并发告警）｜ 抓取目标 `target-service:8080/actuator/prometheus` health=up。

---

# 二、异常形态（metric-triage）

误差率（`metrics range ... 5xx / total`，07:55–08:13Z，30s 步长）只有两个数据点，且都出现在 08:13 之后：

```
1793779980 (=08:13:00Z)  0.2347
1793780010 (=08:13:30Z)  0.4370
```

> 08:13:00 之前整条序列**不存在**——5xx 比例的分子序列缺失时表达式无值，这个“指标空洞”本身就是“该期间无 500”的负证据。

- 流量：同期 `sum(rate(...))` 全程稳定在 **2.74–2.91 rps**，**流量没有下跌** → 不是全挂，是部分失败。
- 受影响接口（`topk(5, sum by (uri) (rate(...status=~"5..")))`）**只有一条**：`/api/orders/{id}`，5xx ≈ **1.236 rps**。
- 形态判定：**台阶**（跳变后一直维持 0.31–0.44），与“重建后稳态差异”一致，不属于缓慢增长型资源耗尽。

当前实时值：`metrics query` 比例 0.3125、total 2.909 rps；告警仍在 firing，annotation 为 “5xx ratio is 34.19%”。

---

# 三、日志首次出现与调用链（log-triage）

```bash
node "$INCIDENT_LAB" logs first 'Exception' --since 2026-11-04T08:12:00Z
```
```
2026-11-04 08:12:31.839 ERROR [http-nio-8080-exec-1] com.example.target.DownstreamClient
- profile lookup failed userId=1 cause=...ResourceAccessException:
  I/O error on GET request for "http://127.0.0.1:8080/profiles/1": Read timed out
```

```bash
node "$INCIDENT_LAB" logs first 'NullPointerException' --since 2026-11-04T08:12:00Z
```
```
2026-11-04 08:12:31.845 ERROR ... NullPointerException:
Cannot invoke "java.util.Map.get(Object)" because "profile" is null
	at com.example.target.OrderService.loadOrder(OrderService.java:29)
	at com.example.target.OrderController.get(OrderController.java:21)
```

- 首次出现：`2026-11-04T08:12:31.845Z`　异常类型：`java.lang.NullPointerException`
- 栈顶：`com.example.target.OrderService.loadOrder(OrderService.java:29)`
- 分布：**同一调用链每个 `/api/orders/{id}` 请求**都会复现；本次运行计数 `Read timed out` **193** 次、`NullPointerException` **194** 次（`--count`，不含堆栈续行）。
- 因果顺序：下游自调用 `/profiles/{id}` 超时（`.839`）→ `DownstreamClient.fetchProfile` 捕获异常后 `return null` → `OrderService` 对 null 解引用（`.845`）→ HTTP 500。

---

# 四、部署窗口（deployment-window）

```bash
node "$INCIDENT_LAB" runtime started
```
```
container_started_at: 2026-11-04T08:12:24.694076381Z
app_started_log: 2026-11-04 08:12:31.506 ... Started TargetServiceApplication in 5.907 seconds
```

判定：`T_dep(app ready) = 08:12:31.506`，`T_err = 08:12:31.845`，**Δ = +0.339s ∈ [0, 15min] → 高度相关，继续往下查**。

关键补充（来自同一命令族）：`runtime env`

```
DOWNSTREAM_TIMEOUT_MS=1          <-- 生效值
DB_POOL_SIZE=10
LOAD_ENABLED=true
LOAD_PATHS=/api/orders/1,/api/orders/3,/api/orders/4,/api/orders/5
knob_file_mtime: 2026-11-04T08:12:24.106Z
```

`/target-service/src/main/resources/application.yml` 里该项的默认值是 `timeout-ms: ${DOWNSTREAM_TIMEOUT_MS:2000}`。**即本次重建把下游超时从默认 2000ms 写成了 1ms**；knob 文件 mtime 与容器重建时刻只差 0.588 秒，说明这是随本次重建一起生效的配置变更。

---

# 五、代码变更比对（git-diff-analysis）

```bash
node "$INCIDENT_LAB" git log --since 2026-11-04T07:00:00Z --limit 10
```
```
4e7c499  2026-11-04T07:54:24.000Z  feat(order): enrich response with downstream shipping address
```

```bash
node "$INCIDENT_LAB" git diff 4e7c499
```
```diff
-        if (profile == null) {
-            order.put("ship_to", "UNKNOWN");
-        } else {
-            order.put("ship_to", profile.get("address"));
-        }
+        order.put("ship_to", profile.get("address"));
```

- 候选 commit：`4e7c499` “feat(order): enrich response with downstream shipping address”，2026-11-04T07:54:24Z（15:54 +08）。
- 关联证据：改动的正是日志栈顶方法 `OrderService.loadOrder` 的同一行（现第 29 行），对应 diff 表中“**删除兜底分支**”失效机制。
- 失效机制：下游调用异常时 `fetchProfile` 返回 `null`，新代码不再走 `UNKNOWN` 兜底而是直接 `profile.get("address")` → NPE → 500。
- **锚点口径校正**：commit 时间（07:54:24Z）比容器重建（08:12:24Z）早 18 分钟，且“无兜底”行为在 **07:40:17.771Z** 就已出现（早于 commit）。所以拿 commit 时间当部署锚点会错位，本次仍以应用就绪时刻为准。

---

# 六、运行时证据（spring-diagnostics）

```bash
node "$INCIDENT_LAB" actuator health
```
```
{"status":"UP","components":{"db":{"status":"UP","details":{"database":"H2"}},
 "diskSpace":{"status":"UP"...},"ping":{"status":"UP"}}}
```

- `actuator threaddump`：25 线程，`WAITING 11 / RUNNABLE 7 / TIMED_WAITING 7`，**无**线程阻塞在 `HikariPool.getConnection`，**无**线程停在 socketRead。
- `metrics query 'hikaricp_connections_active or ...pending or ...timeout_total'`：只有 `hikaricp_connections_active = 1`，pending/timeout 序列不存在 → 连接池低位、无获取超时。
- `actuator env`：确认 `DOWNSTREAM_TIMEOUT_MS`、`DB_POOL_SIZE` 等以 `origin: System Environment Property` 存在，但**值全部 `******`**，因此生效数值一律以 `runtime env` 为准。
- 独立交叉验证超时确实不是 2000ms：`max(http_server_requests_seconds_max{uri="/api/orders/{id}"})` = **0.1429s**，远小于 2s，请求没有等满默认超时。

**结论方向：运行时证据否定“资源类/依赖不可用类”故障，问题在应用层把一次下游退化直接升级成 5xx。**

---

# 七、历史召回（historical-incident-lookup）

`workspace_memory_search(query="target-service", kind="lesson")` → **命中 1 条**（标题《target-service 5xx 定位方法：锚点口径与负证据怎么取》，`wmi_149fb42f…`，2026-11-04T07:54:26Z 写入）。

- 它只给方法与症状词汇（NullPointerException / 下游超时 / 订单接口报错…），**不含任何一次故障的结论**，因此不作为本次判断依据。
- 对本次的意义：它提示要重点验证“下游超时 → 订单接口 5xx”这条链路，并要求用 `--count` 取负证据、用容器重建而非 commit 作部署锚点——本次均照此执行。
- 无同类历史**处置**记录可引用（1 条为方法条目）。

---

# 八、关键反事实（用于区分“配置”与“代码”谁是触发源）

同一份日志/指标里存在两个天然对照组：

| 时间窗（UTC） | 运行实例 | `Read timed out` | `NullPointerException` | 5xx |
|---|---|---|---|---|
| 07:34:15 – 07:40:17 | 重建 07:34:14.932 | **243** | **0** | **无**（07:30–07:41 的 5xx 序列在 07:41:00 才首次出现） |
| 07:52:18 – 08:12:24 | 重建 07:52:18.484 | **0** | **0** | 无（同期 `loaded for user` = 1494 次） |
| 08:12:24 – 至今（本次） | 重建 08:12:24.694 | **193** | **194** | 0.31–0.44 持续 |

- 第一行证明：**只有 1ms 超时、保留 `null` 兜底时 → 0 个 NPE、0 个 5xx**（超时被降级成 `ship_to=UNKNOWN`，接口仍 200）。
- 第二行证明：**超时恢复默认值时下游完全健康**（1494 次订单成功）。
- 第三行：两个条件同时成立 → 5xx 立刻出现，且从进程第一个请求就开始。

→ 触发源不是“最近有过一次提交”这个笼统事实，而是 **08:12:24 这次重建同时生效的“1ms 下游超时（使 profile 恒为 null）”+“已删除 null 兜底的代码（把 null 变成 500）”**。

---

# 九、根因报告（root-cause-report 报告契约）

```text
服务 / 严重级 / 告警起始
  target-service / critical / activeAt = 2026-11-04T08:12:49.992Z（pending 时刻；
  firing ≈ activeAt + for，for 值本次无法读取）

【根因假设】
  置信度：0.90
  机制：本次重建（2026-11-04T08:12:24.694Z → 应用就绪 08:12:31.506Z）把下游
        读超时写成 DOWNSTREAM_TIMEOUT_MS=1ms，使 /api/orders/{id} 对自身
        /profiles/{id} 的每次调用都以 Read timed out 失败、fetchProfile 返回 null；
        同时运行中的构建已删除 OrderService.loadOrder 的 null 兜底分支
        （OrderService.java:29 直接 profile.get("address")），null 被解引用成
        NullPointerException → HTTP 500。两个条件同时成立，5xx 占 ~31–44%，
        且只落在 /api/orders/{id} 上。

【支持证据】
  - 生效值 DOWNSTREAM_TIMEOUT_MS=1，knob_file_mtime=08:12:24.106Z，而
    application.yml 默认为 2000ms。
      来源：node "$INCIDENT_LAB" runtime env   时间：2026-11-04T08:13Z 采集
  - 本次运行首个异常 08:12:31.839Z "Read timed out"（193 次）。
      来源：logs first/ grep --count  时间：2026-11-04T08:12:31.839Z
  - 首个 NPE 08:12:31.845Z，栈顶 OrderService.loadOrder(OrderService.java:29)
    ← OrderController.get(OrderController.java:21)（194 次）。
      来源：logs first 'NullPointerException' / grep --count   时间：08:12:31.845Z
  - 代码：OrderService.java:29 = order.put("ship_to", profile.get("address"))，
    无判空；DownstreamClient.fetchProfile 异常分支 return null。
      来源：target-service/src/main/java/.../OrderService.java、DownstreamClient.java
  - commit 4e7c499（07:54:24Z）删除了 if(profile==null){ship_to=UNKNOWN} 分支。
      来源：git diff 4e7c499
  - 5xx 仅出现在 uri=/api/orders/{id}（1.236 rps），总量稳定 2.9 rps 未下跌。
      来源：metrics query topk(5, sum by(uri)(rate(...status=~"5.."))) 、metrics range
  - 请求最大耗时 0.1429s << 2000ms，佐证生效超时为毫秒级。
      来源：metrics query max(http_server_requests_seconds_max{uri="/api/orders/{id}"})
  - health UP（db/disk/ping）、hikaricp_connections_active=1、无 pending/timeout 序列、
    threaddump 无 HikariPool.getConnection 阻塞。
      来源：actuator health / metrics query / actuator threaddump
  - 反事实：07:34:15–07:40:17 有 243 次超时、0 次 NPE、无 5xx；
    07:52:18–08:12:24 有 0 次超时、0 次 NPE、1494 次订单成功。
      来源：logs grep --count（按窗口），metrics range 5xx（该窗口无序列）

【反对证据 / 尚未解释】
  - 本次运行有 15 行 "order N loaded for user N"（约 7% 订单请求仍成功），
    说明 1ms 读超时不是 100% 触发（本地 keep-alive 复用 RTT 偶尔未超 1ms）；
    这也解释了为何是 31–44% 而不是 100%，但未做逐请求测量。
  - 告警 annotation 比例（34–43%）与 NPE/总请求比（约 46%）不等，因为分母包含
    应用自调用的 /profiles/{id} 成功请求；该差异不影响归因。
  - 告警规则的 for 值无法读取，真实 firing 时刻未知，只能确定 pending 起始。

【已排除的假设及排除依据】
  - 依赖/资源类故障：health 全 UP、连接池 active=1 且无 pending/timeout、
    threaddump 无阻塞；下游是自身 8080 的业务接口，返回业务性超时而非拒连。
  - 数据库慢查询/耗尽：db UP，订单行在 NPE 之前已成功读出（queryForMap 通过）。
  - 流量突增：total rate 全程 2.74–2.91 rps，无跳变。
  - 单纯“最近一次发布引起”：commit 07:54:24Z 比容器重建早 18 分钟，且无兜底行为
    在 07:40:17Z（早于 commit）已出现——commit 时间不能当部署锚点；真正生效时刻是
    08:12:24 的重建。发布假设不能笼统成立，只能精确到“本次重建带来的
    1ms 超时 + 现有构建缺失兜底”这一组合。
  - 误报/阈值过敏：5xx 达 31–44%（阈值 5%），且有确定 NPE 栈。
  - 404 类 ERROR（userId=9999）：属长期存在的无害噪音，load 路径不含 9999，
    与本次 5xx 无共同调用链。

【跳过的步骤及原因】
  - 读取告警规则 for / 精确 firing 时刻：只读工具仅暴露
    metrics alerts|query|range|targets，无 /api/v1/rules 通道，无法取得 for。
  - 用 actuator env/configprops 判读具体数值：端点把值全部掩码为 ******，
    只能证明配置项以 systemEnvironment origin 存在；生效值改用 runtime env。
  - 未做容器外配置文件比对：规则明确要求不得绕过容器读取生效配置。
  - 未做 JVM 泄漏采样：形态为台阶而非缓慢增长，heap 假设已被指标形态排除。

【处置建议（仅草案，不执行）】
  1. 立刻恢复下游超时（消除触发条件）：
     sed -i 's/^DOWNSTREAM_TIMEOUT_MS=.*/DOWNSTREAM_TIMEOUT_MS=2000/' \
       /home/fs-user/.config/miniclaw-lab/lab.env
     docker compose up -d --force-recreate target-service
     # 与 application.yml 默认 2000ms 对齐；改后需重建容器才会生效（env 在启动时注入）
  2. 恢复 null 兜底（消除升级路径），二选一：
     git revert 4e7c499        # 或把 OrderService.java:29 改回判空分支
     建议同时保留 "ship_to": "UNKNOWN" 语义并对下游失败打 warn 指标，
     避免下游任何抖动直接变成 5xx。
  3. 验证（只读）：
     node "$INCIDENT_LAB" logs grep 'NullPointerException' --since <新部署时间> --count   # 期望 0
     node "$INCIDENT_LAB" metrics range '<5xx 比例表达式>' <start> <now> 30s               # 期望无序列
     node "$INCIDENT_LAB" metrics alerts                                                  # 期望恢复
  4. 后续治理：把 DOWNSTREAM_TIMEOUT_MS 纳入部署模板并设合理下限校验
     （例如 <50ms 直接拒绝启动），避免 1ms 这类值静默上线。
```

---

**一句话结论**：本次 5xx 是 08:12:24 重建时把下游读超时压到 1ms，叠加已删除 null 兜底的 `OrderService.loadOrder`，使 `/api/orders/{id}` 的每次下游超时都变成 NPE→500；部署与异常首次出现相差 0.34 秒，属于部署高度相关，但归因必须落在“超时值 + 缺失兜底”这一组合上，而不是“最近提交过代码”。

