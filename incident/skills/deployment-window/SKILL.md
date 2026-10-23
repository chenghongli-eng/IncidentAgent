---
name: deployment-window
description: 确定最近的部署、重启或配置变更时间，判断它与异常首次出现是否落在同一窗口。当日志已给出异常起点、需要判断"是不是变更引起的"时使用。
---

# deployment-window

这一���的目的只有一个：**把"时间相关"变成一个可判定的结论**，并给出它成立或不成立的依据。

## 判定规则

设 `T_err` = 日志首次异常时间（来自 `log-triage`），`T_dep` = 最近一次部署/重启时间。

| 条件 | 结论 | 置信度 |
| --- | --- | --- |
| `T_dep ≤ T_err ≤ T_dep + 15min` | 高度相关，继续 `git-diff-analysis` | 高 |
| `T_err > T_dep + 15min` | 相关性弱，**不要**继续查这次部署 | 低 |
| `T_err < T_dep` | 故障先于部署，**排除**该部署 | 排除 |
| 本次故障期间无部署 | 无变更可归因 | — |

## 怎么查部署时间

部署在实验环境里由容器重建产生，因此：

```bash
LAB='node "$INCIDENT_LAB"'

# 配置类变更：直接读生效配置与启动时间
$LAB actuator env | head -40
$LAB actuator health

# 代码变更：看部署窗口内的提交
$LAB git log --since 2026-10-20T13:00:00 --limit 10
```

容器重建时间可从 `docker inspect target-service` 的 `StartedAt` 获得；
`deployment-window` 只负责给出这个时间，判断留给 `git-diff-analysis`。

## 输出

```text
最近部署：<时间与 commit> ｜ 与异常首次出现相差 <N> 分钟 ｜ 结论：高度相关 / 相关性弱 / 已排除
```

## 不要做的事

- **这是本项目最容易被跳过的步骤。** 见 `root-cause-report` 的跳步规则：跳过必须写明理由，
  "没找到部署记录"不是理由，"最近一次部署比异常早 40 分钟，因此与本次故障无关"才是。
- 不要因为"这个服务最近发过版"就默认相关。**默认结论是无关**，需要证据推翻它。