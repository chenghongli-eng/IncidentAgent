# IncidentAgent — 断点存档（短版）

最后更新：**2026-11-17**（收尾压缩）。完整过程存档在
[RESUME-HISTORY.md](RESUME-HISTORY.md)（5172 行，按日期倒序，含全部量具缺陷史、
判据 v1→v10 演进、闸门实测记录）。本文件是**唯一下次会话的入口**。

---

## 一句话状态

**交付物已达成，实验室可合盖。** 简历那条 claim（真实靶子上能定位根因）2026-11-13
就已兑现：10 个独立样本，根因命中 10/10、发布归因 10/10，简历包三处校验全绿。
此后投入的是量具自身的可辩护性（研究品味，不是交付物），2026-11-16 已按决定冻结。
**现在唯一还在开放状态的是一条没评分、没入库的新场景**（见第四节）。

## 一、现在能主张什么（全部有证据面）

| 结论 | 数字 | 证据来源 |
| ---- | ---- | -------- |
| 真实靶子上能定位根因 | 10 个独立样本，根因 **10/10** | `runs/real-target-rounds.json`（机器可读总表） |
| 能区分「运行时环境」与「随发布进制品」两类触发源 | 发布归因 **10/10** | 同上（R1 5 + R2 5 两臂） |
| 通道合规（没越界取证） | 干净 **9/10**（1 处越界是路径打字错误） | 通道审计 |
| 质量判据 | Q1 10/10、**Q2 7/10**、Q3 10/10、Q4 7/10 | 冻结判据 v10 |

**边界（写下来是因为容易被说大）**：这两臂不是完整八类故障评测集，
**不得把这两臂的数字说成整个评测集的准确率**。

## 二、冻结清单（不要再动）

| 冻结对象 | 版本 / 位置 |
| -------- | ----------- |
| 判据 | **v10**，快照在 `runs/rubric-snapshots/v10/`（`score-report.mjs` + `q2-roles.mjs`） |
| 真实靶子真值 | R1-v4 / R2-v7；默认真值已对齐，`runs/verify-default-truth.mjs` 可重跑 |
| 闸门 | `gate-w-*`、`channel-audit`、`independence-audit`、`leak-scan`、`verify-default-truth` |

**停止规则**（写在 11-16 存档里，此处复述以防再滑进去）：

1. 不再改判据，除非发现「判据实现与自己的设计说明不符」这类**真 bug**
   （历史上三次都是这一类：Q2 数错了东西、R2-v5 漏「未」、R1-v2 漏词序与符号）。
2. **指标不好看不构成改判据的理由**。分数低就是能力面，去改产品。
3. 改判据的话，老规矩一条不能省：校准 + 负对照 + 全量重打分 + 真值版本推进 + 简历包同步。

## 三、真实能力缺口（唯一的「改产品能改分」）

**Q2 分层归因 7/10**——10 个独立样本里有 3 轮只做了单层归因，
没有显式区分「触发层 / 必要前提层 / 放大层 / 背景层」。

改法：报告显式标注层级角色（`agent-profile/identity.json` 的 AGENTS 段 + `skills/root-cause-report`）。
**本轮决定不做**（2026-11-17，用户拍板「只做收尾，不动产品」）。
若将来要做：用冻结判据 v10 评估，不许为它改判据。

## 四、开放线程：历史故障回放场景（已构造，**未评分、未入库**）

2026-11-16 起的一条新线，仓库里**零记录**，只在仓库外：

| 东西 | 位置（仓库外） |
| ---- | -------------- |
| 回放工作区 | `/mnt/my-work/incident-lab/workspace-replay/` |
| 答案键 | `~/incident-lab-archive/replay-truth/p1-20260810.json` |
| Agent 报告 | `~/incident-lab-archive/replay-truth/p1-20260810.agent-report.md` |
| 代码快照 | `/mnt/my-work/incident-lab/replay-repo`（事发提交 3d15b9ee） |

