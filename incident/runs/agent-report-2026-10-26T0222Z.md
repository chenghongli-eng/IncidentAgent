

---

# target-service 线上故障根因报告（2026-10-26 02:22Z 复诊）

**服务**：target-service ｜ **严重级**：critical ｜ **告警起始**：2026-10-26T02:20:04.991948342Z

> ⚠️ **告警时间对不上，先纠正**：工单里写的 `activeAt=2026-10-23T10:07:04Z` 是**上一轮的旧值**。实时 `metrics alerts` 返回的当前 firing 实例 `activeAt` 是 **2026-10-26T02:20:04.991948342Z**，`value=8.2278e-02`。本次诊断按**实时载荷**锚定，不沿用工单里的旧时间。
> 降级声明（同上轮）：告警 labels 仍只有 `alertname`/`severity`，**无 `service`/`job` label**，服务名取自 annotation summary 与 `metrics targets` 的 job=target-service。

---

## 三个锚点

| 锚点 | 时间 (UTC) | 来源 |
|---|---|---|
| ① 告警起始时间 | **2026-10-26T02:20:04.991948342Z** | `metrics alerts` → `activeAt`（**非**工单所写的 10-23T10:07:04Z） |
| ② 异常首次出现时间 | **2026-10-26T02:19:29.070Z** | `logs first 'NullPointerException' --since 2026-10-26T00:00:00Z` |
| ③ 最近一次部署时间 | **2026-10-26T02:19:22.587Z**（容器启动）→ Started 02:19:27.621Z，携带 commit `17ae5df`（提交于 02:19:12Z） | `logs grep 'Starting TargetServiceApplication'` / `git log` |

**Δ(②−③) = +6.48 秒** → `T_dep ≤ T_err ≤ T_dep+15min` → **高度相关**。

---

## 【根因假设】

**置信度：0.96**

**机制**：commit `17ae5df` 重新引入了 10-23 已被 `e9b5092` 回滚掉的同一处改动——删除 `OrderService.loadOrder` 的 `profile` 判空兜底。`DownstreamClient.fetchProfile` 在下游 404 时按契约返回 `null`，`OrderService.java:29` 抛 NPE，`/api/orders/{id}` 返回 500。

**这不是新 bug，是"修复被回滚"**：三小时前刚做完的正确修复曾**完整生效 101 秒**，随后被同一改动重新 apply 覆盖。

```mermaid
timeline
    title 2026-10-26 故障时间线 (UTC)
    section 缺陷态
    01:31:12 容器启动(带 0d6d0d4) : 692 次 NPE : order2 成功 0
    section 修复态
    02:17:24 e9b5092 Revert 提交 : 02:17:39.660 Started
    02:17:39-02:19:20  NPE 0 次 · order2 成功 25 次
    section 复发
    02:19:12 17ae5df 重新引入 : 02:19:22.587 容器启动
    02:19:29.070 首个 NPE : 02:20:04.99 告警重新 firing
```

---

## 【支持证据】

**1. 栈顶行 = 改动行（代码级硬证据）**
来源：`logs grep` 首个 NPE 块（当前 app.log，02:19:29.070）
```
java.lang.NullPointerException: Cannot invoke "java.util.Map.get(Object)" because "profile" is null
	at com.example.target.OrderService.loadOrder(OrderService.java:29)
	at com.example.target.OrderController.get(OrderController.java:21)
```
来源：`cat -n target-service/.../OrderService.java` → 第 29 行 = `order.put("ship_to", profile.get("address"));`（与 10-23 完全相同）

**2. 引入本次故障的 commit 与三天前那次字节级相同**
来源：`git diff 17ae5df`（标题同为 `feat(order): enrich response with downstream shipping address`，commit body 同为 `Fault-F2: unchecked downstream call raises NPE`）
```
-        if (profile == null) {
-            order.put("ship_to", "UNKNOWN");
-        } else {
-            order.put("ship_to", profile.get("address"));
-        }
+        order.put("ship_to", profile.get("address"));
```
来源：两者的 diff 指纹对比
```
0d6d0d4    index 5edc8b6..34e92a3 100644
17ae5df    index 5edc8b6..34e92a3 100644
diff <(git diff 0d6d0d4) <(git diff 17ae5df)  →  完全一致
```

**3. 决定性反事实：修复窗口内故障完全消失**（本次最有价值的证据）
来源：`logs/app.log.2026-10-26.0.gz`（轮转日志，按日期行精确过滤）
| 部署窗口 | NPE 次数 | order 2 成功次数 |
|---|---|---|
| [01:31:12, 02:17:35)（带缺陷代码） | **692** | **0** |
| [02:17:39, 02:19:20)（e9b5092 回滚版） | **0** | **25** |
| [02:19:27, 现在)（17ae5df 缺陷版） | 持续发生 | **0** |

