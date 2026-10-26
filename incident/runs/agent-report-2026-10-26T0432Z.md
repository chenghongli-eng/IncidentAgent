

---

# target-service 线上故障根因报告（2026-10-26 04:32Z 复诊）

**服务**：target-service ｜ **严重级**：critical ｜ **告警起始**：2026-10-26T04:29:34.991948342Z

> **告警时间语义更正**（上一轮我表述为"重新 firing 于 02:20:04.99"，不够准确）：`/api/v1/rules` 显示 `for=30s`、实例 `activeAt=2026-10-26T04:29:34.991948342Z`、`state=firing`。Prometheus 的 `activeAt` 是告警实例**开始 pending（首次越过阈值）**的时刻，**firing 实际发生在 04:30:05 左右**（= activeAt + 30s）。本次按你要求以实时 `activeAt` 为锚点。
> 降级声明：告警 labels 仍只有 `alertname`/`severity`，**无 `service`/`job` label**；服务名取自 annotation summary 与 `metrics targets` 的 job=target-service。

---

## 三个锚点

| 锚点 | 时间 (UTC) | 来源 |
|---|---|---|
| ① 告警起始时间 | **2026-10-26T04:29:34.991948342Z** | `metrics alerts` → `activeAt`（规则 `for=30s`，firing ≈ 04:30:05） |
| ② 异常首次出现时间 | **2026-10-26T04:29:25.622Z**（首个下游 I/O 错误）/ **04:29:25.633Z**（首个 NPE→500） | `logs first 'profile lookup failed'` / `logs first 'NullPointerException'` |
| ③ 最近一次部署时间 | **2026-10-26T04:29:15.459909853Z**（容器重建）→ 应用 `Starting` 04:29:18.114、`Started` 04:29:25.257 | `docker inspect target-service --format '{{.State.StartedAt}}'` + `logs grep 'Starting TargetServiceApplication'` |

**Δ(②−③) = +10.2 秒** → `T_dep ≤ T_err ≤ T_dep+15min` → **高度相关**（时间维度）。

---

## 【根因假设】

**置信度：0.96**

**机制（两层，必须叠加才成立）**

1. **放大器 / 必要条件（代码层）**：commit `eed747c` 再次引入 F2 缺陷——`OrderService.loadOrder` 删除 `profile` 判空兜底，`OrderService.java:29` 直接 `profile.get("address")`；`DownstreamClient.fetchProfile` 遇下游异常按契约 `return null` → **NPE → 500**。
2. **本次跃升的触发源（运行时配置层）**：`incident/.env` 的 `DOWNSTREAM_TIMEOUT_MS` 被改为 **1（毫秒）**，在 04:29:15 容器重建时生效 → 下游自调用 `http://127.0.0.1:8080/profiles/{id}` **读超时** → `fetchProfile` 对**所有** userId 返回 null → 订单端点大面积 500。

**这解释了两件事**：为什么 5xx 从 8.75% 跃升到 41.46%，以及为什么 500 的形态与前两轮完全一致（同一个 NPE、同一个栈顶行）。

```mermaid
timeline
    title 2026-10-26 04:00–04:35 (UTC)
    section 正常
    04:11:49 容器启动(带 eed747c) : 17.5 分钟零 500
    section 配置变更
    04:29:09 .env 改: DOWNSTREAM_TIMEOUT_MS=1
    04:29:15.46 容器重建(env 生效)
    section 故障
    04:29:25.622 首个 Read timed out : 04:29:25.633 首个 NPE
    04:29:34.99 告警 activeAt(pending) : 04:30:05 firing
    04:30:15 5xx 43.4% 台阶
```

---

## 【支持证据】

