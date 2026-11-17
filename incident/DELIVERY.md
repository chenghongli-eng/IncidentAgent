# 交付说明：把故障分析 Agent 接进你们的系统

这份文档写给**接到这套东西的团队**：你们要把它用在自己的系统上。
它说清楚四件事——你们拿到的是什么、你们的系统要提供什么、怎么验收、
哪些坑我们已经踩过了。

> 本文只讲**怎么接**。方法论（为什么是这三层、锚点怎么取、为什么要分层归因）
> 见 [REAL-TARGET.md](REAL-TARGET.md)；通道契约的字段表见
> [targets/README.md](targets/README.md)；本文只给路径与验收。

---

## 一、你拿到的是什么

| 件 | 在哪 | 是不是产品 |
| --- | ---- | ---------- |
| **Agent 本体**：四段 Prompt + 8 个 Skill | `agent-profile/identity.json`、`skills/` | 是 |
| **观测 CLI**：Agent 唯一的证据通道 | `tools/incident-readonly.mjs` | 是 |
| **通道契约**：描述符字段与规则 | `targets/README.md`、`targets/descriptor.mjs` | 是 |
| **验收命令**：一条命令回答「接入合格了吗」 | `runs/check-target.mjs` | 是 |
| 样例台子（合成靶子 + 监控 + 故障注入） | `target-service/`、`docker-compose.yml`、`faults/` | 否，夹具 |
| 评测方法学（判据 / 闸门 / 独立性审计） | `runs/` | 否，量具 |

**本体与量具可以整套拿走**；样例台子留着当 demo 和回归基线。
评测方法学是可选的——回答「怎么验证接进来的 Agent 在我们系统上没作弊、
样本干不干净」，详见 `runs/README` 段的说明。

## 二、你们的系统要提供什么

Agent 不直接碰你们的系统，它只通过一个只读 CLI 观测。**你们要提供的是
四个通道 + 一个描述符。**

| 通道 | CLI 命令 | 你们要提供的东西 | 拿不到时 |
| ---- | -------- | ---------------- | -------- |
| 指标 | `metrics query/range/alerts/targets` | 一个 Prometheus 基址；你们的指标带一个可识别的标签（如 `application="<服务名>"`） | 「没有指标」——写进报告的证据缺口，**不要**伪造 |
| 应用体检 | `actuator <endpoint>` | Spring Boot actuator 基址（`/actuator/health`、`/actuator/prometheus` 等）；要鉴权就设 `ACTUATOR_TOKEN` 或 `ACTUATOR_USERNAME`/`ACTUATOR_PASSWORD` | 同上 |
| 日志 | `logs grep/first` | 一个日志目录；文件按 `logFiles` 指名（多级别文件会重复计数） | 同上 |
| 代码 | `git log/diff/show/file` | 目标服务的 git 仓库路径 | 同上 |
| 部署 | `deploy current/lookup/running/list/check` | 一份 **append-only JSONL 台账**，主键是**镜像 digest**（格式见 [DEPLOY-LEDGER.md](DEPLOY-LEDGER.md)） | 同上 |

**描述符**是一个 JSON，告诉 CLI 上面的路径和地址各是多少。字段表在
[targets/README.md](targets/README.md)，要点：

- 必填：`id`、`application`、`prometheusUrl`、`actuatorBaseUrl`、`logsDir`、`repoPath`
- 找不到描述符时**不会静默回退**到内置夹具——会直接报错。回退的话，这一轮会拿
  合成夹具的证据去回答你们系统的问题，**错得毫无痕迹**。
- 凭据**只从环境变量读**，不进描述符（描述符是可以被复制的，凭据不该跟着走）。
- 真实系统的描述符含内部路径，**放在仓库外**（`INCIDENT_TARGET_FILE` 或
  `INCIDENT_TARGET` + `INCIDENT_TARGET_DIR`）。

### 「通道不可得」是一个合法的结论

如果某个通道在你们那边确实拿不到（历史回放、指标没留存、没采台账），
**照实说「证据不可得，还缺什么证据」**。本体里写死了这一条：
读不到时正确的结论是证据不足，不是换一条路绕过去。
绕过去就放弃了可复核的取证路径，结论也没法被挑战。

## 三、怎么验收

```bash
node incident/runs/check-target.mjs /path/to/your-target.json
```

它跑七条闸门，逐条给结论，全过退出 0、有没过退出 1：

| 闸门 | 问什么 |
| ---- | ------ |
| **D0** | 本体里那行观测 CLI 的绝对路径，在这台机器上存在吗？（换环境最容易漏的就是它） |
| **D1** | profile id 与同步脚本一致吗？（防漂移） |
| **D2** | 改了 `identity.json` 有没有同步入库？（`sync-agent-profile.mjs`） |
| **P1** | 四个通道在不在？（Prometheus / actuator / 日志目录 / 部署台账） |
| **P2** | 日志是**靶子进程自己**在写的吗？（不是「目录里有文件」，是「那个进程持有写句柄」） |
| **P3** | 靶子在自己的指标里现身了吗？（活性信号用「指标在」，不用「日志在长」——真实服务空闲时日志不长） |
| **P4** | 基线 5xx 比例是 0 吗？ |
| **P5** | 开跑前没有告警在 firing 吗？**且该 Prometheus 必须有规则**——零规则的 Prometheus，「没告警」是空话，这条闸门等于没跑 |

