

---

# target-service 5xx 故障诊断报告

## 锚点

```
服务：target-service ｜ 严重级：critical ｜ 告警起始：2026-10-30T04:32:19.991948342Z (activeAt，pending 时刻)
```

**口径声明**：`metrics alerts` 返回的 `activeAt` = 告警进入 pending 的时刻，**不是 firing 时刻**。`/api/v1/rules` 显示 `HighServerErrorRate` 的 `for = 30`（30 **秒**，不是 30 分钟），故 **firing ≈ 2026-10-30T04:32:49.99Z**（= activeAt + for）。本报告全程使用这一口径，下文两个时间不混用。

**告警标签降级**：firing 载荷的 `labels` 只有 `{alertname, severity}`，**没有 `service`/`job` 标签**。服务名按告警 summary文本 `target-service 5xx error rate above 5%` 与规则表达式 `application="target-service"` 推断（`metrics targets` 也确认唯一 scrape 目标 `job=service=target-service`，`health: up`，`lastError` 为空）。

### 三个锚点

| # | 锚点 | 时间 | 口径 |
|---|---|---|---|
| ① | 告警起始 | **2026-10-30T04:32:19.991948342Z**（pending）／firing ≈ **04:32:49.99Z** | `metrics alerts` 的 `activeAt` + `/api/v1/rules` 的 `for=30s` |
| ② | 异常首次出现 | **2026-10-30T04:32:07.856Z**（首个 `Read timed out`）／04:32:07.874Z（首个 NPE→500） | 当前这一轮故障的首个**导致 5xx** 的异常；同一形态的首现是 **03:51:07.660Z** |
| ③ | 最近一次部署 | **2026-10-30T04:32:07.296Z**（应用就绪） | `runtime started` 的 `app_started_log`；容器重建时刻为 04:31:55.246Z，knob 文件最后编辑 04:31:54.196Z |

**Δ(②−③) = +0.56 秒**（若改用容器重建口径则为 +12.6 秒，两种口径均落在 `deployment-window` 的"高度相关"区间：T_dep ≤ T_err ≤ T_dep+15min）。

---

## 1. alert-triage — 告警解析

`metrics alerts` 原始输出：

```json
{ "labels": {"alertname":"HighServerErrorRate","severity":"critical"},
  "annotations": {"description":"5xx ratio is 43.59% over the last 1m.",
                  "summary":"target-service 5xx error rate above 5%"},
  "state": "firing",
  "activeAt": "2026-10-30T04:32:19.991948342Z",
  "value": "4.3590170220205504e-01" }
```

`/api/v1/rules`：`HighServerErrorRate` `for=30` `state=firing` `lastEval=04:33:04.99`，表达式 `sum(rate(...status=~"5.."[1m])) / clamp_min(sum(rate(...[1m])),0.001) > 0.05`。同组 `SlowRequests`（severity=warning）`state=inactive` —— 按"只以最高级为锚点"，warning 不另起诊断线。

## 2. metric-triage — 异常形态与影响面

**形态 = 台阶（step）**，不是尖刺也不是缓慢增长。`metrics range` 15s 步长：

```
03:50:15  0
03:51:15  0.039     ← 起跳
03:51:30  0.182
03:51:45  0.329
03:52:00  0.434     ← 45 秒内跳到 43% 并稳住
03:52:00–04:30:30 0.40–0.43 平台
04:31:30  (序列缺失) ← 容器重建窗口
04:32:30  0.215 → 04:33:00 0.437 → 持续 ~0.43
```

**影响面**（`metrics query` by uri+status，1m rate）：

| uri | status | rate/s |
|---|---|---|
| `/api/orders/{id}` | **500** | **1.200** |
| `/api/orders/{id}` | 200 | 0.0177 |
| `/profiles/{userId}` | **200** | **1.236** |
| `/actuator/health` | 200 | 0.200 |
| `/actuator/prometheus` | 200 | 0.200 |

`topk(5, sum by (uri) (rate(...status=~"5..")))` 只返回一个 uri：`/api/orders/{id}`。