**1. 运行中容器的实况环境变量（决定性）**
来源：`docker inspect target-service --format 'StartedAt: {{.State.StartedAt}}{{"\n"}}{{range .Config.Env}}{{println .}}{{end}}'`
```
StartedAt: 2026-10-26T04:29:15.459909853Z
DOWNSTREAM_TIMEOUT_MS=1
LOAD_PATHS=/api/orders/1,/api/orders/3,/api/orders/4,/api/orders/5
DB_POOL_SIZE=10
SPRING_DATASOURCE_HIKARI_CONNECTION_TIMEOUT=30000
```

**2. 配置变更时刻与容器重建严格咬合**
来源：`stat -c '%y' incident/.env` → **2026-10-26 04:29:09.009626803 UTC**
来源：`incident/.env`（仅故障相关键；该文件未纳入 git，`git status` 看不到）
```
14: DOWNSTREAM_TIMEOUT_MS=1
13: LOAD_PATHS=/api/orders/1,/api/orders/3,/api/orders/4,/api/orders/5
15: DB_POOL_SIZE=10
```
→ 改配置(04:29:09) → 重建容器(04:29:15.46) → 应用 `Started`(04:29:25.257) → **首个错误(04:29:25.622，仅 0.365 秒后)**。

**3. 超时链路直接可见**
来源：`logs grep 'profile lookup failed'` 首条原文
```
2026-10-26 04:29:25.622 ERROR [http-nio-8080-exec-1] com.example.target.DownstreamClient
  - profile lookup failed userId=1 cause=org.springframework.web.client.ResourceAccessException:
  I/O error on GET request for "http://127.0.0.1:8080/profiles/1": Read timed out
```
来源：超时参数如何生效 —— `RestTemplateConfig.java`：`setConnectTimeout/setReadTimeout(Duration.ofMillis(timeoutMs))`；`application.yml`：`timeout-ms: ${DOWNSTREAM_TIMEOUT_MS:2000}`。

**4. 决定性 A/B 对照：同一份代码，换个 env 就从零故障变成 41% 故障**
来源：当前 `app.log`（起始 04:11:49）按时间戳过滤
| 窗口 | NPE 行数 | 下游失败行数 |
|---|---|---|
| [04:11:49, 04:29:18)（eed747c 已部署，超时=2000） | **0** | **0** |
| [04:29:25, 之后)（eed747c 仍在线，超时=1） | 510 | **259** |
→ 代码没变、流量没变，**唯一变量是 env**。

**5. 500 的产生机制未变（仍是 F2 那一行）**
来源：当前首个 NPE 栈
```
java.lang.NullPointerException: Cannot invoke "java.util.Map.get(Object)" because "profile" is null
	at com.example.target.OrderService.loadOrder(OrderService.java:29)
	at com.example.target.OrderController.get(OrderController.java:21)
```
来源：`cat -n OrderService.java` 第 29 行 = `order.put("ship_to", profile.get("address"));`（与 10-23、02:19 两轮同一行）

**6. 失败面已从"1 个用户"扩大到"所有用户"**
来源：当前日志统计 → `profile lookup failed` 259 条，userId 分布 **1:68 / 3:66 / 4:65 / 5:60**，cause 分布 **259×ResourceAccessException**；`userId=9999` 出现 **0** 次（`LOAD_PATHS` 已去掉 order 2）。
→ 前两轮的触发源（9999 缺 profile → 404）**已不存在**，本次 100% 来自超时。

**7. 指标形态：台阶，且失败率因竞态而抖动**
来源：`metrics range`（5xx 比例，15s 步长）
```
04:29:45  0.1536      ← 此前无样本（无 5xx 序列 ⇒ 0%）
04:30:00  0.2906
04:30:15  0.4339   ← 台阶完成
04:30:30~04:32:30  0.340 ~ 0.430 平台
```
来源：最终快照 `metrics query` → 当前 **0.0759**（7.6%）。1ms 预算是竞态，失败比例在 **7.6%–43%** 间大幅波动。
来源：总流量 `sum(rate(...))` = **2.87/s** 恒定 → 非流量问题，是"部分失败"。

