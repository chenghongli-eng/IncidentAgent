---
name: log-triage
description: 在服务日志中检索错误模式并定位异常首次出现的时间点。当已圈定时间窗、需要把"指标异常"对到"具体哪行代码"时使用。
---

# log-triage

这一步产出整条诊断链里**最有价值的一个锚点**：异常**首次出现的时间**。
所有后续的时间对齐（部署时间、变更时间）都以它为基准。

## 关键查询

```bash
LAB='node "$INCIDENT_LAB"'

# 先看错误长什么样（不限时间，找模式）
$LAB logs grep 'ERROR' --limit 30

# 锁定首次出现时刻 —— 这是本步骤的交付物
$LAB logs first 'NullPointerException' --since 2026-10-20T14:00:00

# 按告警时间窗捞全部错误
$LAB logs grep 'ERROR' --since 2026-10-20T14:15:00 --limit 50

# 证明"某个时间窗内没有这个异常"——负证据也要能量化
$LAB logs grep 'NullPointerException' --since <WINDOW_START> --until <WINDOW_END> --count

# 反过来证明"这个时间窗之后才开始出现"
$LAB logs grep 'NullPointerException' --since <WINDOW_END> --count
```

`logs` 通道同时覆盖当前日志与轮转归档（`app.log.*`，gzip 与未压缩都读）。
`--count` 只统计**带时间戳**的行：堆栈续行（`\tat ...`）没有时间戳、不计入，
所以一次异常事件计数为 1，而直接 `grep` 同一模式会得到 2（事件头 + 堆栈首行）。
要报"多少次异常"就用 `--count`，不要用 grep 的行数。

## 判断启发

- **首次出现时间比告警时间早**：故障先发生，告警后到（延迟告警）。以首次出现时间为对齐基准。
- **首次出现时间晚于部署时间几分钟**：部署相关性强。若部署在首次出现**之前**，这是强信号。
- **首次出现时间横跨部署窗口**：不能判定相关。必须继续看 `git-diff-analysis` 才能下结论。
- **同类异常遍布所有请求**：更像系统性故障（依赖、资源）；**只集中在少数请求**：更像数据相关或代码路径分支（NPE、参数校验）。

## 输出

```text
首次出现：2026-10-20T14:20:07  异常类型：NullPointerException
栈顶：com.example.target.OrderService.loadOrder(OrderService.java:44)
分布：集中在 /api/orders/{id}，非全部请求
```

## 不要做的事

- **不要只贴日志尾巴**。首次出现时刻和栈顶方法名比一屏堆栈有用得多。
- 不要在日志里出现凭据时原样转述。