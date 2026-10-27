All evidence is collected and cross-verified (475 downstream failures = 475 read timeouts = 475 NPEs, 0 × 404). Here is the full diagnosis.

---

# target-service 5xx 故障诊断报告

## 三个锚点

| 锚点 | 时间 (UTC) | 来源 |
|---|---|---|
| ① 告警起始 | **2026-10-27T07:24:49.991948342Z**（`activeAt` = 进入 pending 的时刻） | `$LAB metrics alerts` |
| ② 异常首次出现 | **2026-10-27T07:24:29.509Z**（本次持续故障的首个 5xx 因果异常） | `$LAB logs grep 'profile lookup failed' --since 2026-10-27T07:24:00Z --until 2026-10-27T07:24:35Z` |
| ③ 最近一次部署 | **2026-10-27T07:24:21.000339958Z**（容器重建时刻；应用就绪 07:24:29.198Z） | `$LAB runtime started` |

Δ(②−③) = **+8.5 秒** → 落在 `[T_dep, T_dep+15min]` → **高度相关**。
告警口径说明：Prometheus v1 只给 `activeAt`，`firing = activeAt + for`；本通道无 rules 子命令，`for` 值不可读，故 firing 时刻只能记为 `07:24:49.99Z + for（未知）`。告警比首个异常晚 **20.5 秒**。

---

## 步骤 1 · Alert（已执行）

`$LAB metrics alerts`：
```json
{"alertname":"HighServerErrorRate","severity":"critical","state":"firing",
 "activeAt":"2026-10-27T07:24:49.991948342Z","value":"3.8788701461603503e-01"}
```
`summary` 明示 target-service 5xx 比例超 5%，与 `value=38.79%` 一致。告警未指明 `service`/`job` label，服务名取自 `summary` 文本。

## 步骤 2 · Metrics（已执行）

**形态 = 台阶，不是尖刺也不是缓慢增长。** `$LAB metrics range '5xx 比例' 2026-10-27T06:00:00Z 2026-10-27T08:00:00Z 30s`：

| 采样时刻 | 5xx 比例 |
|---|---|
| 06:02:30Z … 07:24:30Z | **0**（连续 0，无空洞） |
| 07:25:00Z | 0.2654 |
| 07:25:30Z | 0.4354 |
| 07:26:00Z … 07:28:30Z | 0.43 → 0.3636 平台 |

`$LAB metrics query 'max_over_time(...[24h:30s])'` = 0.4354（即当前平台，24h 内无更高值）；`count_over_time(...[24h:30s])` = 308 个非零采样点。

**流量没变**：`$LAB metrics range 'sum(rate(...[1m]))'` 全程 2.87–2.91 req/s 恒定 → 是**部分失败**，不是全挂，也不是流量激增导致的过载。

**影响面**：`topk(5, sum by (uri)(rate(...5xx...)))` 只返回一项 —— `uri=/api/orders/{id}` 1.0545 req/s。`sum by (uri,status)` 进一步显示：

| uri | 200 | 500 |
|---|---|---|
| `/api/orders/{id}` | 0.6728 | **0.5637** |
| `/profiles/{userId}` | **1.2364** | 0 |

关键：**下游 `/profiles/{userId}` 自身仍以 200 正常服务**（1.24 req/s），失败只发生在订单接口。

`$LAB metrics targets` → `health:"up"`, `lastError:""`, 抓取耗时 5ms → 指标本身可信，不是采集伪影。

## 步骤 3 · Logs（已执行）

**首个异常（07:24:29.509Z）**，连续两条同请求：
```
07:24:29.509 ERROR DownstreamClient - profile lookup failed userId=1
  cause=ResourceAccessException: I/O error on GET request for
  "http://127.0.0.1:8080/profiles/1": Read timed out
07:24:29.515 ERROR dispatcherServlet - Request processing failed:
  java.lang.NullPointerException: Cannot invoke "java.util.Map.get(Object)" because "profile" is null
```

**1:1:1 因果对应**（同一时刻取的三个计数，`--since 2026-10-27T07:24:21Z`）：