回滚窗口内 `order 2 loaded` 明细从 02:17:40.935 到 02:19:17.812 共 25 次全部成功 → **同一请求、同一数据、同一流量，缺陷代码 100% 失败，修复代码 100% 成功**。

**4. 部署与告警时间完全自洽**
来源：`git log --since 2026-10-26T02:00:00Z`
```
17ae5df  2026-10-26T02:19:12Z  feat(order): enrich response with downstream shipping address
e9b5092  2026-10-26T02:17:24Z  Revert "feat(order): enrich response with downstream shipping address"
```
来源：容器启动/停机行（轮转日志）
```
02:17:35.126 Starting → 02:17:39.660 Started      ← 回滚版上线
02:19:20.281 HikariPool shutdown (SpringApplicationShutdownHook)  ← 停机
02:19:22.587 Starting → 02:19:27.621 Started      ← 缺陷版上线
```
来源：`metrics range`（5xx 比例，15s 步长，阈值 0.05 穿越点）
```
02:17:45  0.0821  ABOVE
02:18:00  0.0543  ABOVE
02:18:15  0.0265  below   ← 回滚生效，跌破阈值
02:19:45  0.0348  below
02:20:00  0.0544  ABOVE   ← 重新越过 5%
```
→ 告警在 02:18:15 跌破 5% 后 resolve，02:20:00 重新越线 + `for: 30s` → **02:20:04.99 重新 firing**，与实时 activeAt 精确吻合。

**5. 指标形态：台阶，流量恒定**
来源：`metrics range`（总请求速率）→ **2.8727 req/s** 恒定，无流量塌陷 → 部分失败，非全挂。
来源：`metrics query 'topk(5, sum by (uri)(rate(...5xx...)))'` → 唯一 5xx URI = **`/api/orders/{id}`**（0.2545/s）。
来源：`metrics query 'sum by (status)(rate(...))'` → 500=0.2545、404=0.2545、200=2.3636；总比 = 0.2545/2.8727 = **8.86%**（与告警 value 8.228% 同量级、随时段波动）。

**6. 404↔500 严格 1:1（当前进程）**
来源：`actuator metrics/http.client.requests?tag=status:*`（自 02:19:27 重启计数）
```
200: 480 次    404: 60 次    500: 60 次     MAX = 11.87ms
```
来源：当前 `logs grep 'profile lookup failed'` → 56 条全部 `userId=9999 cause=HttpClientErrorException$NotFound: 404`。

**7. 触发条件未变（长期存在的数据事实）**
来源：`target-service/src/main/resources/data.sql`
```
-- Seed data. Order 2 deliberately references user 9999, which has no profile row.
insert into orders (id, user_id, ...) values (2, 9999, ...);
```
来源：`DownstreamClient.java` 第 34/37 行仍 `return null` → 契约未变。

---

## 【反对证据 / 尚未解释】

- **`17ae5df` 为何被产生，无证据**。它与 `0d6d0d4` 字节级相同、commit body 同样写着 `Fault-F2: unchecked downstream call raises NPE`——看起来像**误 apply / cherry-pick / 自动化回灌**，但 git 历史里没有操作者意图记录，**无法证实**。这是本报告最大的未解释项，也正是"第三次复发"的风险点。
- **`e9b5092` 与 `17ae5df` 的时间顺序反常**：回滚提交在 02:17:24，而重新引入的提交在 02:19:12——即"回滚 → 部署验证 101 秒 → 又提交回缺陷"，中间 108 秒内发生了什么，无审计日志可查。
- 指标空洞（02:18:30–02:19:30 无样本）我解释为"5xx 序列不存在导致整个表达式无值"，与日志零 500 互相印证；但**未单独验证** Prometheus 表达式在分子序列缺失时的返回行为。

---

## 【已排除的假设及排除依据】

1. **「下游 user-profile 服务宕机 / 不可达」——排除。**
   `logs grep` 对 `Connection refused` / `ConnectException` / `timed out` / `UnknownHost`：当前会话与今日轮转会话**均为 0 匹配**。
   `actuator metrics/http.client.requests` → MAX=**11.87ms**；下游返回的是结构化业务 404，非超时/拒连。
   `actuator health` → `{"status":"UP"}`，db/diskSpace/ping 全 UP。

2. **「资源耗尽类（连接池/内存/线程）」——排除。**
   `actuator metrics/hikaricp.connections.*` → max=**10**、active=**0**、pending=**0**、timeout count=**0**。且形态是台阶而非单调增长。

