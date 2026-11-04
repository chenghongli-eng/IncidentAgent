诊断已完成，以下是完整结论。

## 锚点（三个，全程口径一致）

| 锚点 | 值 | 来源 |
|---|---|---|
| ① 告警起始 | `activeAt = 2026-11-04T03:42:04.991Z`（**pending 时刻**）；`for=30s` → firing ≈ `03:42:34.99Z` | `metrics alerts` + `/api/v1/rules`（duration:30） |
| ② 异常首次出现（首个导致 5xx 的异常） | `2026-11-04T03:41:43.467Z`（下游 Read timed out）→ `03:41:43.472Z`（NPE 500） | `logs first 'Read timed out' --since 2026-11-04T00:00` / `logs first 'threw exception' --since 2026-11-03` |
| ③ 最近一次部署 | `container_started_at = 2026-11-04T03:41:38.052Z`，应用就绪 `03:41:43.184Z`（"Started ... in 4.343 seconds"）。**口径：容器重建时刻** | `runtime started` |

服务：target-service ｜ 严重级：critical ｜ 告警起始：2026-11-04T03:42:04.99Z（pending），firing ≈ 03:42:34.99Z
Δ(②−③) = **5.4 秒**（若按应用就绪口径，② 在就绪后 0.29 秒）→ 落在 15 分钟窗口内，判定为**高度相关**。

## 各步证据

**metric-triage（形态=台阶，不是尖刺/缓慢增长）**
- 5xx 比例 rate 查询（02:40:00–03:42:30，126 个 step）只返回 2 个点：`03:42:00=11.96% → 03:42:30=40.24%`，03:42:45 峰值 `43.32%`，之后稳定在 40–43%（告警值 43.38%）。**03:41:30 之前该序列根本不存在**——按分子缺失即无 500 的口径，这段时间是"零 5xx"的负证据，不是"查不到"。
- 流量未崩：总量 `2.85–2.91/s` 全程平稳（03:42:30 短暂 2.25，03:43:00 已回到 2.909）→ 属于"部分失败"而非全挂，排除流量突变/容量类。
- 影响面：`topk by (uri)` 与 `increase by (uri,status)` 均显示 **只有 `/api/orders/{id}` 在报错，且全是 500（outcome=SERVER_ERROR）**；`/profiles/{userId}` 只有 200。

**log-triage（首次出现 + 栈顶 + 分布）**
- 首次出现（导致 5xx）：`03:41:43.467` 起，每个请求成对出现两条 ERROR：
  `DownstreamClient - profile lookup failed ... ResourceAccessException: I/O error on GET "http://127.0.0.1:8080/profiles/N": Read timed out`
  → 3 毫秒后 `dispatcherServlet - ... threw exception [java.lang.NullPointerException: Cannot invoke "java.util.Map.get(Object)" because "profile" is null]`
- 栈顶：`com.example.target.OrderService.loadOrder(OrderService.java)` 中 `profile.get("address")` 处（`profile` 为 null）。
- 分布：`--count` 统计 03:41 之后 timed out=113 / NPE=114，**1:1 配对**，覆盖 userId 1/3/4/5，即 load driver 命中的全部 `/api/orders/*` 路径 → 系统性路径，不是个别脏数据。
- 负证据：03:30–03:40 两个 10 分钟桶 `timeout=0, npe=0`；03:15–03:17 每分钟 `loaded=75`，03:42 以后 `loaded` 掉到 0–3（NPE 发生在 `log.info("order ... loaded")` 之前，与代码顺序一致）。

**spring-diagnostics（排除资源/依赖类）**
- `actuator health`：`{"status":"UP"}`，db H2 `UP`。
- 连接池：`hikaricp_connections_active=1`，无 pending，无 timeout 增量 → 不是连接池耗尽。
- `actuator threaddump`：25 个线程，无任何线程阻塞在 `HikariPool.getConnection` 或 `socketRead` → 不是线程池/下游挂起。
- 下游自身健康：服务端 `/profiles/{userId}` 10 分钟内 `737/737 全 200`；而客户端侧 `http_client_requests_seconds_count` 在 `/profiles/*` 上出现 `exception=ResourceAccessException, outcome=UNKNOWN`（每个 userId ~55–60 次/10min）。**同一路径服务端 200、客户端超时**，说明不是下游故障，是客户端读超时被压得极小。

**deployment-window（结论：高度相关）**
- `runtime env`：`DOWNSTREAM_TIMEOUT_MS=1`（application.yml 默认 `${DOWNSTREAM_TIMEOUT_MS:2000}`），knob 文件 mtime = `2026-11-04T03:41:37.614Z` —— **改配置 0.44 秒后容器重建（03:41:38.052）**。
- 前序重建：01:33:38、03:18:23、03:23:43、03:25:51、03:41:43（`logs grep 'Started TargetServiceApplication' --since 2026-11-02`）。