| 计数 | 值 |
|---|---|
| `profile lookup failed` | **475** |
| `Read timed out` | **475** |
| `NullPointerException` | **475** |
| `NotFound: 404` | **0** |

**每一次下游失败恰好产生一次 NPE、一次 500**，且 100% 是客户端读超时，零 404。

**历史负证据**（关键，用来区分「代码缺陷」和「本次触发」）：
- `$LAB logs grep 'NullPointerException' --since 2026-10-19 --until 2026-10-27T07:24:21Z --count` → **1**
- `$LAB logs grep 'profile lookup failed' --since 2026-10-19 --until 2026-10-27T07:24:21Z --count` → **1**

整个历史里只有一次下游失败：2026-10-27T04:02:41.808Z，`userId=9999 cause=HttpClientErrorException$NotFound: 404 : [no body]` —— 一次**孤立**的 404 触发，与本次超时机制不同，且只造成 1 次 500（5xx 比例 03:50–04:15 区间实测全 0，未触发告警）。

**3 次容器启动**（`logs grep 'Started TargetServiceApplication'`）：2026-10-26 07:29:44.919 → 2026-10-27 01:39:59.254 → 2026-10-27 07:24:29.198。重启细节（`logs grep '2026-10-27 07:24:2'`）：`07:24:20.546 Shutdown initiated` → `07:24:23.172 Starting TargetServiceApplication` → `07:24:27.027 Tomcat initialized` → `07:24:29.198 Started in 7.063 seconds`。

## 步骤 4 · Deployment window（已执行）

`$LAB runtime started` → `container_started_at=2026-10-27T07:24:21.000339958Z`，`app_started_log=2026-10-27 07:24:29.198`。**口径选定：以容器重建时刻为 T_dep，全程只用它。**

`$LAB runtime env`：
```
DOWNSTREAM_TIMEOUT_MS=1          ← 1 毫秒
DB_POOL_SIZE=10
LOAD_PATHS=/api/orders/1,/api/orders/3,/api/orders/4,/api/orders/5   ← 缺 /api/orders/2
knob_file: /home/fs-user/.config/miniclaw-lab/lab.env
knob_file_mtime: 2026-10-27T07:24:20.061Z
```
旋钮文件最后修改时间 **07:24:20.061Z**，比容器重建早 0.94 秒 —— 改动旋钮后立即重建容器以加载新值。

`$LAB git log --since 2026-10-27T00:00:00Z --limit 20` → **空**。窗口内**无代码变更**，本次变更在**运行时配置层**。

**对上一次发布的判定**：commit `35854c8` 于 2026-10-26T07:23:25Z 提交，随 2026-10-26T07:29:44.919Z 那次容器就绪生效，距 T_err（07:24:29.509Z）**20 小时 55 分**，远超 15 分钟窗口 → 按规则**排除该发布作为本次故障的触发源**。但它不是无关变更，见下一步。

## 步骤 5 · Git diff（已执行）

`$LAB git show 35854c8` / `git diff 35854c8` —— `feat(order): enrich response with downstream shipping address`，只改 `OrderService.java` 一处：

```diff
         Map<String, Object> profile = downstream.fetchProfile(userId);
-        if (profile == null) {
-            order.put("ship_to", "UNKNOWN");
-        } else {
-            order.put("ship_to", profile.get("address"));
-        }
+        order.put("ship_to", profile.get("address"));
```

**改动落在异常调用链上**（`OrderService.loadOrder` → `DownstreamClient.fetchProfile` → `profile.get("address")` 正是 NPE 消息所指的位置）。失效机制：**删除了兜底分支，下游返回 null 时不再降级，直接解引用空指针**。

`target-service/src/main/resources/data.sql` 的种子注释印证了这是被删掉的设计路径：
> `-- Order 2 references user 9999, which has no profile row; the service degrades a missing profile to ship_to=UNKNOWN.`

## 步骤 6 · spring-diagnostics（已执行，资源类/依赖类排除）