场景：P1（governportal-server）2026-08-10 的历史故障回放——
**没有活服务**，指标 / Actuator / 发布台账三个通道**不可得**（是「证据不可得」，不是「没问题」），
只有日志切片 + 事发时刻源码。答案键已按四层角色写好（trigger / necessary_condition /
amplifier / mechanism），与 v10 判据的层级角色组同构。

**现状：跑了一轮，产出了一份报告，但没打分、没进总表、没提交。**
`config/mount-allowlist.json` 里那条 `workspace-replay` 白名单是它的工作区入口
（2026-11-17 随收尾一起入库）。

**本轮决定不做**（用户拍板「只做收尾，不动产品」）。要做的话注意：
这是**新场景族**，与 R1/R2 两臂不是同一分母，评分结果**不得**并进
`real-target-rounds.json` 的 10 个独立样本里，也不得改简历包里的任何数字。

## 五、明确不做的事（附决定日期，别再排期）

| 事项 | 决定 |
| ---- | ---- |
| 夹具侧跨轮隔离（日志轮转 + 指标清零） | **2026-11-16 不做**，除非再跑夹具轮次 |
| R2 真·重编译变体（需离线构建公司源码） | **2026-11-16 不做** |
| 修 Q2 能力缺口 | **2026-11-17 不做** |
| 历史回放场景评分与入库 | **2026-11-17 不做** |
| 继续演进判据 | **2026-11-16 冻结** |

## 六、需要用户授权才能做的（当前无）

- 离线构建公司源码（R2 真·重编译变体）。
- 覆盖仓库外的简历包（`~/Desktop/文档/overleaf/miniclaw_incident相关/`）——
  2026-11-13 已授权覆盖过一次；**本轮未改动任何仓库外文件**。

## 七、关键文件索引

**本体（产品）**：`agent-profile/identity.json`（四段 Prompt）、`skills/`（8 个 Skill）、
`tools/incident-readonly.mjs`（唯一证据通道）。
三条设计不变式见 [README.md](README.md)——观测只走 CLI、工作区之外不是证据源、证据不足就写证据不足。

**夹具**：`target-service/`（合成故障 F2/F4/F5）、`faults/`、`prometheus/`、`alertmanager/`、
`lab.sh`、`lab-paths.json`（路径唯一真相源）。

**量具（冻结）**：`runs/score-report.mjs`、`runs/q2-roles.mjs`、`runs/calibrate-scorer.mjs`、
`runs/channel-audit.mjs`、`runs/independence-audit.mjs`、`runs/run-round.mjs`、
`runs/round-table.mjs`、`runs/verify-default-truth.mjs`、
`runs/real-target-rounds.json`（机器可读总表）。
负对照一律是 `runs/*-control.mjs`——**每个解析类函数都必须有一条**。

**仓库外**：工作区 `/mnt/my-work/incident-lab/`、归档 `~/incident-lab-archive/`
（轮次产物、真值、简历包副本）。

## 八、怎么跑一轮（压缩版）

前置：`lab.sh up -d --build` 起台子、`~/.config/miniclaw-lab/lab.env` 就位、Miniclaw 服务在线。
一轮由 `runs/run-round.mjs` 编排：**前置闸门 → 摆静默态 → 清面 → 注入 → 等告警 → 跑 Agent →
通道审计 → 打分 → 恢复**。单轮墙钟 30–50 分钟，其中绝大部分与 Agent 无关
（静默态坐稳 18 分钟、等告警 ≤5 分钟、容器重建 2–4 分钟），Agent 本身通常 3–5 分钟。

**跑真实靶子轮次必须带 `--truth`**：默认真值路径是
`~/incident-lab-archive/real-ground-truth/<故障ID>.json`，虽然 11-16 已推到已采纳版本，
但显式传参能避免再次静默走偏。

## 九、跑之前先看

1. [README.md](README.md) — 三层定位、改动政策、已知边界与欠债。
2. [REAL-TARGET.md](REAL-TARGET.md) — 接入真实靶子的方案与合规前置。
3. [RESUME-HISTORY.md](RESUME-HISTORY.md) — 需要追溯某次判据修订或闸门实测时的依据。