3. **「新 bug / 新的数据损坏」——排除。**
   同一份 data.sql、同一份 DownstreamClient、同一流量下，**回滚版本 25/25 成功**、缺陷版本 0 成功。变量只有代码。

4. **「回滚 `e9b5092` 才是原因」——排除。**
   `e9b5092` 上线后 101 秒内 NPE=0、order 2 全部 200；故障起点 02:19:29.070 在 `17ae5df` 上线（02:19:22.587）**之后 6.48 秒**，且 `T_err > T_dep(e9b5092) + 15min` 远不成立。

5. **「三小时前的 `0d6d0d4`（10-23）才是本次原因」——排除（时间与内容双重）。**
   10-23T10:04:13Z 距今 64 小时，远超 15min 窗口；其部署（10-23 10:06:29）在 10-26 之前 2 天以上。本次直接致因是 `17ae5df`。

6. **「误报 / 阈值过敏」——排除。** 日志有实体 500 栈；`metrics targets` → `health=up, lastScrape=2026-10-26T02:22:21Z`，无抓取缺口。

7. **「流量冲击」——排除。** 总速率恒定 2.87 req/s。

---

## 【跳过的步骤及原因】

**无步骤跳过，8 步全部执行。** 两点需要说明：

- **historical-incident-lookup（第 7 步）**：执行。`workspace_memory_search` 用长检索式（"target-service 5xx NullPointerException 下游 未判空 OrderService"）返回 **0 命中**，改用短式 `"target-service"` 命中 **2 条**（同一服务，严格过滤，未跨服务引用）。
  **最相关一条**：2026-10-23 的 lesson——"判空被删 → 下游 404 → NPE"，并明确记载"时间对齐必须用容器启动行而非 git commit 时间"。**对本次的意义**：它提示这是**已知模式复发**，于是我去当前日志里找同类证据（`Cannot invoke "java.util.Map.get(Object)" because "profile" is null` + 同一行号 29），完全命中——**结论是复发而非新故障**。
- **一处工具限制的绕行（非跳步）**：`incident-readonly` 的 logs 通道只匹配 `*.log` 后缀，**读不到轮转出的 `app.log.2026-10-26.0.gz`**（且该文件实际是明文而非 gzip）。跨重启时间线（回滚窗口的零 NPE 证据）只能直接读文件补齐——这是我唯一超出 CLI 的读取动作，纯读、无写入。

---

## 【处置建议（仅草案，未执行 —— 诊断阶段无写权限）】

1. **立刻回滚本次提交**
   ```bash
   git revert --no-edit 17ae5dfc520348ccf59ea260d300c3383978db87
   # 或直接把 OrderService.java 恢复到 e9b5092 的版本；随后重建镜像并滚动重启
   ```
   恢复后的形态：
   ```java
   Map<String, Object> profile = downstream.fetchProfile(userId);
   if (profile == null) {
       order.put("ship_to", "UNKNOWN");
   } else {
       order.put("ship_to", profile.get("address"));
   }
   ```

2. **优先追查 `17ae5df` 的来源**（比回滚更重要，否则第三次复发）
   - 查是谁/什么流程在 02:19:12 重新 apply 了这段 diff（误用 `git revert` 的 revert-of-revert、cherry-pick、CI 回灌脚本、IDE 误操作）。
   - 加防护：CI 增加 null-safety 检查或对 `OrderService.java:29` 的静态断言；把 `feat(order): enrich response with downstream shipping address` 标记为**禁止重放**。

3. **治本**：`DownstreamClient.fetchProfile` 返回 `Optional<Map<String,Object>>`，让"profile 可能不存在"成为类型系统里的显式分支；同时把 `log.error` 改为 `log.warn`——下游 404 是业务态，用 ERROR 会持续污染语义（这正是 10-23 那次差点导致锚点误判的原因）。

4. **数据侧（需业务确认）**：`data.sql` 注释表明 order 2 → user 9999 是**刻意留的缺 profile 用例**。要么补 profiles 行，要么保留用例但确保代码容忍它。**不要**直接删这条种子数据。

5. **监控侧**：`actuator health` 仍只有 db/diskSpace/ping，**没有 downstream 组件** → 下游不可用时健康检查不会变红；建议补 downstream 健康项；并对 `/api/orders/{id}` 按 uri 单独设 5xx 告警（本次全部 5xx 集中在单一端点，全局比率告警无法指认端点）。

---

**当前状态**：缺陷代码仍在运行（NPE 自 02:19:29.070 持续），告警 firing，上述处置**全部未执行**。已更新工作区记忆（lesson 记复发模式与"修复被回灌"判别点，open_loop 记 e9b5092 是现成可用修复且曾生效 101 秒），等待人工处理。