| 观察 | 值 | 结论 |
|---|---|---|
| `actuator health` | `status:UP`；db UP (H2)、diskSpace UP (free 7.6GB)、ping UP，**无 DOWN 组件** | 排除依赖整体不可用 |
| `metrics/hikaricp.connections.active` | 1.0 | 连接池未打满 |
| `metrics/hikaricp.connections.pending` | 0.0 | 无等待获取连接 |
| `metrics/hikaricp.connections.timeout` | COUNT 0.0 | 无连接获取超时 |
| `metrics/jvm.threads.live` | 25.0 | 无线程膨胀 |
| `actuator threaddump` | 25 线程（8 RUNNABLE / 10 WAITING / 7 TIMED_WAITING），http-nio 12 个，**0 个 BLOCKED** | 排除线程耗尽 |
| `actuator loggers/com.example.target` | effectiveLevel INFO | INFO 计数可信（成功日志未被屏蔽） |

**客户端侧耗时（决定性）**，`actuator metrics/http.client.requests`：
- `error=ResourceAccessException`：COUNT **1051**，TOTAL_TIME 2.3465s，MAX 19.97ms，uri = `/api/orders/{1,3,4,5}` + `/profiles/{1,3,4,5}`
- `error=none`：COUNT **137**，TOTAL_TIME 0.3447s，MAX 7.07ms，uri = **只有** `/profiles/{1,3,4,5}`

→ 失败调用均值 2.23ms、成功调用均值 2.52ms。**回环调用本身约需 2.5ms，而超时预算被压到 1ms，因此约 88.5% 的出站调用被客户端主动中断**（1051/1188）。

`actuator env/app.downstream.timeout-ms` → 值为 `******`（掩码），按 skill 口径只证明配置项存在，生效值以 `runtime env` 为准。

## 步骤 7 · 历史召回（已执行）

`workspace_memory_search(query="target-service", kind="lesson")` → **命中 1 条**：`wmi_f7d93ce7` rev.6《target-service 5xx 定位方法：锚点口径与负证据怎么取》(updated 2026-10-27T07:17:25Z)。

该条**只含方法与症状词汇**（NullPointerException、下游超时、订单接口报错、5xx 抬升），**不含任何一次故障的结论**。它提示了三个方向，本次均被独立取证印证：① 锚点口径（activeAt≠firing；部署锚点用容器重建而非 commit 时间）；② 只查 git 会漏掉运行时配置层；③ 排除资源/依赖类的依据（连接池低位 + 下游是业务性 404/超时而非拒连）。它**不提供**本次结论。

---

# Root Cause Report（收口）

**服务**：target-service ｜ **严重级**：critical ｜ **告警起始**：2026-10-27T07:24:49.991948342Z（activeAt，pending 时刻）

### 【根因假设】
**置信度：0.92**

**机制**：运行时旋钮 `DOWNSTREAM_TIMEOUT_MS` 被改到 **1 毫秒**（旋钮文件最后修改 07:24:20.061Z，容器 07:24:21Z 重建加载），使下游回环调用 `http://127.0.0.1:8080/profiles/{id}` 的 1ms 预算低于该调用实测所需的 ~2.5ms，客户端主动中断 → `ResourceAccessException: Read timed out` → `DownstreamClient.fetchProfile` 捕获后返回 **null** → `OrderService.loadOrder` 无判空直接 `profile.get("address")` → **NullPointerException → HTTP 500**。

**分层**：
- **触发源（状态变化的那一刻）**：超时旋钮 2000ms（application.yml 默认）→ **1ms**，07:24:20 生效、07:24:21 重建、07:24:29.198 就绪、07:24:29.509 首个 500。
- **必要条件（缺陷层）**：commit `35854c8`（2026-10-26T07:23:25Z，随 07:29:44Z 那次就绪生效）删除了 `profile == null → ship_to=UNKNOWN` 兜底。**没有这个缺陷，下游超时只会降级为 200，不会产生 5xx。**
- **放大条件**：业务流量与负载探针共用同一路径，失败面覆盖 `/api/orders/{id}` 全部请求；而下游 `/profiles/{userId}` 自身仍以 200 服务（1.2364 req/s），说明被依赖方没有挂。