判定层自带负对照：`node incident/runs/check-target-control.mjs`
（证明它认得出坏，也认不得好）。

**跑之前**要先把靶子摆到基线态（活着、日志在写、指标在抓），
否则 P1/P2 问不出任何东西。

## 四、跑一轮之后你拿到什么

一份**结构固定**的报告（字段缺一不可，见 `skills/root-cause-report/SKILL.md`）：

```text
服务 / 严重级 / 告警起始
【根因假设】置信度 + 机制
【支持证据】每条带来源命令与时间戳
【反对证据 / 尚未解释】
【已排除的假设及排除依据】
【跳过的步骤及原因】
【处置建议（仅草案，不执行）】
```

归因是**分层**的：触发层 / 必要前提层 / 放大层 / 背景层。
「栈顶代码」不等于根因——根因要回答「**是什么变化让系统从不出错变成出错**」。

## 五、我们已经踩过的坑（省你们的时间）

1. **搬环境时漏改本体里的 CLI 绝对路径。** 症状很安静：报告照样出，只是没有一条证据。
   → D0 闸门专治这条。
2. **改了 `identity.json` 没跑 `sync-agent-profile.mjs`。** Agent 运行时读的是库里的行，不是这个 JSON。
   → D2 闸门专治这条。
3. **描述符解析规则和 CLI 各写一份，早晚漂移。** 漂移不报错，只让报告看起来很有道理。
   → 仓库里两侧对拍（`runs/target-preflight-control.mjs`），两边不一致就红。
4. **日志按级别分文件时 `--count` 会数两遍。** → 用 `logFiles` 指名。
5. **PromQL 里的指标标签字面量是合成夹具的。** 换靶子要靠 `metricLabelAliases` 改写，
   别手改 Skill 里的 PromQL 例子。
6. **`metrics range` 的 END 不能晚于当前时刻。** 跑到未来的窗口，Prometheus 不是返回
   「无数据」，而是用**截断的窗口**去算，比值退化成 1/10、1/12 这类小整数比——那是伪影。
   CLI 会直接拒绝，别绕过。
7. **台账的主键是镜像 digest。** 查不到条目是 **ERROR**，不是空结果：
   「台账里没有这一条」和「窗口内没有代码变更」是相反的结论，只有后者能排除发布。

## 六、已知边界（接之前先知道）

- **host 模式没有沙箱。** Agent 在 host 模式下能直读宿主机任意文件，
  你们环境里的配置文件对它是可达的。台子靠「闸门 W + 通道审计 + 泄漏扫描」
  **事后**发现，而不是事前阻断。**给更广的人用之前，这个必须先解决。**
- **样例靶子是合成的。** 故障形态只有三种，且是我们想象的分布。真实世界的故障
  长什么样我们也没把握——所以合成靶子上测出来的能力**不能外推**。
- **每类只跑过 1–2 轮。** 分数是单点，没有方差，不能用来比较「改 prompt 前后谁更好」。
- **本体只做诊断，不做处置。** 没有写权限。处置建议只出草案，人工执行。

## 七、责任边界

| 我们提供 | 你们提供 |
| -------- | -------- |
| Agent 本体（四段 Prompt + 8 个 Skill） | 你们系统的四个观测通道 |
| 只读观测 CLI | 描述符（放仓库外） |
| 通道契约与字段表 | 部署台账（append-only JSONL，主键 digest） |
| 验收命令 + 负对照 | 台账采集器（Rancher / Nexus / Jenkins 侧的采集脚本在 `collector/`） |
| 评测方法学（可选） | 一次可以安全分析的故障（历史回放最安全） |

## 八、下一步该做什么

推荐顺序（每一步都有验收标准，别跳）：

1. **只读体检**：用你们真实的 P1/P2 服务跑一次 `check-target.mjs`。
   目标：七条闸门全绿。红了先修通道，别改 Agent。
2. **历史故障回放**（最该先做的一步）：把一次已经过去的故障交给 Agent，
   观测面只有那天的日志 + 事发时刻的源码，指标和台账标成「不可得」。
   目标：Agent 能给出分层归因，且把不可得的通道明确写出来。
3. **可逆注入**：在你们代码上做最小改动复现同一类故障。
4. **真实事故复盘**：在真实事故上跑，并接受它的结论会被挑战。

方法论细节在 [REAL-TARGET.md](REAL-TARGET.md)，逐字段的接入清单在
[targets/README.md](targets/README.md)，台账格式在 [DEPLOY-LEDGER.md](DEPLOY-LEDGER.md)。