**8. 下游服务本身健康，失败的是"调用方等不起"**
来源：`metrics query 'sum by (uri,status)(rate(...))'`
```
/api/orders/{id}   200  0.3985      /profiles/{userId}  200  1.2545   ← 下游端点全部 200
/api/orders/{id}   500  0.8545      /actuator/*        200  0.4000
```
来源：`actuator metrics/hikaricp.connections.usage` → COUNT=586、**MAX=0.002s**（DB 毫秒级）
来源：`actuator metrics/http.client.requests` → status=200 COUNT=25、**MAX=39.2ms**；**status=404 / 500 无序列**（客户端要么拿到 200，要么抛 I/O 异常，没有拿到过错误响应）

---

## 【反对证据 / 尚未解释】

- **`.env` 的改动是否人为故意，无法判定**。git 无该文件（未跟踪），无审计日志。`incident/tools/load-hammer.mjs`（新增未跟踪）与 `docker-compose.yml` 未提交改动（新增 Hikari 连接超时旋钮）表明实验台正在做**多故障并发注入**的准备，但"是谁在 04:29:09 写了 timeout=1"无证据。
- **1ms 为何不是 100% 失败**：SO_TIMEOUT 是单次 socket 读超时，而环回 RTT 本身约 1–4ms（`http.server.requests` TOTAL_TIME/COUNT = 3.197s/743 ≈ 4.3ms），所以是否超过 1ms 是竞态。**已观测到的 25 次成功调用 MAX=39.2ms 与 1ms 读超时并不矛盾**（超时作用于读，不作用于端到端），但我未单独验证客户端实现细节。
- **04:03–04:11 期间有 10 余次连续重启**（今日共 21 次重启），属试错式部署，本次未逐次追查其行为。

---

## 【已排除的假设及排除依据】

1. **「下游 user-profile 服务宕机 / 拒连」——排除。** `/profiles/{userId}` 端点 **1.2545/s 全部 200**；日志无 `Connection refused` / `ConnectException` / `UnknownHost`；`actuator health` = `{"status":"UP"}`（db/diskSpace/ping 全 UP，无 DOWN 依赖）。失败是**超时**，不是**不可达**。
2. **「DB 连接池耗尽（F5）」——排除。** `docker inspect` → `DB_POOL_SIZE=10`、`SPRING_DATASOURCE_HIKARI_CONNECTION_TIMEOUT=30000`；`hikaricp.connections.max=10`、**active=1**、**pending=0**、**timeout count=0**。池根本没被用满。
3. **「线程/内存耗尽」——排除。** `actuator threaddump` → http-nio-8080 仅 12 线程（3 RUNNABLE / 9 WAITING），无堆积；`jvm.memory.used` = 114MB。
4. **「流量冲击 / 并发压测」——排除。** 总速率恒定 2.87/s；`ps` 未发现 `load-hammer` 进程在运行；阶梯负载说明是**每个订单请求自带一次下游调用**，与并发无关。
5. **「最近一次提交 `eed747c`（04:08:48）就是原因」——只对了一半，必须拆开看。**
   - 对：它让 F2 重新上线，是 500 的**必要条件**（栈顶仍是 OrderService.java:29）。
   - 不对：它 04:11:49 就已部署，而该进程**连续 17.5 分钟零 500、零下游失败**；故障起点 04:29:25.622 在**另一次容器重建（04:29:15.46）之后 10 秒**，而 `git log` 显示 04:08:48 之后**无任何提交** → **窗口内无代码变更**，变化在配置层。
6. **「user 9999 缺 profile 导致 404 → NPE」——排除为本次原因。** 当前日志 `userId=9999` 出现 **0** 次，`LOAD_PATHS` 已移除 order 2，`status=404` 速率 = **0/s**。该路径是前两轮的触发源，本轮已不成立。
7. **「误报 / 阈值过敏」——排除。** 日志有实体 500 栈（NPE）；`metrics targets` → `health=up, lastScrape=2026-10-26T04:32:09Z`，无抓取缺口。

---

## 【跳过的步骤及原因】