**总流量未塌**：`sum(rate(...[1m]))` 全程稳定在 2.87–2.99/s（04:25–04:36 实测），只有容器重建窗口（04:31:30–04:32:15）短暂跌到 1.6–2.5/s。→ 不是"全挂"，是 `/api/orders/{id}` 近乎全失败（该 uri 内部失败占比 ≈ 1.200/1.218 ≈ 98.5%）；全局比例只有 43% 是因为分母里混入了服务**自身的内部调用**（`/profiles/{userId}` 1.236/s）、actuator 抓取（0.4/s）与后台负载驱动。

## 3. log-triage — 异常首次出现

`logs first 'NullPointerException' --since 2026-10-30T04:31:55Z` →

```
2026-10-30 04:32:07.856 ERROR [http-nio-8080-exec-1] com.example.target.DownstreamClient - profile lookup failed userId=1
    cause=org.springframework.web.client.ResourceAccessException: I/O error on GET request for    "http://127.0.0.1:8080/profiles/1": Read timed out
2026-10-30 04:32:07.874 ERROR [http-nio-8080-exec-1] o.a.c.c.C.[.[.[.[dispatcherServlet] - ... threw exception
    [Request processing failed: java.lang.NullPointerException: Cannot invoke "java.util.Map.get(Object)"
    because "profile" is null]
```

- **栈顶**：`com.example.target.OrderService.loadOrder` → `profile.get("address")`（`OrderService.java:29`）
- **异常类型**：`NullPointerException: Cannot invoke "java.util.Map.get(Object)" because "profile" is null`
- **分布**：集中在 `/api/orders/{id}` 一个接口
- **负证据（按 `--count` 取，不数行）**：`Read timed out` / `NullPointerException` 在 [2026-10-30T03:58:30Z, 04:23:36Z] 均为 **0**；`Connection refused` 全天 **0**；今天除 `profile lookup failed` 与 NPE 两类外**无其他 ERROR**。

**关键甄别（按历史教训第 1 条，取"首个导致 5xx 的异常"而非"首个 ERROR 行"）**：故障前的 ERROR 是另一条无害路径 —— `logs grep 'profile lookup failed' --since 2026-10-30T00:00:00Z --until 03:50:00Z` 返回的 7 条**全部**是 `userId=9999` 的 `HttpClientErrorException$NotFound: 404`（业务性 404，自10-26 起长期存在）。它对应的 0.6%–1.2% 基线抖动在 03:03、03:20、03:22–03:24 的比例序列里可见，但**不是本次 critical 告警的成因**。

**同一形态的首现**：`logs first 'Read timed out'`（今天）= **03:51:07.660Z**，距本次告警 41 分钟。

## 4. deployment-window — 变更归因

`runtime started`：

```
container_started_at: 2026-10-30T04:31:55.246615487Z
app_started_log:      2026-10-30 04:32:07.296 INFO [main] c.e.target.TargetServiceApplication
 - Started TargetServiceApplication in 10.268 seconds
```

`runtime env`（**当前运行容器的生效值**）：

```
DOWNSTREAM_TIMEOUT_MS=1
DB_POOL_SIZE=10
LOAD_ENABLED=true
LOAD_PATHS=/api/orders/1,/api/orders/3,/api/orders/4,/api/orders/5
SPRING_DATASOURCE_HIKARI_CONNECTION_TIMEOUT=30000
knob_file:       /home/fs-user/.config/miniclaw-lab/lab.env
knob_file_mtime: 2026-10-30T04:31:54.196Z```

`process_start_time_seconds` = 1793334715.575 → 04:31:55.575Z，与 `container_started_at` 互相印证。

**判定**：T_dep（应用就绪 04:32:07.296Z）≤ T_err（04:32:07.856Z）≤ T_dep+15min → **高度相关**。但相关性来自**运行时配置层**，不是代码层 —— 见下一步。

## 5. git-diff-analysis — 代码变更核对

`git log --since 2026-10-29T00:00:00Z --limit 20` → **输出为空。窗口内无代码变更。**

仓库最后一次提交是 4 天前的 `3ca923c`（2026-10-26T07:23:25Z，`feat(order): enrich response with downstream shipping address`）。它的 diff 确实落在栈顶调用链上：

```diff
-        if (profile == null) {
-            order.put("ship_to", "UNKNOWN");
-        } else {
-            order.put("ship_to", profile.get("address"));
-        }
+        order.put("ship_to", profile.get("address"));
```

