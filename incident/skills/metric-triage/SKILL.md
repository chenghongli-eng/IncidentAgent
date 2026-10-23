---
name: metric-triage
description: 查询告警指标及周边指标，判断异常形态（尖刺、台阶、缓慢增长）并圈定影响面。当已知服务与时间窗、需要判断故障"长什么样"时使用。
---

# metric-triage

告警只告诉你"超阈值了"。这一步回答的是：**异常是什么形状**——形状直接指向故障类型。

## 关键查询

```bash
# 错误率随时间
LAB='node "$INCIDENT_LAB"'
$LAB metrics range \
  'sum(rate(http_server_requests_seconds_count{application="target-service",status=~"5.."}[1m])) / clamp_min(sum(rate(http_server_requests_seconds_count{application="target-service"}[1m])),0.001)' \
  <START> <END> 30s

# 流量是否同时掉了（区分"部分失败"和"全挂"）
$LAB metrics range \
  'sum(rate(http_server_requests_seconds_count{application="target-service"}[1m]))' \
  <START> <END> 30s

# 哪些接口在报错
$LAB metrics query \
  'topk(5, sum by (uri) (rate(http_server_requests_seconds_count{application="target-service",status=~"5.."}[1m])))'
```

## 形态判读

| 形态 | 指向 | 下一步应该走 |
| --- | --- | --- |
| **尖刺**（秒级起落，基线正常） | 突发变更：发布、配置翻转、外部依赖瞬断 | 走 `deployment-window` |
| **台阶**（跳变后维持在新值） | 配置或发布后的稳态差异 | 走 `deployment-window` |
| **缓慢增长**（单调上升无跳变） | 资源耗尽：连接池、内存、线程 | 走 `spring-diagnostics`，**不要**先查发布 |
| **无明显形态**（指标本身抖动） | 可能是误报或阈值过敏 | 明确说"证据不足"，不要硬找根因 |

## 输出

- 异常形态一句话结论 + 支撑它的那条查询和数值。
- 受影响的接口列表（`by (uri)` 分组结果），这是后面定位故障模块的第一个线索。

## 不要做的事

- 不要用单点 instant query 判断趋势，必须用 `range`。
- 不要因为"刚刚发过版"就认定发布是原因。形态和发布时间的相关性由 `deployment-window` 判断，不由这里判断。