**无步骤跳过，8 步全部执行。** 三点需要说明：

- **git-diff-analysis 的结论是"窗口内无代码变更"**（04:08:48 之后无新提交）——按 skill 要求，这本身就是**排除发布假设的证据**，必须写出来，而不是"没查到"。据此把方向从代码转向**配置/运行时**，并用 `docker inspect` 读取运行中容器的实际 env 而非只看 compose 文件。
- **historical-incident-lookup**：执行。`workspace_memory_search` 命中 **2 条**（服务严格过滤）：10-23 的 lesson（"判空被删 → 下游 404 → NPE"）与 open_loop。**对本次的意义**：它提示这是**已知模式复发**，于是我去当前日志找同类证据（同一行号 29 的同一 NPE）——完全命中，从而确认"旧缺陷仍在树上是必要条件"，但**跃升幅度**必须另找原因，才引出 `.env` 这条线。
- **一处工具限制的绕行（非跳步）**：`incident-readonly` 的 logs 通道只匹配 `*.log` 后缀，**读不到轮转出的 `app.log.2026-10-26.{1,2,3}.gz`**（且 `.0.gz` 实际是明文）。今日 21 次重启的时间线与"04:11:49–04:29:18 零 500"这条 A/B 证据只能直接读文件补齐——纯读、无写入。

---

## 【处置建议（仅草案，未执行 —— 诊断阶段无写权限）】

**必须两处同时修，只修一处只能缓解一半。**

1. **立即恢复超时（止血，最快见效）**
   ```
   # incident/.env: DOWNSTREAM_TIMEOUT_MS=1  →  改回 2000（或删除该行走 compose 默认 2000）
   ```
   然后重建容器。单独这一步即可把 5xx 从 41% 压回 ~8.75%（只剩 F2 + user 9999 一条路径）。**注意 `.env` 未被 git 跟踪，`git diff` 看不到它，配置管理上是盲区。**

2. **彻底修 F2**
   ```bash
   git revert --no-edit eed747cddae32ca8591e3fa46b2c9ae1146f2b78
   # 或恢复 OrderService.loadOrder 中 profile==null → ship_to="UNKNOWN" 的兜底分支
   ```
   恢复后：
   ```java
   Map<String, Object> profile = downstream.fetchProfile(userId);
   if (profile == null) {
       order.put("ship_to", "UNKNOWN");
   } else {
       order.put("ship_to", profile.get("address"));
   }
   ```

3. **追查回灌来源（防止第三次复发，优先级不低于 1、2）**
   同一改动 `"feat(order): enrich response with downstream shipping address"` 已被 `17ae5df`、`eed747c` **两次重新 apply**，两次 Revert（`e9b5092`、`7f98480`）都被覆盖。需查明 04:29:09 的 `.env` 改动与 04:08:48 的重新 apply 是谁/什么流程所致。建议：CI 增加 null-safety 检查或对 `OrderService.java:29` 的静态断言；把该 commit 标记为禁止重放。

4. **治本**：`fetchProfile` 返回 `Optional<Map<String,Object>>`；`DownstreamClient` 对 404/超时改用 `log.warn`（当前用 ERROR 污染了错误语义，正是前两轮锚点差点误判的原因）。

5. **监控侧**：`actuator health` 仍只有 db/diskSpace/ping，**没有 downstream 组件** → 下游不可用/超时不会让健康检查变红；建议补 downstream 健康项，并把 `DOWNSTREAM_TIMEOUT_MS` 这类运行时旋钮纳入配置变更审计；对 `/api/orders/{id}` 按 uri 单独设 5xx 告警。

---

**当前状态**：故障仍在持续（告警 firing，5xx 在 7.6%–43% 间波动，最后一次实测 7.59%，`status=500` 0.218/s）。上述处置**全部未执行**，已更新工作区记忆（lesson 记录"两层原因 + .env/docker env 取证法 + activeAt 语义"，open_loop 记录两处必改项与追查回灌的建议），等待人工处理。