### 【支持证据】
| 证据 | 来源 | 时间 |
|---|---|---|
| 生效超时 = 1ms，旋钮文件 mtime 07:24:20.061Z | `$LAB runtime env` | 07:24:20 |
| 容器重建、应用就绪 | `$LAB runtime started` | 07:24:21 / 07:24:29.198 |
| 首个异常 = Read timed out → NPE（同请求相邻 6ms） | `$LAB logs grep 'profile lookup failed' --since 07:24:00 --until 07:24:35` | 07:24:29.509 / .515 |
| 475 失败 = 475 超时 = 475 NPE = 0 个 404（1:1:1） | `$LAB logs grep ... --count`（三个同刻计数） | 至今 475 |
| 重启前全历史仅 1 次下游失败、1 次 NPE（404，user 9999） | `$LAB logs grep 'NullPointerException' --since 2026-10-19 --until 07:24:21 --count` → 1 | — |
| 5xx 比例 0 → 0.2654 → 0.4354 台阶，流量恒定 2.9 rps | `$LAB metrics range`（比例、流量两条） | 07:24:30→07:25:00 |
| 5xx 只在 `/api/orders/{id}`；`/profiles/{userId}` 仍 200/1.2364 rps | `$LAB metrics query 'sum by (uri,status)'` | 07:30 |
| 删除了 null 兜底分支 | `$LAB git diff 35854c8` | 2026-10-26T07:23:25Z |
| 失败调用均值 2.23ms > 预算 1ms；88.5% 出站调用中断 | `$LAB actuator metrics/http.client.requests`（按 error 分组） | 07:31 |
| 资源类全部低位（pool 1/0/0、25 线程、0 BLOCKED、health 全 UP） | `actuator metrics/*`、`actuator threaddump`、`actuator health` | 07:31 |
| 窗口内无代码变更，今天无提交 | `$LAB git log --since 2026-10-27T00:00:00Z` → 空 | — |