**git-diff-analysis（代码侧同一调用链）**
- 部署窗口内唯一提交：`af73f23 2026-11-04T03:25:06Z feat(order): enrich response with downstream shipping address`（注意 commit 时间比生效早 16 分钟，**不作为部署锚点**）。
- diff 内容正是异常的调用链、正是栈顶那行：
  ```diff
  -        if (profile == null) { order.put("ship_to", "UNKNOWN"); }
  -        else { order.put("ship_to", profile.get("address")); }
  +        order.put("ship_to", profile.get("address"));
  ```
  该兜底是 10-30 的 `7bb726a fix(order): tolerate missing downstream profile` 加的，af73f23 把它删了。
- `DownstreamClient.fetchProfile` 的契约（源码）：`catch (Exception) → return null`，即**任何**下游异常（超时/404/5xx）都被降级成 null。于是"依赖抖动"被代码伪装成"空数据"，再由无兜底的 `profile.get()` 变成 NPE。

**关键的自然对照实验（这是置信度的来源）**
- 03:18:23–03:23:43 那次容器：同样 `Read timed out` 每分钟 46–78 次（共 377 次），`threw exception = 0`，`loaded for user` 仍在 55–80/min，5xx 指标序列不存在 → **1 ms 超时 + 有兜底的代码 = 无 5xx**。
- 03:25:51–03:41:37 那次容器（已含 af73f23）：超时 0、NPE 0 → **无兜底的代码 + 正常 2 s 超时 = 无 5xx**。
- 03:41:38 之后两者同时具备 → 100% 下游失败 × 无兜底 = 稳定 40% 5xx。

**historical-incident-lookup**
- `workspace_memory_search(query="target-service", kind="lesson")` 命中 1 条，内容是该服务 5xx 的**排查方法**（锚点口径、负证据用 `--count`、要查运行时配置层、actuator 值被掩码），不含任何一次故障的结论。
- 对本次的意义：它提示"别只查 git、要查运行时生效值"和"别用首个 ERROR 行当锚点"——本次两条都验证成立（真正诱因之一在仓库外的 knob 文件；10-28 起长期存在的下游 404 ERROR 是无害噪声）。
- 该服务无同类历史**结论**可引用。

## 根因报告（root-cause-report 收口）