**这解释了"为什么会 NPE"（前置缺陷：删掉了 null 兜底），但它不是本次的触发原因** —— 该提交自 10-26 起一直在线，02:14–03:50 的基线 5xx 比例为 0。

## 6. spring-diagnostics — 排除资源类 / 依赖类

| 观察 | 来源 | 结论 |
|---|---|---|
| `{"status":"UP","db":"UP","diskSpace":"UP","ping":"UP"}` | `actuator health` | 依赖健康，非依赖宕机 |
| 24 线程：13 `Unsafe.park`、3 `Object.wait`、1 `Net.accept`；**0 线程阻塞在 `HikariPool.getConnection`，0 线程停在 socketRead** | `actuator threaddump` | 连接池未耗尽、无下游阻塞 |
| `hikaricp_connections` active=1 / idle=9 / max=10 / **pending=0 / timeout=无序列** | Prometheus `hikaricp_connections_*` | 连接池低位，排除资源类 |
| heap used19.6 MB / max 192 MB | `jvm_memory_used_bytes{area="heap"}` | 无内存压力 |
| **`/profiles/{userId}` 返回 200，1.236/s** | `metrics query` by (uri,status) | **下游是活的**；失败的是调用方的等待 |

`actuator env` 的值全部为 `******`（掩码），按 skill 口径仅能证明 `app.downstream.timeout-ms` 配置项存在，生效值以 `runtime env` 为准。

---

## 7. root-cause-report