### 【反对证据 / 尚未解释】
1. **日志里没有完整堆栈**（`logs grep 'at java.base/java.lang'` 无匹配，`at com.example.target` 也无匹配），NPE 栈顶行**未能直接取证**；栈顶由 NPE 消息 + 源码 + diff 三方推定，不是抓到的栈。
2. **2026-10-27T01:39:59Z 那次重启的触发原因在本通道不可见** —— 旋钮文件只能读到最后一次修改时间，无法回溯历史值。
3. **LoadDriver 探针自身也全部以 ResourceAccessException 失败**（uri=/api/orders/*）。源码里 `LoadDriver` 注入的是无限定名 `RestTemplate`，而 `RestTemplateConfig` 上 `@Primary` 标在 `downstreamRestTemplate`（1ms）上，因此探针复用 1ms 客户端——但 actuator 不暴露 bean 注入关系，**未直接验证**。这不影响 500 的归因（已由日志 1:1:1 锁定），但说明故障期间负载探针已失效。
4. 磁盘 free 7.6GB / total 105GB，仅 7.3% 剩余。health 报 UP，**但**这是次要风险，未与本次故障关联。

### 【已排除的假设及排除依据】
| 假设 | 结论 | 排除依据 |
|---|---|---|
| **发布/代码变更触发**（最易误判） | **排除（作为触发源）** | ① `git log --since 2026-10-27` 为空，窗口内无代码变更；② 携带 `35854c8` 的那次部署在 2026-10-26T07:29:44Z 就绪，距首个异常 **20h55m**，远超 15 分钟窗口；③ 该部署之后到 07:24:21 之前，全历史只有 1 次下游失败（404）、1 次 500，5xx 比例连续为 0。**但它保留为必要条件**：diff 直接给出了「删兜底 → NPE」机制，且 04:02:41 那次 404 型 500 证明缺陷当时已在生效。 |
| **资源类（连接池/内存/线程）** | 排除 | hikaricp active=1 / pending=0 / timeout=0；jvm.threads.live=25；threaddump 0 BLOCKED；actuator health 全 UP |
| **外部依赖不可用（拒连/服务挂了）** | 排除 | 错误是客户端侧 `ResourceAccessException: Read timed out`，**不是** ConnectException/Connection refused；`/profiles/{userId}` 服务端侧仍以 200 服务 1.2364 req/s；health 无 DOWN 组件 |
| **流量激增过载** | 排除 | 总流量故障前后恒定 2.87–2.91 req/s；`topk` 只命中一个 uri |
| **误报 / 阈值过敏** | 排除 | 实测 5xx 比例稳定 0.36–0.435，日志 475 次下游失败与 475 次 NPE 严格对应 |
| **慢增长型资源泄漏** | 排除 | 形态是台阶（0 → 0.4354），非单调爬升 |

### 【跳过的步骤及原因】
- **spring-diagnostics**：已执行 health / threaddump / env / metrics / loggers。**仅跳过 `actuator configprops`** —— 值全掩码为 `******`，只能证明配置项存在；生效值已由 `runtime env` 取得，无增量信息。
- **告警规则 `for` 值**：本工具无 `metrics rules` 通道，**不可读**。因此 firing 时刻只能表述为 `activeAt + for（未知）`，未据此做任何时间推断。
- **git-diff-analysis 未被跳过**：尽管部署窗口判定把「发布」排除为触发源，仍查了 diff —— 因为要确认该 commit 是「必要条件」还是「无关变更」，这是分层归因所需，不是过度归因。

### 【处置建议（仅草案，不执行）】
> 以下命令供人工执行；本 Agent 在诊断阶段无写权限，未执行任何一条。

1. **立即止血（治标）**：把运行时旋钮 `DOWNSTREAM_TIMEOUT_MS` 从 `1` 调回 `2000`（application.yml 默认值），并重建容器使其生效。
   草案：`# 更新 knob 文件 /home/fs-user/.config/miniclaw-lab/lab.env 中 DOWNSTREAM_TIMEOUT_MS=2000` → `# docker restart target-service`（或本环境对应的容器重建命令）
2. **根治（治本，必做）**：恢复 `OrderService.loadOrder` 的判空，或让 `DownstreamClient` 抛出明确异常交给全局异常处理器 —— 下游失败**不应**变成 NPE 500。建议以 `35854c8` 为基线恢复 `if (profile == null) { order.put("ship_to", "UNKNOWN"); } else { ... }`，与 `data.sql` 注释描述的原设计一致。
3. **加护栏**：对超时类旋钮设下限校验（如 <100ms 拒绝生效 / 启动即告警），避免 1ms 这类值静默通过；`@Primary` 的 1ms RestTemplate 同时被 LoadDriver 复用，建议给探针单独用非 primary 的 RestTemplate（现有 `probeRestTemplate` 因 `@Primary` 实际未被使用）。
4. **清理残余隐患**：`data.sql` 中 order 2 → user 9999 无 profile 行，07:24:20 的旋钮修改把 `/api/orders/2` 从 `LOAD_PATHS` 移除，等于**掩盖**了这条路径。仅调回超时后，只要有人请求 `/api/orders/2` 仍会 NPE→500（04:02:41 那次孤立 500 即此因）。建议要么补齐 profile 行，要么恢复 `LOAD_PATHS` 包含它并修复判空。

---

### 证据缺口（尚需补充的证据）
1. **NPE 完整堆栈** —— 当前日志只保留了 dispatcherServlet 的单行摘要，没有续行栈帧；需应用侧开启完整堆栈输出或从 APM 取，才能把栈顶帧从「推定」升级为「实测」。
2. **旋钮文件的历史值** —— 只读通道只能给出最后一次修改时间；需要旋钮平台的变更历史/审计日志才能证明 `DOWNSTREAM_TIMEOUT_MS` 的变更人、变更前值。
3. **2026-10-27T01:39:59Z 重启的原因** —— 该次重启在部署锚点链上留有空白。