```text
服务 / 严重级 / 告警起始
  target-service / critical / activeAt 2026-11-04T03:42:04.99Z（pending），firing ≈ 03:42:34.99Z

【根因假设】
  置信度：0.90
  机制：运行时把下游读超时压到 1 ms（knob 文件 03:41:37.614 改、03:41:38.052 容器重建生效），
        使每次 GET /profiles/{id} 必然 Read timed out；DownstreamClient 捕获异常后 return null；
        本次部署的 af73f23 删除了 OrderService 中 profile==null 的兜底分支，
        直接 profile.get("address") 抛 NullPointerException → /api/orders/{id} 返回 500。
        即"配置让依赖必然失败"+"代码不再容错"两个必要条件的叠加。

【支持证据】
  - 5xx 序列 03:41:30 前完全缺失，03:42:00 起 11.96%→40.24%→43.32% 台阶抬升并维持 40–43%
      来源：metrics range 5xx ratio (02:40–03:42:30)，126 step 仅 2 点有值        时间：03:42–03:44
  - 只有 /api/orders/{id} 产生 500，/profiles/{userId} 服务端 737/737 全 200
      来源：metrics query increase by (uri,status)                             时间：03:44
  - 客户端侧 /profiles/* 出现 ResourceAccessException/UNKNOWN 约 55–60 次/10min，与服务端 200 并存
      来源：metrics query http_client_requests_seconds_count by (uri,outcome)   时间：03:44
  - 日志:  "Read timed out" 与 "NPE: profile is null" 1:1 配对，首次 03:41:43.467/03:41:43.472
      来源：logs first / logs grep --count                                     时间：03:41:43 起
  - 运行时生效值 DOWNSTREAM_TIMEOUT_MS=1（默认 2000），knob mtime 03:41:37.614
      来源：runtime env                                                        时间：诊断时刻
  - 部署锚点 container_started_at 03:41:38.052 / 应用就绪 03:41:43.184
      来源：runtime started                                                    时间：03:41
  - af73f23 删除 null 兜底，改的正是栈顶方法 OrderService.loadOrder
      来源：git log / git diff af73f23 / git show 7bb726a                     时间：commit 03:25:06Z
  - 对照实验①：03:18:23–03:23:43 同样 1 ms 超时（377 次 timed out）、旧代码 0 次 NPE、0 个 500
      来源：logs grep --count 分桶 + metrics range 5xx ratio                    时间：03:18–03:24
  - 对照实验②：03:25:51–03:41:37 新代码、正常超时，0 次 timed out、0 次 NPE
      来源：logs grep --count 分桶                                             时间：03:25–03:41

【反对证据 / 尚未解释】
  - 11-03 03:41 也出现过 65 次同文案 NPE，当时 0 次超时，伴 310 次下游 404（userId=9999）
    → 该 null 路径是**既有潜在缺陷**，本次不是首次暴露；但 10-30 的 7bb726a 兜底为何在 11-03
    未生效无法用 git 解释（当天无对应 unguard 提交），推测镜像构建版本不同，需查当时镜像 tag。
  - 03:18–03:23 期间的 DOWNSTREAM_TIMEOUT_MS 实际值只能由"下游全部超时"反推，knob 文件 mtime
    只保留最后一次编辑，无法直接读到当时的值 → 该段对照实验属间接证据。
  - 1 ms 旋钮是谁、为什么改（实验台脚本或人工）不在只读证据范围内，未查证。
  - 服务端 /profiles 在客户端已超时的情况下仍被计入 200，说明"下游健康"这一结论是就服务端而言；
    不影响本结论，但会掩盖下游侧的调用失败，属于可观测性缺口。

【已排除的假设及排除依据】
  - 发布变更无关：排除。② 03:41:43.467 − ③ 03:41:38.052 = 5.4 秒，落在 15 分钟窗口内；且
    af73f23 直接改写异常栈顶方法的空值处理。
  - 下游依赖故障：排除。health UP；/profiles 服务端 737/737 全 200；异常是 Read timed out（客户端
    读超时），不是 ConnectException/拒连。
  - 资源类（连接池/线程池/内存）：排除。hikaricp active=1、无 pending、无 timeout 增量；
    threaddump 25 线程无阻塞于 getConnection/socketRead。
  - 流量突增或全站不可用：排除。总请求 2.85–2.91/s 全程平稳，故障后回到 2.909/s；故障面单接口。
  - 数据库/慢查询：排除。H2 UP，连接池空闲，loadOrder 的 queryForMap 在异常前已完成（NPE 发生在
    取到 order 之后）。
  - 把首个 ERROR 行当锚点：已按口径排除——10-28 起长期存在的下游 404 / timed out ERROR 在故障前
    大量存在且不产生 5xx。

【跳过的步骤及原因】
  - actuator env / configprops：跳过。show-values=never，值全为 ******，只能证明配置项存在，
    不能证明生效值；已改用 runtime env 取生效值。
  - 写操作类验证（重启、改 logger 级别、shutdown）：跳过。本次只授予只读通道。
  - git-diff-analysis 未跳过（已执行）；historical-incident-lookup 未跳过（仅命中方法类记忆）。

【处置建议（仅草案，不执行）】
  1. 止血（先恢复超时，可立即消掉 500）：
       sed -i 's/^DOWNSTREAM_TIMEOUT_MS=.*/DOWNSTREAM_TIMEOUT_MS=2000/' ~/.config/miniclaw-lab/lab.env
       incident/lab.sh up -d --force-recreate target-service
     （必须走 lab.sh 的 --env-file；裸 docker compose up 读不到 knobs，会静默回默认值）
  2. 修复代码（真正的缺陷在缺兜底，不修则任何下游抖动都会重演）：
       git revert --no-edit af73f23        # 恢复 if (profile == null) ship_to="UNKNOWN"
     或改为 Optional/返回 503，把"依赖不可用"与"数据为空"分开。
  3. 契约修正：DownstreamClient 不应把异常折叠成 null —— 404 返回 empty，超时/5xx 抛异常由上层
     决定 503 或降级，否则依赖故障会长期以 NPE 形式出现（11-03 的 404 即此模式）。
  4. 加门禁：为 /api/orders/{id} 增加"下游不可用"场景测试；对 DOWNSTREAM_TIMEOUT_MS 这类
     不进版本库的运行时旋钮加变更审计。
  5. 验证（人工执行）：
       curl -s localhost:9090/api/v1/query --data-urlencode \
         'query=sum(rate(http_server_requests_seconds_count{application="target-service",status=~"5.."}[1m]))'
     期望：序列再次消失（无 5xx），且 logs 中 "threw exception" 计数停止增长。
```

一句话：**这次不是"下游挂了"，是"下游超时被压到 1 毫秒"遇上"刚删掉空值兜底的那次提交"**——单独任何一个都不产生 500，两者叠加才有 03:41:43 起的 40% 台阶。