```text
服务：target-service ｜ 严重级：critical
告警起始：2026-10-30T04:32:19.991948342Z (activeAt/pending) ｜ firing ≈ 2026-10-30T04:32:49.99Z (= activeAt + for 30s)

【根因假设】
  置信度：0.95
  机制：运行时配置把下游读超时压到 1ms（DOWNSTREAM_TIMEOUT_MS=1），使 target-service 调本机 /profiles/{id} 的每一次 HTTP 调用都在1ms 内读超时；DownstreamClient.fetchProfile()
        捕获异常后返回 null，OrderService.loadOrder() 第 29 行未判空直接 profile.get("address")，
        抛 NPE → /api/orders/{id} 返回 500。

【支持证据】
  - 生效值为 1ms                       来源：runtime env        时间：当前容器 04:31:55.246Z 起
  - knob 文件最后编辑 04:31:54.196Z（容器重建前 1 秒）  来源：runtime env (knob_file_mtime)
  - 下游 /profiles/{userId} 返回 200，1.236/s，下游存活 来源：metrics query by (uri,status)
  - 每次下游调用都 Read timed out      来源：logs first 'Read timed out'  时间：04:32:07.856Z
  - NPE 栈顶 OrderService.loadOrder → profile.get("address")  来源：logs first 'NullPointerException'
                                        时间：04:32:07.874Z；源码 OrderService.java:29
  - fetchProfile catch-all 返回 null   来源：DownstreamClient.java:35-38
  - 异常在应用就绪后 0.56 秒出现，台阶形态、平台期恒定 43%  来源：logs + metrics range
  - 同一形态首现 03:51:07.660Z，每次容器重建后即刻复现（03:51:07 / 04:23:36 / 04:32:07）
  - 健康窗口 [03:58:30Z, 04:23:36Z] 内 timeout=0、NPE=0、Connection refused=0（同一份代码）
  - 零代码变更（git log --since 2026-10-29 输出为空），故障随容器重建开关，非随提交变化

【反对证据 / 尚未解释】
  - 04:31:55 的容器重建本身没有引入任何代码改动，"为什么恰好在这次重建后开始"由 knob 文件
    在 04:31:54.196Z 被改写解释；knob 文件的历史版本不可读，无法给出该值被改为 1ms 的确切时刻。
  - 03:51 / 03:57 / 04:23 / 04:30 期间的多次容器重建呈现"坏—好—坏—好"交替，说明该 knob 在
    事故前被反复改动过；哪一次改动把 1ms 写进去的，未留证据。
  - 04:31:30–04:32:15 的比例序列空洞来自容器重建期（分子序列不存在），该窗口内无 500；
    这是"空洞即无 500"，不是采集故障。

【已排除的假设及排除依据】
  - 发布/代码变更：窗口内无任何提交（git log --since 2026-10-29 输出为空），最近提交为    2026-10-26T07:23:25Z（4 天前），且该提交在 02:14–03:50 基线期 5xx 比例为 0。
    结论：代码变更只是**前置缺陷**（删掉 null 兜底），不是触发因素。Δ(T_err − T_dep) = +0.56s    的高度相关性来自运行时配置，不是代码发布。
  - 下游依赖不可用：/profiles/{userId} 实际返回 200（1.236/s）；health 全 UP；
    全天 Connection refused = 0；错误形态是超时异常而非拒连。→ 依赖本身是健康的。
  - 资源耗尽（连接池/内存/线程）：Hikari active=1、pending=0、timeout 无序列、max=10；
    线程栈无阻塞；heap 19.6MB/192MB。→ 非资源类。
  - 下游"业务性 404"路径：故障前 7 条 ERROR 全为 userId=9999 的 404，自 10-26 起长期存在，
    仅造成 0.6%–1.2% 基线抖动，不是 critical 告警的成因。
  - 慢请求/超时类告警：SlowRequests(state=inactive, for=60s) 未触发。
  - 流量塌陷导致的假象：总请求速率全程 2.87–2.99/s 稳定。

【跳过的步骤及原因】
  - historical-incident-lookup：已执行（workspace_memory_search "target-service 5xx", kind=lesson），
    命中 1 条，为方法类 lesson，不含任何历史故障结论；已按其口径逐条取锚点与负证据。未跨服务引用。
  - git-diff-analysis 的"全量 diff 阅读"：跳过 —— git log --since 2026-10-29 输出为空，
    窗口内无提交可展开；仅为确认栈顶调用链的历史上下文读取了 3ca923c 的 diff。
  - actuator configprops：跳过 —— 与 actuator env 同样被 show-values=never 全掩码成 ******，
    无法提供增量信息；生效值已由 runtime env 取得。

【处置建议（仅草案，不执行）】
  - 立即：把运行容器的 DOWNSTREAM_TIMEOUT_MS 从 1 恢复到 application.yml 的默认值 2000
    （或一个合理预算，如 1000–2000），修改 /home/fs-user/.config/miniclaw-lab/lab.env 后重建容器。
      草案：docker inspect target-service --format '{{range .Config.Env}}{{println .}}{{end}}' | grep DOWNSTREAM_TIMEOUT_MS
            # 编辑 knob 文件后：docker compose up -d --force-recreate target-service
  - 代码层（与本次触发因素无关，但应单独修）：恢复 OrderService.loadOrder() 的 null 兜底，
    或让 DownstreamClient 在失败时抛出而非返回 null，避免任何调用方再次因 null 解引用而 500。
  - 加固：把 DownstreamClient 的超时与连接池参数纳入配置校验；对 /profiles 下游调用超时单独打点，
    使"下游200 + 上游 500"这类调用侧超时能在指标上直接暴露，而不是只体现在 5xx 比例里。
  - 监控：当前 HighServerErrorRate 只看全局比例（43%），建议增补按 uri 的 5xx 比例规则，
    并对下游调用增加独立超时计数规则。
```

---

### 关于记忆本工作区已有的一条 lesson 明确约定"只留方法与症状词汇，不留任何一次故障的结论"，因此我**没有**把本次的根因结论写入记忆。我只新增了一条同样只含方法的口径条目（`target-service.5xx.ratio-denominator-self-call`）：记录"服务自调用与后台流量会抬高分母，影响面要用 `by (uri,status)` 算"这一判读口径，以及"下游 200 + 上游 5xx ⇒ 调用侧预算问题而非依赖不可用"的区分方法。

### 一句话结论

不是发布问题（窗口内零提交），而是**运行时配置把下游读超时压到 1ms**：下游 `/profiles/{id}` 每次都 1ms 读超时 → `fetchProfile` 吞掉异常返回 null → `OrderService:29` 未判空抛 NPE → `/api/orders/{id}` 近 100% 返回 500；容器于 04:31:55 重建、04:32:07 应用就绪后 0.56 秒复现，`for=30s` 的规则在 04:32:20 进入 pending、04:32:50 firing。置信度 0.95。
