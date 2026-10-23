---
name: alert-triage
description: 解析告警载荷，确立本次诊断的服务、严重级与时间窗。当收到一条告警、或需要确认告警到底在说什么时使用。
---

# alert-triage

把一条告警变成后续所有步骤都要引用的三个锚点：**服务名**、**严重级**、**时间窗**。

## 输入

告警文本，或 Alertmanager 的 firing 列表：

```bash
node "$INCIDENT_LAB" metrics alerts
```

## 输出

在报告开头固定写一行锚点，后续每一步都引用它：

```text
服务：target-service ｜ 严重级：critical ｜ 告警起始：2026-10-20T14:20:00+08:00
```

## 判断启发

- 载荷里 `service` 或 `job` label 缺失 → **降级处理**：声明"告警未指明服务，以下按告警中出现的服务名推断"，不要静默假设。
- `starts_at` 缺失 → 以 `metrics range` 能查到的最早异常点回填，并说明这是回填值。
- 同一服务同时有 critical 和 warning → **只以最高级为锚点**，warning 作为背景，不另起一条诊断线。

## 不要做的事

- 不要在这里下根因结论。告警只说明"观测到什么"，不说明"为什么"。
- 不要因为告警文案提到某个组件就认定故障在该组件。告警规则写死在 Prometheus 里，与实际故障位置无关。