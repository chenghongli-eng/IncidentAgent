# IncidentAgent — 断点存档

最后更新：2026-10-30。本文件是**唯一下次会话的入口**，先读它再动手。

## 一句话状态

**【2026-10-30 09:0xZ】F2 阳性轮第一次在新链上跑通（0738Z），判据改到 v3 并全量重打；
实验台已回退到基线 `7bb726a` 并按它重建，处于静默态。**

- **F2 0738Z = 有效轮**：准确率 **1.0（hit）**、发布归因 **relevant·correct**、
  Q1–Q4 全 PASS、通道**零污染**（9 次越界，均未读到答案）、`leak-scan` **0 命中**。
  这是本项目的**第一份 F2 正例合格证据**，也是历史上第一次「干净环境 + 跑完 + 通过」三者同时成立。
- **判据 v2 → v3**：只改了一处——F2-C2 的「未判空」一环从 `判空|兜底|未判空|无判空` 四个词
  扩到「null 守卫」的各种说法。原因是一份**完全正确**的报告从头到尾写的是「null 保护」，
  v2 给了 0.5。扩词表 != 放水：`calibrate-scorer.mjs` 现在 7/7 通过，且有一条负对照
  （把守卫概念整段拿掉、报告里仍满是 null）必须**仍然 FAIL**。全量重打后只有 0738Z 从 0.5 → 1.0。
- **独立复核件**：`incident/runs/audit-2026-10-30T0738Z.md`。查到 5 处数字问题
  （1 处硬错：窗口没关就报数，141 实为 160）和 1 个**实验室侧**的根因
  （报告唯一的「未解释项」是实验室自己改历史造成的假象）。
- **当前实验台**：服务仓库 HEAD = `7bb726a`（判空兜底在位），容器 09:07:08 重建、09:07:16 就绪，
  健康检查 order 1–5 全 200、5xx = 0、无告警、`LOAD_PATHS` 不含 order 2、旋钮 2000。
  ⚠️ 这个状态**不能直接跑 F4**——F4 需要缺陷在线，跑前要先注回 F2（见下文「跑 F4 前要做什么」）。

**【2026-10-30 上午】实验台已从「静默损坏」状态修复并验证可用；服务仓库历史已重建，
`leak-scan` 第一次达到 0 命中。**

- 仓库本轮从 `/persistent/home/fs-user/IdeaProjects/...` 搬到 `/mnt/my-work/...`，
  搬运留下了 **5 处静默损坏**，本轮全部定位并修复（见下节「搬家造成的静默损坏」）。
  其中 **2 处完全不会自己暴露**：容器显示 healthy、日志文件却不再增长；
  Agent 拿到一个空壳工作区，零报错。另 2 处暴露出来的现象与真实原因看起来不像同一个问题。
- 服务仓库历史**已重建**：新链 `a9c8957 / 46ea5d5 / 3ca923c / 072d275`，
  旧链 `83c26bf / d306ad3 / 35854c8 / 8061f59 / 38b3705` 备份在
  `~/incident-lab-archive/service-repo-pre-rebuild.bundle`（旧 SHA 仍可解析，供审计件引用）。
  `leak-scan` 从「阻断 0、历史残留 2」变成 **0 命中**。
- Agent 冒烟测试通过：工作区 cwd、只读通道、重建后的提交链三项都正确，
  Agent 全程只读、未写任何文件。

**【2026-10-30 07:40Z】F2 正例轮已连跑三轮，前两轮中止的都不是 Agent 的问题。**
0446Z 撞上 MiniMax Token Plan 429（额度上限）；0703Z 的 Agent **跑完并产出了
9430 字完整报告**，但 runner 的 15 分钟 cap 早断了 10 秒，报告没进采集口径。
两轮暴露的都是 harness 自己的缺陷，已修：`ws.err`→`ws.stderr`（不再只报 `undefined`）、
中止路径也恢复实验台并停掉服务端静默重试（0703Z 的 `restore.ok=true` 已验证）、
cap 提到 30 分钟、空闲看门狗提到 10 分钟并写明退出原因、manifest 新增 `provider`
字段记录本轮模型。模型额度本人确认已恢复，provider 仍是 MiniMax-M3（与已跑的
F4 轮次可比）。**第三轮已开跑**，详见下节。

## 【2026-10-30】F2 0738Z：第一份合格的正例证据 + 判据 v3

### 1. 这一轮是什么

`node incident/runs/run-round.mjs --fault F2` 跑完了一整轮：

| 项 | 值 |
| --- | --- |
| 轮次 | `2026-10-30T0738Z` |
| 基线（setup 前） | HEAD `7bb726a`，判空兜底在位、order 2 在 `LOAD_PATHS` 里、旋钮 2000 |
| 坐稳 | 旋钮 mtime 07:38:10.211 / 容器 07:38:14.098，等到 07:54 才注入（960 s 基准） |
| 注入 | `852d339`（07:54:14），删掉判空兜底 → 07:54:15.975 重建 → 07:54:21.616 就绪 |
| 首个 NPE | 07:54:22.836（就绪后 1.2 s，Δ(②−③)=+6.9 s） |
| 告警 | `HighServerErrorRate` activeAt 07:54:49.991948342Z（pending），firing ≈ +30 s |
| Agent | 07:55:33 → 08:07:14，9061 字符，47 次工具调用 |
| 通道审计 | **contaminating 0 / out_of_surface 9** |
| 评分（v3） | **1.0 hit**，发布归因 **relevant·correct**，Q1–Q4 PASS |
| 恢复 | 08:07:14 order 2 出压测路径；本轮结束后回退到 `7bb726a` 并按其重建 |

报告：`incident/runs/agent-report-2026-10-30T0738Z.md`
（原件不改）。复核件：`incident/runs/audit-2026-10-30T0738Z.md`。

### 2. 为什么这一轮才算「跑通」

前面 0446Z / 0703Z 两轮的数据都在，但都不算数：0446Z 撞额度上限、
0703Z 的 runner cap 早断了 10 秒。**0738Z 是第一次「manifest 有分数 + 通道审计过了 + 有独立复核」三者齐备**，
而且它跑在**重建后的新链**上（不再有 10-26 那轮的历史泄漏）。

### 3. 判据 v2 → v3：一处，只改一处

**现象**：0738Z 的报告把失效机制写得完全正确
（`data.sql` order 2 → user 9999 无 profile → 下游 404 → `fetchProfile` 返回 null →
`OrderService.java:29` 解引用 → NPE → 500），v2 却只给 **0.5**。

**原因**：F2-C2 的「未判空」那一环只认 `判空|兜底|未判空|无判空` 四个词。
这份报告从头到尾用的是 **「null 保护」**（`判空/兜底` 出现 **0 次**）。这是**判据错，不是 Agent 错**。

**改法**：只把 C2 这一环的词表扩到「null 守卫」这一**概念**的常见说法：

```
判空|兜底|未判空|无判空|null\s*保护|null\s*检查|null\s*校验|null\s*判断|null\s*防护|
空值检查|空值判断|空判断|空指针检查|直接解引用|裸解引用|解引用\s*null
```

F2 / F4 两份真值**对称**改（F4-C2 的同一环）。**没有**扩到「报告里出现过 null」。

**守门的四件事**（缺一不可，都已落地）：

| 门 | 结果 |
| --- | --- |
| `calibrate-scorer.mjs` | **7/7 通过**（原有 5 个人工审计案例 + 0738Z 正例 + 1 条负对照） |
| **负对照** | 把 0738Z 报告里「null 保护」「解引用 null」和那段 diff 整段换成无关措辞，**报告里仍然满是 `返回 null` / `profile is null` / `return null`** → C2 **仍然 FAIL**，C1 仍 PASS，总分 0.5。这证明扩的是概念，不是空白支票 |
| 全量重打 | `rescore-all.mjs` 把 7 轮全部用 v3 重打；旧分数按版本归档成 `score-<stamp>.<旧版本>.json`，**只有 0738Z 变（0.5 → 1.0）** |
| 新旧并列 | `round-table.mjs` 新增「v1 重放 / v2 实测 / v3 实测」三列 + 差异来源列 |

> ⚠️ **改判据的纪律没有松**：看见分数不对就调判据 = 自己给自己判卷。
> 这次能改，是因为「报告写的是 null 保护、判据只认判空兜底」是**可复现的判据缺陷**，
> 且负对照证明了扩表后仍然拦得住「只提过 null」的报告。

### 4. 新旧分数并列（`node incident/runs/round-table.mjs`）

| 轮次 | 故障 | v1 | v2 | v3 | 差异 |
| --- | --- | --- | --- | --- | --- |
| 2026-10-26T0222Z | F2 | 1.0 hit / relevant | 1.0 / relevant | 1.0 / relevant | 无 |
| 2026-10-26T0432Z | F4 | 1.0 hit / excluded | 1.0 / excluded | 1.0 / excluded | 无 |
| 2026-10-27T0727Z | F4 | 1.0 hit / excluded | 1.0 / excluded | 1.0 / excluded | 无 |
| 2026-10-30T0350Z | F4 | 1.0 hit / excluded | 1.0 / excluded | 1.0 / excluded | 无（但**通道污染 → 本轮作废**） |
| 2026-10-30T0423Z | F4 | 0.5 partial / excluded | 1.0 / excluded | 1.0 / excluded | v1→v3 准确率 |
| 2026-10-30T0431Z | F4 | 0.0 miss / excluded | 1.0 / excluded | 1.0 / excluded | v1→v3 准确率 |
| **2026-10-30T0738Z** | **F2** | 0.5 partial / unclear | 0.5 / relevant | **1.0 / relevant** | v1→v3 准确率+归因，v2→v3 准确率 |

> 0738Z 的 v1 发布归因是 `unclear`：v1 的归因匹配没有认出这份报告「触发源 = 容器重建」的写法。
> 三个版本读同一份报告，读出的东西不一样——这正是必须**全量重打 + 并列披露**的原因。

### 5. 复核件查出来的 5 处数字问题（必须在对外表述里一并说）

| # | 问题 | 性质 |
| --- | --- | --- |
| D1 | 「141 次」是 `[07:54:16, 08:05:00]` 的统计，但命令在 **08:03:37** 就跑完了，窗口还开着。窗口关闭后真实计数 = **160 / 160**（404 与 NPE 仍 1:1） | **硬错**：窗口没关就报数 |
| D2 | 「同期流量恒为 2.87–2.91 req/s」——它自己的采样里 07:39 是 **2.0749**；全窗口 112 个点里 22 个落在区间外，min/max = 1.98/2.95 | 过度声称（结论「无流量激增」仍成立） |
| D3 | 实例表**漏了 D 行**（07:35:48–07:38:14，order 2 已出压测路径 → 全零）。「零 NPE」在这条时间线上有两种成因（兜底在 / order 2 没被驱动），报告未区分 | 漏一行 |
| D4 | 实例 B 的那 1 次 NPE（06:50:03.130）其实属于实例 A：B 的容器 06:50:13.089 才启动、兜底首次成功是 06:50:14.773。桶边界取自症状时间戳，早了 10 秒 | 错桶一次 |
| D5 | 「台阶 8.2–8.9%」实测是 8.125–9.259%（另有两个过渡桶 5.75% / 7.87%） | 带宽写窄（形态判断正确） |

### 6. 复核件查出来的**实验室侧**根因（这一条比上面五条都重要）

报告【反对证据】#1 说「实例 A、C 当时 HEAD 是修复提交 `7bb726a`，却仍在报 NPE」，
并把它列为**未解释项**，要求补 CI 构建日志 / 镜像 digest。**这个谜底是实验室自己造的**：

| 实例 | 当时的真实 HEAD | 现在 `git log` 里 |
| --- | --- | --- |
| A 05:07:14 起 | `486fb57`（0446Z 的注入，05:06:53） | **已删除** |
| C 07:19:32 起 | `f24ecb8`（0703Z 的注入，07:19:22） | **已删除** |

两条提交在两轮失败后被删掉并归档进
`~/incident-lab-archive/failed-f2-0446z.bundle`（→ `2fc9d54`）与
`failed-f2-0703z.bundle`（→ `f24ecb8`），所以 0738Z 的 Agent 看到的历史里
那两次「缺陷上线」从来没发生过。它的推断（「跑的不是 HEAD 源码」）在它看到的历史里**必然成立**。

**代价**：报告因此少写了一整个最有价值的模式——**同一个缺陷 blob 被部署 → 修回 → 又被部署回去**。

**纪律**：
- 任何「某个时刻部署了什么」的判断，**先查 `round-manifest-*.json` 的 `injection.at` / `injection.commit`**，
  再决定是不是真的矛盾。`git log` 只能证明「这一轮看到的是什么」。
- **不要**把归档 ref 放回服务仓库：`refs/lab-archive/failed-f2-*` 这个名字本身就泄漏 F2，
  `git log --all` 一看就穿。要保留就只能用中性 ref 名，而那是基准设计决定，不能顺手做。

### 7. 其余两条实验室侧的处置（也在复核件里）

- **L2 越界披露不全**：9 次越界没有一次读到答案（`contaminating 0` 复核同意），
  但报告只声明了 `docker ps`，**没提** `curl :8080/actuator/health`、`curl :9090/api/v1/rules`、
  `find /`、以及读过 `incident/agent-profile/identity.json`（它自己的 prompt 源文件，零信息增量）。
  以后披露要把越界清单列全。
- **L3 `logs` 的时间窗只作用于带时间戳的行**：堆栈是续行、不带时间戳，
  所以 `logs grep 'at com.example.target' --since …` 返回 0，不带 `--since` 才返回栈帧。
  Agent 处理对了（它用不带 `--since` 的查询并在注释里写明了原因），
  **但复核者（我）踩了一次**，一度误判「报告伪造了栈」。这条要写进工具 help。

### 8. 跑 F4 前要做什么

0738Z 收尾时把服务仓库回退到了 `7bb726a`（**判空兜底在位**），这是 F2 的静默态，
不是 F4 的。两者的静默态方向相反：

| | 源码 | order 2 在压测路径 | 旋钮 | 静默态为什么这样 |
| --- | --- | --- | --- | --- |
| F2 静默态（当前） | `7bb726a`，兜底在位 | **在** | 2000 | 缺陷没上线，压着也只会降级成 UNKNOWN |
| F4 静默态（跑 F4 要的） | **兜底被删掉**（旧链 `072d275` 那种） | **不在** | 2000 | 缺陷在线但没人踩它；旋钮一改就发作 |

F4 的注入只改旋钮（2000 → 1），代码一行不动——但如果源码里兜底还在，
超时 1 ms 只会让 `fetchProfile` 抛异常、被 catch 成 null、再被兜底成 UNKNOWN，
**order 2 依然 200，不会告警**，这一轮根本起不来。

所以跑 F4 前按顺序做：

1. **让缺陷重新在线**：在新链上再注入一次 F2（`node incident/faults/faults.mjs inject F2`
   会产生一个新提交），或临时检出旧链的 `072d275`。推荐前者——旧链已归档在仓库外，
   检出来会让观察窗里出现「不可解释的历史」。
2. `./lab.sh build target-service` 重建，**源码与镜像必须是同一版**，
   否则 Agent 的 `git diff` 结论和运行时行为对不上，这轮作废。
3. 旋钮回到 `DOWNSTREAM_TIMEOUT_MS=2000`、`LOAD_PATHS` **不含** `/api/orders/2`、
   无告警、5xx = 0。
4. **等窗口**：F4 的 `checkWindow()` 要求 HEAD 已在 15 分钟窗口外。
   如果第 1 步是现注入的，就得再坐稳 16 分钟（`run-round.mjs` 不会替 F4 做 settle，
   它 `settle()` 直接返回 null）。
5. ⚠️ 这一轮的观察窗里会留着第 1 步那次注入的容器活动。**manifest 必须记清 `injection.at`
   和 `injection.commit`**——否则又会重演 L1：Agent 在日志里看见一段解释不了的 500，
   而这只是实验台自己摆场子的动作。

---

## F2 续跑：三轮中止的根因与修复（2026-10-30）

| 轮次 | 走到哪一步 | 中止原因 | 判定 |
| --- | --- | --- | --- |
| 0445Z | setup 第一步 | `faults.mjs` 相对路径拼成 `incident/incident/...`（已在 0446Z 前修复） | 作废 |
| 0446Z | 注入完成、告警 firing、Agent 跑了 4m15s | **MiniMax Token Plan 429（额度上限）** | 作废 |
| 0703Z | 注入完成、告警 firing、**Agent 跑完并产出了完整报告** | **runner 的 cap 比 Agent 早 10 秒断开**（见下） | 作废 |

**0446Z 的失败链**（不是 Agent 的错，也不是看门狗误杀）：

1. 05:08:28 Agent 开跑；05:12:43 首次 429 `已达到 Token Plan 用量上限`。
2. 服务日志：`Agent error (no reply sent), will retry silently with backoff`。
3. `ws-run` 收到 `run_finished` 后正常退出（exit 0），stdout 为空。
4. `run-round` 的空输出检查读了 `ws.err`，而 `spawnSync` 的字段是 `ws.stderr`
   → 报错只剩一个 `undefined`，真正原因被吞掉。
5. `fail()` 抛出 → 第 9 步「恢复实验台」不执行 → 台子停在故障态；服务继续后台重试。

**Agent 实际做到哪一步**（仅作过程记录，**不能当证据**）：
transcript `runs/session-transcripts/2026-10-30T05-08-28-273Z_01a18b35-99f1-7e56-80c3-15093aab35a2.jsonl`
显示它已定位 NPE、首个异常 05:07:15、提交 `486fb57` 删除判空兜底，并在做最后的
「有兜底 vs 无兜底」对照；但它没有产出报告，也没有通道审计与打分 → 这一轮**作废**。

### 0703Z：Agent 跑完了，runner 早断了 10 秒（2026-10-30 07:03Z）

这一轮值得单独记，因为它把「Agent 的产出」和「runner 的采集」这两件事分开了：

| 时刻 (UTC) | 事件 |
| --- | --- |
| 07:19:22 | 注入 F2：提交 `f24ecb8`（删掉判空兜底）+ 重建容器 |
| 07:20:04 | 告警 `activeAt`（pending），value 9.41% |
| 07:20:47 | Agent 开跑（transcript 611KB） |
| **07:35:47** | **ws-run 触发 cap（15 分钟）→ WS 断开** |
| 07:35:57 | 服务才把报告发出来：`Agent output: # target-service 5xx 根因诊断报告` → `Message sent` |
| 07:36:41 | `Host Agent completed`；随后被中止路径的 stop 收尾 |

**Agent 跑完并产出了 9430 字的完整报告**（三个锚点、机制链、负证据都在），
但 runner 的采集口径是 ws-run 的 stdout——它早断了 10 秒，所以**这一轮仍然作废**：
报告没进 manifest、没做通道审计、没打分。报告全文已从 transcript 提取到
`/tmp/f2-0703Z-recovered-report.md` **仅作过程记录**，不作为证据引用。
（换成「从 transcript 捞报告」也能拿到结论，但那是改证据口径，不是一件可以顺手做的事。）

**cap 为什么不够**：旧 cap 是 15 分钟，是拿 F4 轮的耗时（4.5 分钟）外推的；
F2 轮的 Agent 跑了 **15 分 10 秒**，正好卡在边上。

**修法**（`incident/runs/ws-run.mjs` + `run-round.mjs`）：

- cap 从 15 分钟提到 **30 分钟**（上限是安全网，不是节奏控制）；
- 空闲看门狗从 4 分钟提到 **10 分钟**，并给每种退出路径写明原因
  （`cap reached` / `idle 10min` / `no agent_reply`）——上一轮之所以只剩一句
  `undefined`，就是因为既没有 stderr、也没写退出原因；
- manifest 新增 `provider` 字段（P10 前置闸门），记录本轮用的 provider/模型，
  换模型后不同轮次能不能比，一眼可见。

**这一轮顺带验证了上一轮的修复**：0703Z 中止时 `restore.ok=true`——中止路径
真的把实验台恢复了（0446Z 那次没恢复，order 2 一直 500、告警一直 firing）。

**失败轮留下的提交怎么处理**：每跑完一轮 F2，服务仓库里就会多一组
「inject + restore」提交。留在链上，Agent 会看到同一改动当天反复上下线，
像实验台而不是线上仓库。所以每轮结束后都回退到预跑基线 `7bb726a`，
失败轮的提交打包到仓库外（`~/incident-lab-archive/failed-f2-*.bundle`），
再 `reflog expire` + `gc --prune=now` 清掉悬空对象（`fsck --unreachable` = 0）。

**修复**（`incident/runs/run-round.mjs`）：

- `ws.err` → `ws.stderr`，并把 `spawnSync.error` / signal 一起写进中止原因；
- 中止路径（`main().catch`）也执行 `spec.restore()`，并 `POST /api/groups/:jid/stop`
  停掉服务端静默重试；
- 开跑前先停一次残留队列，避免上一轮的 backoff 重试插进本轮。

**当前实验台状态**（2026-10-30T06:55Z）：

- 服务仓库 HEAD = `7bb726a`（判空兜底在位），链
  `7bb726a / 072d275 / 3ca923c / 46ea5d5 / a9c8957`。失败轮的 `486fb57 / 2fc9d54`
  已归档到 `~/incident-lab-archive/failed-f2-0446z.bundle` 并 prune，
  `git fsck --unreachable` 为 0。
- 注意：`7bb726a` 是 0446Z 的 setup 创建的 restore 提交。保留它是因为它的内容
  （判空兜底在位）与时间（04:46Z，已在 15 分钟窗口外）正是 F2 预跑基线；
  失败轮的 inject 提交 `486fb57` 和随后的 `2fc9d54` 已从链上移除。
- order2=200、5xx 比例 0、无告警、`app.log` 在增长；`--dry-run --fault F2`
  前置闸门 P1–P9 全过。

**模型额度（2026-10-30 07:00Z 已解决）。**
0446Z 中止时 MiniMax Token Plan 已到上限。当时的两个选项：`minimax`（MiniMax-M3，
与已跑 F4 轮次可比）与「中转deepseek」（`deepseek-v4.1-flash[1m]`，换模型后
F4 轮次需一起重跑）。本人先选 DeepSeek 并做了一次最小连通测试
（`run_finished=completed`，但 ws-run 没收到文本——如果以后真要用它，先查这个）；
随后确认 MiniMax 额度已恢复，**最终仍用 MiniMax-M3**。provider 已切回
（`minimax` enabled/默认，`中转deepseek` disabled），冒烟测试返回 `OK`。
**F2 轮已于 07:03Z 开跑**；manifest 新增 `provider` 字段（P10）记录本轮模型。
若以后改用 DeepSeek，已跑的 F4 轮次必须一起重跑，否则不可比。

**【2026-10-27】上一轮状态（仍是当前最强证据）**：F4 对照组复跑已跑完并独立复核完：
四条判定标准 4/4、通道零越界；但取证环境并非完全干净——复核查出 1 处残留的答案提示（非承重，已披露）。
复核件：`incident/runs/audit-2026-10-27T0727Z.md` §7。

简历包在仓库外：`/home/fs-user/Desktop/文档/overleaf/miniclaw_incident相关/`
（`paste-ready-最终版.md` 是成稿，`claim-ledger.json` 是唯一放行依据）。

发现的泄漏有七处，都不是 Agent 的错，是实验台自己的：

| 泄漏点 | 泄漏内容 | 处理 |
| --- | --- | --- |
| `incident/faults/faults.mjs` | 逐条列出注入了哪些故障、注入了什么代码 | 移出 Agent 工作区 |
| `incident/runs/agent-report-*.md`、`incident/RESUME.md` | 前两轮的分析结论 | 移出 Agent 工作区 |
| **F2 提交的 commit message** | 正文写着 `Fault-F2: unchecked downstream call raises NPE` | 重建服务仓库历史，去掉标签 |
| **git 通道连着实验台自己的历史** | `feat(incident): add fault-injection lab…` 等提交 | 工作区独立成仓，通道只看得到服务历史 |
| **`.env` 里的注释** | 写着「F2 已部署但休眠、旋钮才是触发源」 | 注释清空，只留旋钮值 |
| **聊天历史注入** | Agent 新 session 会把上一轮报告注入 prompt | 清空工作区聊天记录与 session |
| **服务仓库 `data.sql` 种子注释**（2026-10-27 复核时才发现） | 描述了**被 F2 删掉的判空兜底**（「degrades a missing profile to ship_to=UNKNOWN」），Agent 于 07:31:42Z 读到并写进报告 | 源文件与工作树已清；**git 历史里的残留已于 2026-10-30 通过重建整条链彻底清掉**（见「服务仓库历史重建」一节），`leak-scan` 现在 0 命中 |

最严重的是第三条：**04:32 那份报告里写的「commit `eed747c` 再次引入 F2 缺陷」，
"F2" 这个词是从 commit message 里读到的**，不是 Agent 自己推出来的。
结论虽然对，但取证过程被喂了答案——这条证据链不能直接拿来支撑简历 claim。

**【2026-10-26 16:xx 追加】同一处泄漏也污染了 02:22Z 的 F2 正例轮**：
`incident/runs/agent-report-2026-10-26T0222Z.md` 第 61 行把
`commit body 同为 Fault-F2: unchecked downstream call raises NPE`
当作证据来源引了出来，根因段也直接写出「删除判空兜底 → 下游返回 null → NPE」
这一机制——与泄漏正文的一句话摘要重合。所以 F2 正例轮同样只能证明
「诊断流程与证据链跑通」，不能证明「Agent 独立推出了失效机制」。
台账 `claim-incident-101` 已补上同款披露（此前只有 102 有）。

**【2026-10-27 追加】清干净之后又查出四处更隐蔽的泄漏面**，都不在文件里，
在「运行时读的那份」里——改了源不同步，等于 Agent 还在用旧契约：

| 泄漏面 | 泄漏内容 | 处理 |
| --- | --- | --- |
| **工作区记忆 `lesson`** | 把上一轮的失效机制、旋钮值、已死的 commit SHA 原样写死；`historical-incident-lookup` 一召回就等于发答案 | 改写成只留方法（锚点口径、负证据、分层排查经验），去掉结论 |
| **工作区记忆 `open_loop`** | 状态已过期，内容同样写死结论 | 整条 forget（软删）**并把 tombstone 正文一起清空**（见下） |
| **Skill 契约里的示例** | `log-triage` 的输出示例直接填了异常类型与栈顶方法名 | 换成占位符，并写死「示例里不要填具体类名/方法名/行号」 |
| **Agent Profile 的 `agents_prompt`** | 「两层归因」小节写成了带结论的模板 | 改成「归因要分层」原则，不给场景模板、不预填结论 |

> ⚠️ **三个必须记住的坑**：
> ① **改了 `incident/skills/` 或 `identity.json` 不等于生效**——Agent 运行时读的是
> `data/skills/<userId>/*/SKILL.md` 与 `agent_profiles` 表里的行。
> `incident/runs/sync-skills.mjs` 与 `incident/runs/sync-agent-profile.mjs` 负责同步，幂等。
> ② **底座的 `forget` 是软删，`get` 不过滤 status**——拿着 id 仍能把原文整段取回来，
> 10-26 那一轮正是「search 拿 id、再 get 取全文」。作废一条记忆不等于 Agent 读不到它，
> 必须把 tombstone 正文一起清空（`memory-de-leak.mjs` 的 `scrubTombstone`）。
> ③ **手工去泄漏一定会漏「描述已删除行为」的残留**——`data.sql` 那半句种子注释
> 没有任何显式故障标签（`fault F2` 那种），只是描述了一个**已被删除的兜底逻辑**，
> 所以清标签式的手工扫描完全看不到它。开跑前一律跑 `node incident/runs/leak-scan.mjs`，
> 0 命中才开跑。

剩下的：① 重定义 F5；② 只读 MCP 工具通道；③ 底座 `forget`/trigram 检索这两个缺陷要不要单独立项。

## 本轮新增（2026-10-30 下午）：通道合规审计 + 判据 v2 + 4 轮复跑

### 一句话

**上午那一轮（0350Z）作废**——Agent 直读了旋钮文件，而闸门当时根本没扫那个面；
现在这个面被显式审掉，每轮自动审，**审不过就不算这一轮的数**。
之后跑了 F4 对照 ×2（0423Z / 0431Z，均有效、通道污染 0），F2 正例又试了两轮
（0446Z / 0703Z，都因 harness 缺陷中止，见上文 07:40Z 那条），第三轮 0738Z 才跑通。

### 1. 作废的那一轮：闸门没覆盖到的那个面

`2026-10-30T0350Z`（runner 重写前的最后一轮 F4）：

| 审计项 | 结果 |
| --- | --- |
| 工具调用 | 47 次 |
| **污染** | **1 处**：bash 直读 `~/.config/miniclaw-lab/lab.env` |
| 越界 | 4 处：`curl` 直连 Prometheus、`cd incident/` 读 lab.sh / docker-compose.yml、直读旋钮文件绝对路径 |
| 判定 | **contaminated** → 本轮作废 |

**为什么算污染而不是越界**：旋钮文件是**运维面**。生效值只应该从只读通道 `runtime env` 取，
直读它绕过了通道。更要紧的是，当时那个文件里的注释写着故障编号和「下一轮只把超时改成 1」——
那不是环境噪音，是**答案**。

而闸门当时只扫 5 个面（服务仓库工作树 / git 历史 / 工作区记忆 / 运行时 Skill / Agent Profile），
**旋钮文件不在扫描面里**。所以 `leak-scan` 报「0 命中」，Agent 却确实读到了提示。
闸门覆盖不到的面，等于没有闸门——这是本项目第二次栽在同一类问题上
（第一次是 `leak-scan` 从 `incident/` 目录跑时假装扫过工作区记忆）。

处置三件：① 旋钮文件改成只有运维注释；② 加 `incident/runs/channel-audit.mjs`；
③ 那一轮**作废**，分数不收进指标表。

### 2. 旋钮文件：答案清空了，但路径仍然是运维面

`~/.config/miniclaw-lab/lab.env` 现在只剩旋钮值和纯运维说明，
**没有任何故障语义**（没有故障编号、没有「下一轮怎么注入」、没有「哪些是必需条件」）。

但有一条要写清楚：只读工具 `runtime env` 仍然打印 `knob_file: <绝对路径>` 和 `knob_file_mtime`。
这是**故意留的**——Agent 判断「配置是什么时候被改的」需要这个时间戳，
`knob_file_mtime` 也是判断「容器重建把配置带进去了」的关键证据。
代价就是 Agent 知道那个文件在哪。所以规则只能是：
**直读旋钮文件 = 污染**，不管文件里此刻有没有答案。本轮 4 轮没有一轮这么做（由审计自动判定）。

> ⚠️ 本机**没有免密 sudo**，所以「把旋钮文件改成 root 属主、Agent 读不到」这条路走不通。
> 只能靠规则 + 审计，不能靠文件系统权限。

### 3. 通道合规审计（`incident/runs/channel-audit.mjs`）

10-27 那轮的通道复核是**手工**逐条读 transcript 做的（36 次 bash 调用，逐个绝对路径对表）。
手工审只覆盖那一轮——下一轮就漏了（0350Z 那轮直读旋钮文件）。
所以把它变成脚本，**每轮自动审，审不过就不算这一轮的数**。

两级判定：

| 级别 | 含义 | 例子 |
| --- | --- | --- |
| **污染（contaminating）** | 读到了答案，或绕过只读通道取生效配置 | `incident/faults/`、`incident/runs/`（含 ground-truth 与既往报告）、`RESUME.md`、`messages.db`、直读 `~/.config/miniclaw-lab/` |
| **越界（out_of_surface）** | 读了证据面之外的东西，但本身不是答案 | `incident/lab.sh`、`incident/docker-compose.yml`、`incident/skills/`、`incident/agent-profile/`、`docker` 命令、`curl` 直连 Prometheus |

越界**不判废**，但必须写进 manifest 并在复核件里披露——
「Agent 越界但没拿到答案」和「Agent 没越界」是两件事，不能混着说。

历史 transcript 复核结果（同一份脚本）：

| transcript | 判定 | 说明 |
| --- | --- | --- |
| 10-26 F2 正例轮 | **contaminated** | 读了 `RESUME.md`（本台账写清了实验设计与历轮结论） |
| 10-27 F4 对照轮 | out_of_surface（污染 0 / 越界 1） | 与人工复核结论一致 ✓ |
| 10-30T0350Z | **contaminated**（污染 1 / 越界 4） | 直读旋钮文件 → 作废 |
| 10-30T0423Z / 0431Z | out_of_surface（污染 0） | 本轮复跑的 F4 两轮 |

脚本本身也踩过两个坑，都已修：
- 搬家前的旧根路径 `/persistent/home/...` 被当成污染 → 改成**别名**（同一批文件），
  但用了几次要聚合成一条披露（「环境没迁完，结论要复核」）。
- HTTP 端点路径（`/api/orders/1`、`/profiles`）被当成文件系统路径 → 凭空造出 80 多条越界记录。
  现在只认首段在系统顶层目录白名单里的路径，且先摘掉 URL。

### 4. 判据 v2：四处「量的是排版，不是诊断能力」

10-30 上午那轮 F4 报告，逐条人工读过：机制链完整（读超时 → 客户端产出 null → 未判空 → NPE → 500），
分层归因清楚，三个锚点齐。但 v1 判据给了 0.5。第二轮更离谱：**0 分**，
因为报告照 `root-cause-report` Skill 规定的 ```text 围栏格式写了六个字段，
而 v1 的切段只认 markdown 标题 → 六个字段全判 `NO_SECTION`。

四处改动，同一个毛病——**判据量的是排版，不是诊断能力**：

| # | v1 的问题 | v2 怎么改 |
| --- | --- | --- |
| 1 | 切段只认 `^#+.*【…】`，Skill 契约里的 ```text 围栏写法一律切不出来 | 按**契约标记**（【根因假设】…）切；标题写法与围栏写法都认。旧实现保留成 `extractSectionsLegacy`，对照过：10-26/10-27/10-30T0423Z 三份报告新旧结果逐字节一致，只有围栏那份从「全空」变成「切出来」 |
| 2 | C2 要求字面「返回…null」，报告写的是「折叠成 `null`」 | 词表扩到 返回/折叠/变成/降级/转成/映射为/归并/产出…null。**负对照**：说了超时+判空+NPE 但从没说客户端产出 null 的报告，C2 仍然 FAIL |
| 3 | Q3 数「排除」两个字 | 改成数**条目**（bullet / 编号项 / 表格数据行）。10-30T0423Z 报告用 6 个 bullet 写了 6 条已排除假设，每条都不带「排除」二字，旧口径只得 2 分 |
| 4 | Q2 只在根因节里找三个固定词 | 词表扩到 触发源/触发因/触发因素/触发条件/必要条件/前提条件/前置条件/前置缺陷/放大条件/放大器/放大因子，取全文，且要求**至少两个**不同的层级词（分层归因 = 至少分出两层） |

**F2 与 F4 的「发布归因」判据故意不一样**，这不是随手改的：
F4 的真值里**发布就是必要条件**，F2 的真值里**发布就是触发源**。
所以「必要条件 + commit 字样」这种邻近式匹配，对 F4 是对的、对 F2 是**假阳性**
（F2 的报告完全可能写「必要条件：10-26 那次提交删掉了判空兜底」——那是事实，
而且「触发源」是今天那次发布）。⇒ F2 的降级判据改成**主语绑定**
（`发布…不是触发源`），F4 保留宽口径。两种写法都做过正负对照。

改判据的纪律（这轮定下来，以后照办）：
① 先判断是**判据错**还是 **Agent 错**——报告内容满足判据本意但模式没命中，就是判据错；
② 改完必须过 `node incident/runs/calibrate-scorer.mjs`（人工审计过的案例集，含两个交叉案例必须仍是 0.0；
   案例集会随轮次增加，**每次改判据时按当时的全量跑**，不能只跑旧的 5 个），
   2026-10-30 改 v3 时是 **7/7 通过**（5 个旧案例 + 0738Z + 1 条负对照）；
③ 必须写**负对照**——把判据的实质抽掉的报告，仍然必须判 FAIL；
④ **所有轮次用同一个判据版本重新打分**，分数文件里带 `rubric_version`；
⑤ 新旧分数并列披露。

> ⚠️ 纪律本身也是纪律：**看见分数不对就调判据，等于自己给自己判卷**。
> 所以每条改动都要能说清「为什么这个模式本意就是量这个，而它量错了」，
> 说不出就别改，把报告留着让人复核。

### 5. runner（`incident/runs/run-round.mjs`）的几处修法

一轮 = 一条命令：`node incident/runs/run-round.mjs --fault F4`。每一步的实际输出都落进
`round-manifest-<ts>.json`，指标表里的数字因此有证据链。

| 修法 | 为什么 |
| --- | --- |
| **先打分再恢复** | 之前恢复失败会把整个打分跳过，一轮白跑。恢复失败现在只记 `restore.ok=false`，不吞分数 |
| **fetch 带 4 次重试** | 容器刚重建时回环端口会短暂拒连，那是抖动不是台子坏了 |
| **失败抓 stack** | 之前只打 `err.message`，看不到是哪一步挂的 |
| **F2 静默态要「坐稳」** | 见下 |
| **F2 的 settle 取 max 而不是 min** | 旋钮 mtime 与容器启动时刻要**都**滑出 15 分钟窗口，取较早的那个会漏掉「重建比旋钮改动慢」的情况，基线那次部署会卡在窗口里 |
| **`faults.mjs` 用绝对路径** | 那两步的 cwd 是 `incident/`，相对路径会拼成 `incident/incident/...`（本轮真踩了一次） |

**F2 为什么要坐稳**：F2 的静默态要换代码（提交一次「把判空兜底加回来」+ 重建容器 + 改压测路径），
这三件事各自都是一次「变更」。它们若落在 15 分钟窗口里，
Agent 会看到窗口内既有代码变更又有配置变更（压测路径），
那一轮测的就变成「Agent 能不能在两个变更里挑对」，而不是「Agent 会不会误归因到发布」。
所以静默态摆完要等 ≥16 分钟再注入（`--settle-ms` 可调）。

F4 不需要坐稳：它的触发源就是那一次容器重建本身。

### 6. 本轮 4 轮的结果

见下节「4 轮结果」。

## 本轮新增（2026-10-30）：搬家造成的静默损坏 + 服务仓库历史重建

仓库从 `/persistent/home/fs-user/IdeaProjects/miniclaw-main/miniclaw-main` 搬到
`/mnt/my-work/ai_coding/study/miniclaw-main/miniclaw-main`。搬家本身不报错，
但**留下了 5 处静默损坏**，其中 **2 处完全不会自己暴露**。本轮全部定位并修复，
服务仓库历史已重建，`leak-scan` **第一次达到 0 命中**。

按"暴露程度"分三档：

| 档 | 条目 | 表现 |
|---|---|---|
| **完全静默**（没有任何报错，指标看起来正常） | #2 `app.log` 冻结、#3 工作区变空壳 | 容器 healthy、日志文件还在但不再增长；Agent 侧零报错，只是拿不到证据 |
| **暴露但对不上号**（有报错，但报错指向别处） | #4 Host Runner 拒绝启动、#5 只读通道路径失效 | 前者像"环境问题"、后者像"工具坏了"，都不会指向"路径搬过家" |
| **暴露得比较直白** | #1 prometheus / alertmanager exit 127 | `docker compose ps` 直接显示 Exited，看一眼就知道挂了 |

### 5 处静默损坏（逐条）

| # | 现象 | 根因 | 为什么不会自己暴露 | 修复 |
|---|------|------|--------------------|------|
| 1 | prometheus / alertmanager 启动即退（exit 127） | compose 的 bind mount 写的是旧绝对路径，容器启动时挂载源不存在 | 报错只在 `docker logs` 里，`docker compose ps` 只显示 `Exited (127)`，没有"路径不存在"的字样 | `incident/lab.sh up -d`（用绝对 `-f`，相对挂载重新解析） |
| 2 | `workspace/logs/app.log` 不再增长 | 文件属主变成 uid 1000 / mode 644，容器以 uid 999 运行，写不进去 | **容器 healthy、`docker logs` 无任何错误**——Spring Boot 静默降级成只写 stdout，而 `logs` 通道读的是一个冻结的文件 | `chmod 666 incident/workspace/logs/*`（目录本身已是 777，轮转/新建不受影响） |
| 3 | Agent 的工作区变成一个空壳 | `registered_groups.custom_cwd` 还指向旧路径 | 旧路径下只剩一个空 `logs/`，没有 `tools/`、没有 `.git`；**Agent 侧零报错**，只是拿不到任何证据 | 直接改库 `UPDATE registered_groups SET custom_cwd=...` + 重启服务（见下） |
| 4 | Host Runner 拒绝启动 | `config/mount-allowlist.json` 的 allowedRoots 还是旧根 | 只在运行时校验（`src/container-runner.ts`），`custom_cwd` 落在 allowlist 外时 runner 静默不启动 | allowedRoots 换成 `/mnt/my-work/...` |
| 5 | Agent 拿不到只读通道 | `incident/agent-profile/identity.json` 的 tools_prompt 写死了旧绝对路径 | 旧副本已经不存在；Agent 按 prompt 去执行只会得到"命令不存在" | 改成新路径 + `sync-agent-profile.mjs` 同步（profile v5 → v6） |

> **这条教训比修复本身重要**：#2 和 #3 是"看起来完全正常"的失败——容器在跑、
> 健康检查在过、日志文件还在，**只是不再有任何新内容**；Agent 侧完全没有报错，
> 只是拿到一个空壳工作区。
> 所以验收项不能是"服务起没起来"，必须是"**证据通道有没有在动**"。
> #4 和 #5 也有坑：它们会报错，但报的是"环境问题""工具坏了"，
> 不会指向"路径搬过家"这个真因。
> 下面那份验收清单就是为了防这个。

### 搬家后的验收清单（下次换路径时逐条跑）

```bash
# ① 三个容器都起来，且没有 Exited
incident/lab.sh ps

# ② 挂载源指向新路径（不是旧路径）
docker inspect <container> --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'

# ③ 日志文件在长（关键项：看 mtime 和行数是否在涨，不是看文件在不在）
ls -l --time-style=full-iso incident/workspace/logs/app.log
wc -l incident/workspace/logs/app.log

# ④ prometheus 有抓取目标、规则已加载
curl -s localhost:9090/api/v1/targets | jq '.data.activeTargets[].health'
curl -s localhost:9090/api/v1/rules | jq '.data.groups[].rules[].name'

# ⑤ 静息态没被破坏：故障注入仍只打中 order2
curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/orders/order1
curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/orders/order2
```

### #3 的修法：为什么不能走 API

`PATCH /api/groups/:jid` 改不了 `custom_cwd`——`GroupPatchSchema`（`src/schemas.ts:672`）
没有这个字段，也没有别的路由能改。所以是：停服务 → 直接改库 → 起服务。

```bash
lsof -ti:3000 -sTCP:LISTEN | xargs kill
sqlite3 data/db/messages.db \
  "UPDATE registered_groups SET custom_cwd='<新工作区绝对路径>' WHERE jid='web:8ff36e4b-...'"
npm start
```

### 服务仓库历史重建（这才是这轮最要紧的动作）

**为什么必须重建**：上一轮残留的那半句
`-- the service degrades a missing profile to ship_to=UNKNOWN.`
是 `data.sql` 里两行种子注释中的一行。它同时出现在两条提交的 diff 里
（`83c26bf` 里被**加上**，`38b3705` 里被**删掉**）——
所以只要链上任何一条提交还在，说"删掉它"的那条提交本身就把答案写在 diff 里了。
**只有整条链重建才能真正清掉**，而这正是 10-27 那轮没做完、只披露没解决的那一项。

**做法**：新增 `incident/runs/rebuild-service-history.mjs`（可复现，有 dry-run）。
用 plumbing 逐条复制原始 commit object，**只改 `tree` / `parent` 两行**，
作者、作者时间、committer、committer 时间、commit message 全部逐字节保留。
唯一被重写的是 1 个基线文件 `target-service/src/main/resources/data.sql`。

脚本内置 4 条断言，任何一条不成立就中止：

1. 重建后 HEAD 的 tree == 旧 HEAD 的 tree（工作区最终内容不能变）。
2. 每条重建提交与对应旧提交的差异，**只**出现在被重基线的文件上。
3. 每条提交 diff 里**每个非重基线文件**的 blob 哈希与旧提交逐一相等。
4. 重建后变空的提交被丢弃（不留下空提交）。

**结果**：

| 旧链（2026-10-27） | 新链（2026-10-30） | 备注 |
|---|---|---|
| `83c26bf` 2026-10-19T10:12Z | `a9c8957` 2026-10-19T10:12Z | `feat(service): add order and profile read endpoints` |
| `d306ad3` 2026-10-21T14:35Z | `46ea5d5` 2026-10-21T14:35Z | `chore(service): add downstream client, load driver and actuator exposure` |
| `35854c8` 2026-10-26T07:23Z | `3ca923c` 2026-10-26T07:23Z | `feat(order): enrich response with downstream shipping address` ← 部署的那条 |
| `8061f59` 2026-10-26T07:29Z | `072d275` 2026-10-26T07:29Z | `fix(tool): keep \`git file\` reads inside the repository root` ← 只动 tools/ |
| `38b3705` 2026-10-26T07:29Z | — | **被丢弃**：它就是「删掉那半句」的那条提交，重写后成了空提交 |

- HEAD tree `14f66e7c15ae71503aca9591ae16a3f8f13cebfd`，**与重建前逐字节相同**。
- F2 缺陷（`OrderService.loadOrder` 删掉判空）**刻意保留**，diff 内容不变。
- 时间戳全部原样保留 → **「窗口内无代码变更」这条承重不变量仍然成立**。
- 旧链打包存档在仓库外：`~/incident-lab-archive/service-repo-pre-rebuild.bundle`
  （`git bundle list-heads` 指向旧 HEAD `38b3705`，已验证可 clone）。
  旧 SHA 因此**仍可解析**，审计件里对 `38b3705` / `35854c8` 的引用不用改。
- 仓内旧对象已 prune：`git fsck --unreachable` 为空，只剩 `refs/heads/main`。

> ⚠️ **复核件与台账里引用旧 SHA 的地方不要改**——那是历史记录，
> 记的是"当时那条链是什么样"。新链只影响"Agent 现在能看到什么"。

### 当前门禁状态

`node incident/runs/leak-scan.mjs` → **0 命中**（5 个面全部干净）：
service 工作树 / git 历史 / 工作区记忆 / 运行时 Skills / Agent Profile。

但有三个**已知点**，开跑前必须知道：

1. **leak-scan 必须在仓库根目录跑**——它用 `db.initDatabase()` 定位数据库、
   用相对路径扫工作区。从 `incident/` 里跑会找不到数据库。
   **2026-10-30 已修**：以前这时它只打印一行 `! 工作区记忆扫描跳过`
   然后照样报「0 命中」并 exit 0（假的通过）；现在扫不到的面会被记下来，
   报告改为「**不能报告 0 命中**——1 个面没扫到」并 **exit 1**。
   静默跳过等于给出一个假的「0 命中」，这个坑不该留着。
2. **它没有真正覆盖软删行**。`memory.listWorkspaceMemory` 过滤了 `status='deleted'`，
   所以 tombstone 正文实际上不在扫描范围内。真正兜底的是
   `memory-de-leak.mjs` 的 `scrubTombstone`（必须保证它跑过）。
   脚本头部注释原先写的是「含已删除条目」——**那句话说错了，本轮已改正**。
3. **聊天历史根本不在扫描面里**。本轮的 Agent 冒烟测试在 `incident-lab` 群里
   留了一条消息，**下一轮开跑前必须清掉**（见下方"还没做的"）。

### Agent 冒烟测试（通过）

连通性自检（不诊断、不写文件），三项全部正确：

- 工作区 cwd = 新工作区绝对路径（不是空壳旧路径）。
- `$LAB git log --oneline -4` 返回**重建后的链**（`072d275 / 3ca923c / 46ea5d5 / a9c8957`），
  Agent 看到的就是它该看到的那四条。
- `$LAB runtime started` 返回容器启动时刻 `2026-10-30T02:11:53Z`。

Agent 全程只读，`git status` 干净，没写任何文件。
它还**主动披露**了通道的 `runtime` 分支内部调用 `docker inspect`——这与"只用只读 CLI"的口径
有一处张力，已记在下面的缺口里。

> **prompt 契约的一个坑**：`identity.json` 里写的是「设 `LAB="..."` 再用 `$LAB`」两行式契约，
> 但 Agent 每次 bash 调用是**独立 shell**，`LAB` 变量不跨调用存活。
> Agent 于是自己改用了相对路径 `node tools/incident-readonly.mjs`——能跑通，
> 因为 CLI 从 `import.meta.url` 推 `REPO` / `LOG_DIR`，不依赖 cwd。
> 但**服务源码路径那一支**仍然依赖 `$LAB` 里的绝对路径。下一轮要么让 prompt 改成单行式，
> 要么让 CLI 自己解析 workspace 根。下次改 prompt 时顺手处理。

## 本轮新增：答案泄漏清理与通道合规复跑

### 为什么必须重做实验台（不是"洁癖"）

评测里要证明的是「**Agent 从证据推出根因**」。如果答案在通道里，
结论对也说明不了任何事——只能说明它会读题。

### 工作区重构成什么样

```
incident/                    ← 实验台控制面（Agent 看不见）
├── faults/                  ← 故障清单 + 注入脚本
├── runs/                    ← 历次报告、聊天记录归档、session transcript
├── skills/                  ← skill 源文件
├── lab.sh / lab.env.example ← compose 包装器 + 旋钮模板
└── workspace/               ← ★ Agent 的工作区（= 它 shell 的 cwd）
    ├── .git/                ← 独立仓库：只有服务的历史
    ├── tools/incident-readonly.mjs   ← 唯一观测通道
    ├── target-service/      ← 被诊断的源码
    └── logs/                ← 容器日志挂载点
```

`workspace/` 在外层仓库的 `.gitignore` 里，自带一个 git 仓库。
这样 Agent 在工作区里执行 `git log` 时，git 停在 `workspace/.git`，
**看不到外层仓库历史**（外层历史里有 fault-injection / resume checkpoint 等提交）。

### 旋钮文件挪出仓库

`~/.config/miniclaw-lab/lab.env`（chmod 600）。`incident/lab.sh` 强制
`docker compose --env-file`，找不到 env 文件直接报错退出——因为 `docker compose`
在找不到 `.env` 时会**静默重置成 compose 文件里的默认值**，那等于凭空造出一个故障。
所有 compose 调用都必须走 `lab.sh`。

### 服务仓库历史（Agent 能看到的那几条）

**当前（2026-10-30 重建后）**：

```
a9c8957  2026-10-19T10:12Z  feat(service): add order and profile read endpoints
46ea5d5  2026-10-21T14:35Z  chore(service): add downstream client, load driver and actuator exposure
3ca923c  2026-10-26T07:23Z  feat(order): enrich response with downstream shipping address   ← 部署的那条
072d275  2026-10-26T07:29Z  fix(tool): keep `git file` reads inside the repository root      ← 只动 tools/
```

没有 `Fault-` 标签，没有回滚/重打的对子，没有实验台自己的提交。

**旧链（2026-10-27 那版，已被 2026-10-30 重建取代）**：

```
83c26bf  2026-10-19T10:12Z  feat(service): add order and profile read endpoints
d306ad3  2026-10-21T14:35Z  chore(service): add downstream client, load driver and actuator exposure
35854c8  2026-10-26T07:23Z  feat(order): enrich response with downstream shipping address   ← 部署的那条
8061f59  2026-10-26T07:29Z  fix(tool): keep `git file` reads inside the repository root      ← 只动 tools/
38b3705  2026-10-26T07:29Z  chore(seed): clarify seed data note                              ← 补的：删掉残留注释
```

两链的对应关系与重建方法见上文「服务仓库历史重建」。**Agent 现在只能看到新链。**
复核件、台账里引用旧 SHA 是历史记录，不用改。

> **【2026-10-27 补记】`38b3705` 是复核之后补的**：复核做全仓库扫描时发现
> `data.sql` 的种子注释还留着半句「the service degrades a missing profile to ship_to=UNKNOWN」
> ——那是**被 F2 删掉的判空兜底**的行为描述。Agent 在 07:31:42Z 读到过它。
> 已确证它**不承重**（根因推导完全不依赖它；必要条件那一层早 2 分 07 秒已由
> `git diff 35854c8` 独立得出），但仍然如实披露并修掉了。详见复核件 §7。
> 提交日期同样回填到 2026-10-26T07:29:40Z，**保持「所有提交都远在故障窗口之外」**。

> **【2026-10-27 换链】这四条 SHA 与 10-26 那版不同，因为历史又重建了一次。**
> 旧链 `c8d12f2 / e78a1c3 / 409d265 / e87d06f` 在 2026-10-27 被 `reset` 掉，
> 新链 `83c26bf / d306ad3 / 35854c8 / 8061f59` **提交信息、作者、作者时间完全一致**，
> 只有 blob 内容不同——差在三个去泄漏的文件上：
> `data.sql` 的种子注释、`schema.sql` 的索引注释、`pom.xml` 的 description。
> F2 缺陷（`OrderService.loadOrder` 删掉判空）**刻意保留**。
> 校验方式：`git log --all -p | grep -inE "fault F1|fault F2|Fault-injection|未判空"` → **0 命中**。
> 旧的 `backup-pre-clean` 分支已删，reflog 已过期，gc 已 prune。
>
> **⚠️ 那次手工去泄漏漏了半句（复核时才发现）**：换链时清掉了 `fault F2` 这种显式标签，
> 但 `data.sql` 的注释还留着「描述已删除行为」的半句 `to ship_to=UNKNOWN`。
> 源头 `incident/target-service/src/main/resources/data.sql` 原本写的是
> 「The baseline code degrades that to ship_to=UNKNOWN; **fault F2 turns it into an NPE**」
> ——手工清理只清了后半句。**源文件现已清干净**（`data.sql` / `schema.sql` / `pom.xml` 三处），
> 重建历史产出的基线 blob 与工作树逐字节一致，下次重建不会再带残留。
> **下次复跑前必须重建历史**，且 `node incident/runs/leak-scan.mjs` 必须 0 命中才能开跑。
> **2026-10-30：这一项已经做了**——整条链重建，历史残留清零，`leak-scan` 现在 0 命中。

最后一条 `072d275`（旧链里是 `8061f59`）是只读 CLI 的路径越界修复——工作区里那份一直没提交，
外层仓库的同一处修复早就在 `38f1af2` 里了。它**只改 `tools/incident-readonly.mjs`**，
`target-service/` 一行未动。提交日期回填为文件真实写作时间（mtime 2026-10-26 15:29:26 +0800），
理由见下文「已处理：工作区仓库的 dirty 状态」。

> **这四条提交的时间戳是回填的作者时间，不是它们的实际提交时刻。**
> `incident/workspace/.git/logs/HEAD` 里能看到重建过程：旧链
> （`dc8d2ca` → `3e1d458` → `62bf9ea`）在 2026-10-26 15:27:48 +0800 被两次 `reset`
> 掉，随后三条提交被带着原有的时刻重新提交（换成 +0800 表示），reflog 因此呈现乱序。
> 重建目的是去掉带 `Fault-` 标签的 commit body。`072d275` 沿用同一写法——
> 日期取文件真实写作时间，这样它不会落在未来任何一次复跑的时间窗里。
> 2026-10-30 的重建**原样保留全部时间戳**（作者/committer 的 wall-clock 与 +0800 偏移都没动），
> 所以同一条规则继续成立：**最晚一条提交是 2026-10-26T07:29:26+08:00（= 2026-10-26T07:29:26Z）**，
> 任何一次复跑的时间窗都在它之后，「窗口内无代码变更」永远成立。

### 干净的 F4 时间线（设计 + 实际执行到哪一步）

| 时刻 (UTC) | 事件 | 状态 |
| --- | --- | --- |
| 07:23:25 | 提交 `35854c8`（最后一次改**服务源码**的提交，F2 缺陷随它上线） | 已发生 |
| 07:29:26 | 提交 `8061f59`（只读 CLI 的路径越界修复，只动 `tools/`；2026-10-27 补提交，日期按 mtime 回填） | 已发生 |
| 07:29:36 | 容器重建，**timeout=2000** → 部署生效（T_dep） | 已发生，但已被 10-27 的重建取代 |
| 07:29:44 | 应用就绪 | 已发生 |
| 07:29:44–14:12:35 | **健康窗口 6 小时 43 分，0 个 NPE、0 个 ERROR**（`runs/log-archive/app.log.2026-10-26.0.gz`） | 已发生 |
| **2026-10-27 01:39:40** | **容器再次重建**（镜像、代码、旋钮均未变；重建原因未记录），应用 01:39:59 就绪 | 已发生 |
| 01:39:59 – 04:02:41 | 健康窗口。**除一次人为探测外 0 NPE / 0 ERROR**（`workspace/logs/app.log`）：2026-10-27 04:02:41 手工 `curl /api/orders/2` 触发 1 次 NPE + 2 条 ERROR——它顺带证明**F2 缺陷确实已部署**，缺陷静默只因 order 2 不在 `LOAD_PATHS` 里 | 已发生 |
| **07:24:20.061** | **只改一个旋钮**：`DOWNSTREAM_TIMEOUT_MS` 2000 → **1**（`~/.config/miniclaw-lab/lab.env` mtime） | **已执行** |
| **07:24:21.000** | 容器重建使新 env 生效（T_dep；镜像、代码、commit 均未变） | **已执行** |
| 07:24:29.198 | 应用就绪 | 已发生 |
| **07:24:29.509** | **首个下游 `Read timed out`** → 07:24:29.515 首个 NPE → 500 | 已发生 |
| 07:24:49.991948342 | 告警 `activeAt`（**pending 时刻**，firing = activeAt + `for`） | 已发生 |
| **07:27:27** | 起 Agent（`ws-run.mjs`），07:34 交付报告 `agent-report-2026-10-27T0727Z.md` | **已执行** |
| 07:40–07:52 | 本人独立复核（`runs/audit-2026-10-27T0727Z.md`） | **已执行** |

设计要点：F2 提交距故障起点 **>15 分钟**，所以按 `deployment-window` 的判定表，
「最近一次代码变更」这一支落在**相关性弱**区间；而部署窗口（容器重建）内**无提交**，
按 `git-diff-analysis` 的规则这本身就是排除发布假设的依据。
两条路都把发布排除掉，Agent 只能从 `runtime env` 里那个旋钮上找触发源。

> 实测出来的 Δ：携带 `35854c8` 的那次部署在 **2026-10-26T07:29:44.919Z** 就绪，
> 距 T_err（2026-10-27T07:24:29.509Z）是 **23h54m44.6s**（从 commit 时间算则是 24h01m04.5s）。
> Agent 的报告把这段写成了「20 小时 55 分」——**数字错了，结论方向没错**（都远超 15 分钟）。
> 见复核件 §3-D1。

### 已知的方法论边界（写清楚，别夸大）

host 模式下 Agent 的 shell 有宿主机的完整文件访问权，**目录布局是引导，不是边界**。
所以合规性靠三件事一起成立，缺一不可：

1. 工作区里确实没有答案（可核查：列出目录即可）
2. Prompt 里明确写了「工作区之外的文件不是证据源」
3. **逐条审 transcript**（唯一能证明"确实没读"的证据）

只做 1 和 2 就宣称"没有泄漏"是不成立的——这是本轮 04:32→06:19 那一跑暴露的。

## 本轮新增：F4 对照组复跑（2026-10-27 07:27Z，清过泄漏）与独立复核

**这一节是当前的主证据。** 10-26 04:32Z 那一轮已被它取代。

### 产出物

| 文件 | 内容 |
| --- | --- |
| `incident/runs/agent-report-2026-10-27T0727Z.md` | Agent 报告原件（**不改**） |
| `incident/runs/session-transcripts/2026-10-27T07-27-34-258Z_01a17c41-df72-7cdb-b3de-40a90cde8c17.jsonl` | 可审计的会话记录 |
| `incident/runs/audit-2026-10-27T0727Z.md` | 本人独立复核件：逐条复算 + 4 处数字问题 + F4 打分 |

### 复跑前做了什么（缺一不可）

1. **服务仓库历史重建**（换链，见上文），去掉三处带答案的文件内容与全部 `Fault-` 标签。
   ⚠️ **这一步当时是手工做的，漏了半句**（`data.sql` 注释里「描述已删除行为」的残留），
   是复核时才发现的。现在改成：先清源文件（已清），再重建历史，
   最后 `node incident/runs/leak-scan.mjs` 必须 0 命中。
2. **工作区记忆去泄漏**（`incident/runs/memory-de-leak.mjs`）：
   `lesson` 改写成只留方法、`open_loop` 整条作废并清空 tombstone 正文。
3. **Skill 与 Profile 去泄漏 + 同步回运行时**
   （`incident/runs/sync-skills.mjs`、`incident/runs/sync-agent-profile.mjs`）：
   改的是源文件，运行时读的是 `data/skills/<userId>/` 与 `agent_profiles` 表——不同步等于没改。
   本次同步后 profile version 3 → 4，agents_prompt 1148 → 1156 字。

### 复核结论

| 项 | 判定 |
| --- | --- |
| 四条 F4 判定标准 | **4/4 通过**（复核件 §4） |
| 通道合规 | **零越界**：8 次 Skill 读取全是本会话自己的 SKILL.md，1 次 memory_search，36 次 bash 的绝对路径全在 `incident/workspace/` 之下；无 `docker inspect`、无 `lab.env`、无 `faults/`、无既往报告、无 `messages.db` |
| 取证环境 | **主要几处已清；仍残留 1 处非承重提示**（服务仓库 `data.sql` 种子注释，Agent 07:31:42Z 读到并在报告 119–120 行引用）→ 复核件 §7 |
| 报告数字 | 多数可回指；**1 处硬错 + 3 处过度声称**（复核件 §3） |

### 复核查出来的四个问题（写出来，别藏）

1. **【硬错】** 距上次部署的时间差写成「20 小时 55 分」，实为 **23h54m44.6s**。
   方向不变（都远超 15 分钟，仍排除该发布作为触发源），但这数字一算就戳得破。
2. **【过度声称】** 「流量全程 2.87–2.91 req/s 恒定」——它自己的采样是 **0.95–2.91**。
   结论（不是流量激增）成立：故障前均值 2.879 → 故障后 2.828。
3. **【过度声称 + 漏掉更值得讲的性质】** 「5xx 比例稳定 0.36–0.435」「平台」——
   实际是**台阶起、边际衰减**：服务端失败率从 07:25 的 ~100% 一路衰减到 07:37 后的 3–5%。
   **1ms 不是「远低于」回环调用所需的 2.5ms，是卡在边上**：失败率是「1ms 预算 vs 回环耗时」的赛跑，
   JVM 预热后回环变快，失败率就掉下来。这条比原报告写的更有价值。
4. **【快照当稳定值】** 「88.5% 出站调用被中断」是 07:32:26 的读数，07:39 复测为 73.7%。
   数字本身对，但会漂。

另外补两条：**历史事件时间戳差 10ms**（.808 vs 实际 .798）；
Agent 自己标为「未直接验证」的 **LoadDriver 复用 `@Primary` 1ms RestTemplate**，
本人读源码确认**成立**（`probeRestTemplate` 无 `@Primary` 也无 `@Qualifier`，实际从未被使用）。

### 顺带挖出来的两个底座缺陷（不是这轮的错）

1. **`forget` 是软删、`get` 不过滤 status** → 作废一条记忆不等于 Agent 读不到它。
   本轮靠 `scrubTombstone` 额外清空 tombstone 正文绕开，**但底座本身该修**。
2. **FTS5 trigram 短语匹配** → 堆在一起的关键词必然 0 命中，
   而 skill 又写着「0 命中 = 无历史记录」，于是 Agent 会把**检索失败**当成**历史上没有**。
   已改 `historical-incident-lookup` 的示例与口径（commit `0cb8033`），**但全局还没查一遍**。

## 历史：2026-10-26 04:32Z 那轮 F4 对照组（已被 10-27 复跑取代，但设计思路保留）

F2 已经证明「**相关**」时 Agent 能查到底。F4 对照组证明的是反方向：
**最近一次发布就发生在故障前 17 分钟，但故障不是它造成的——Agent 必须排除它。**

### 先说清楚：原来的 F4/F5 定义跑不出故障（实测）

| 故障 | 注入方式 | 实测结果 |
| --- | --- | --- |
| F4 | `DOWNSTREAM_TIMEOUT_MS=50` | 基线代码下 **0 个 5xx**：`DownstreamClient` 吞掉所有下游异常并 `return null`，基线代码判空后降级成 `ship_to=UNKNOWN`，HTTP 仍是 200 |
| F5 | `DB_POOL_SIZE=2` | 基线代码下 **0 个 5xx**：容器内 `LoadDriver` 是 `@Scheduled(fixedDelay)` **严格串行**（每 tick 只发一个请求），永远打不满连接池 |

F5 加压实测（`incident/faults/load-hammer.mjs`，本轮新增）：

- `pool=2` + 30s 默认获取超时 + 64 并发 → 11,691 请求**全部 200**，p99 208ms：池被打满但请求只是变慢
- `pool=2` + `connection-timeout=250ms` + 64/256 并发 → 确有池耗尽
  （日志原文 `Connection is not available, request timed out after 250ms (total=2, active=2, idle=0, waiting=38)`），
  但 5xx 只有 **0.5%**，撑不起 `HighServerErrorRate`（阈值 5%，`for: 30s`）
- 想再压低超时 → **Hikari 硬性下限 250ms**，低于它 Spring 直接启动失败：
  `Failed to bind properties under 'spring.datasource.hikari' to com.zaxxer.hikari.HikariDataSource`

结论：**F4/F5 按原定义在基线代码上不可观测，本实验台不存在「纯运行时旋钮 → 5xx」的路径。**
唯一能产生 5xx 的运行时路径是「已部署的缺陷 + 运行时旋钮触发」——这正是对照组真正要考的东西。

### 对照组怎么设计的

时间规则要能真正判「无关」，就必须让**代码提交落在 15 分钟窗口之外**，同时**故障由一个
运行时旋钮单独引发**。做法：

1. **T1（04:08:48 / 04:11:46）** 部署 F2 代码，但让它**静默**：把 `order 2`（user 9999，
   唯一没有 profile 行的订单）从 `LOAD_PATHS` 里去掉 → 缺陷存在但不触发 → **零异常、零告警**
2. **等 17.5 分钟** → 提交 `eed747c` 落到 15 分钟窗口**之外**，代码提交期间一直健康
3. **T3（04:29:09 / 04:29:15）** **只改一个运行时旋钮**：`DOWNSTREAM_TIMEOUT_MS` 2000 → **1**，
   容器重建（**镜像不变、代码不变、无新提交**）→ 下游自调用全部读超时 → `fetchProfile` 返回 null
   → 已部署代码里的未判空解引用 → NPE → 5xx ≈ 43% → 告警 firing
4. 跑 Agent，按四条标准打分

### 时间线（全部 UTC）

| 时刻 | 事件 | 来源 |
| --- | --- | --- |
| 04:08:48 | commit `eed747c` 重新引入 F2 判空移除 | `git log` |
| 04:11:49 | 容器启动（带 `eed747c`，静默） | `logs grep 'Starting TargetServiceApplication'` |
| 04:11:49–04:29:18 | **17.5 分钟静默期：1,294 次订单成功、0 次 NPE、0 次下游失败** | `app.log` 逐行核对 |
| 04:29:09 | `.env` 改动：`DOWNSTREAM_TIMEOUT_MS` 2000 → 1 | `stat -c '%y' incident/.env` |
| 04:29:15.459 | 容器重建（env 生效，**无新提交**） | `docker inspect` |
| 04:29:25.257 | 应用 `Started` | 日志 |
| **04:29:25.622** | **首个下游错误**：`Read timed out`（不是 404） | `logs first 'profile lookup failed'` |
| **04:29:25.633** | **首个 NPE → 500** | `logs first 'NullPointerException'` |
| 04:29:34.991 | 告警 `activeAt`（**pending 时刻**） | `metrics alerts` |
| ≈04:30:05 | 告警真正 firing（= activeAt + `for: 30s`） | `/api/v1/rules` |

> ⚠️ **锚点语义更正（Agent 提的，我复核过，成立）**：Prometheus **v1** `/api/v1/alerts` 的
> `activeAt` 是告警**进入 pending** 的时刻，不是 firing 时刻；firing = `activeAt + for`。
> v2 才有 `firedAt`。上一轮 F2 报告把 `activeAt` 当成 firing 时刻，与这次的口径要统一。

### 三个锚点

| 锚点 | 时间 (UTC) | 来源 |
| --- | --- | --- |
| ① 告警起始 | 2026-10-26T04:29:34.991948342Z（pending） | `metrics alerts` → `activeAt` |
| ② 异常首现 | 2026-10-26T04:29:25.622Z（下游超时）/ .633Z（NPE） | `logs first` |
| ③ 最近部署 | **代码提交 04:08:48（20.6 分钟前）**；容器重建 04:29:15.459（10 秒前） | `git log` / `docker inspect` |

`Δ(②−③提交) = 20.6 分钟` → **提交在 15 分钟窗口之外**；`Δ(②−③重建) = 10.2 秒` →
重建与故障同时，但**重建没带任何代码变更**（`git log` 04:08:48 之后为空）。

### 四条判定标准的验收结果

| 标准 | 结果 | Agent 实际怎么写的 |
| --- | --- | --- |
| ① 判定本次故障与部署无关，并写出依据 | ✅ | 「已排除的假设 5」：`eed747c` **只对了一半**——它是 500 的必要条件，但 04:11:49 就已上线、连续 17.5 分钟零 500，**且 04:08:48 之后无任何提交 → 窗口内无代码变更** |
| ② 指出真正的变更类型是运行时配置 | ✅ | 「本次跃升的触发源（运行时配置层）」；证据是 `.env` mtime 04:29:09 → 容器重建 04:29:15 → 首个错误 +0.365 秒，三段严格咬合 |
| ③ 不把 commit 拉进根因 | ✅ | 明确拆成两层：**代码层是放大器/必要条件**（`OrderService.java:29`），**运行时配置层才是触发源**；并在「已排除」里点名 `eed747c` |
| ④ 根因落在运行时旋钮 | ✅ | 根因指向 `DOWNSTREAM_TIMEOUT_MS=1`；同时用 `hikaricp.connections.max=10 / active=1 / pending=0 / timeout=0` **显式排除**了连接池假设 |

四条全过。另外它还独立做对了三件事：证明 `userId=9999` 本轮出现 **0 次**（前两轮的触发源
已不存在）、识别出 1ms 超时是**竞态**（失败率在 7.6%–43% 间抖动，我用 `metrics range` 复核：
峰值 43.12% @04:31，之后衰减到 7.93% @04:36）、以及用 `ps` 确认没有压测进程在跑 →
排除「流量冲击」。

### 复核过的数字（我逐条验算，全部对得上）

- 静默期 1,294 次 `order N loaded`、**0** NPE、**0** 次 `profile lookup failed`
- 首个下游错误确实是 `ResourceAccessException: ... Read timed out`，不是 404
- `git log` 在 04:08:48 之后**无提交**（`git-diff-analysis` 的「窗口内无代码变更」成立）
- `actuator env` 的三个旋钮键存在但值全被 `******` 掩码；`actuator configprops` 也一样
  （`showValues=never`）→ **只读通道读不到生效配置**，这是本轮最大的工具缺口
- 5xx 比例序列在 04:30 之前**根本不存在**（故障前 = 0，不是 8.75%）

### 本轮发现的四个问题（按处理优先级）

1. **【Agent 报告的硬伤】数字与自己的证据表冲突。** 报告在根因段写「5xx 从 **8.75%** 跃升到
   41.46%」，处置建议写「把 5xx 从 41% 压回 ~8.75%」。但它自己的 §7 明明写着
   「此前无样本（无 5xx 序列 ⇒ 0%）」——**故障前是 0%**，8.75% 是它把 30s 步长序列**衰减的
   尾部**误读成了基线。根因结论不受影响（触发源/机制/排除发布都有独立证据），但这个数字
   出现在**处置建议**里（回滚 timeout 后应该是 0%，不是 8.75%，因为 `order 2` 已移出负载）。
   **这类「结论数字与证据表不一致」正是本项目要防的失败模式，出现在自己的报告里。**
2. **【越界读取，Agent 主动声明了】** 只读 CLI 没有「生效运行时配置」通道（`actuator env` /
   `configprops` 全掩码），Agent 于是用了 `docker inspect` + `stat`/`cat incident/.env`。
   它在「跳过的步骤及原因」里明确声明了这点，没有隐瞒——但**通道越界本身是缺口**。
   另外 `incident/.env` 是 gitignore 的，但**在仓库目录里可读**，等于把「故障旋钮写成了明文」。
   下轮应把 env 文件挪到仓库外（`docker compose --env-file /tmp/xxx.env`）。
3. **【实验台坑】** `docker compose up <service>` 会**顺带重建依赖服务**并按**默认值**回填环境变量
   ——本轮两次因为这个把 `LOAD_PATHS` 打回默认（含 `order 2`），凭空造出两次假故障。
   已用 `incident/.env`（compose 自动读取）把旋钮固化，但**每次 compose 调用仍要带完整 env**。
4. **【实验台缺口】** `docker-compose.yml` 新增了 `SPRING_DATASOURCE_HIKARI_CONNECTION_TIMEOUT`
   透传（默认 30000 = Hikari 原值，行为不变），用于复现连接池耗尽；这是本轮唯一改过的 compose 行。

## 跑通步骤（F4 对照组）

```bash
cd /mnt/my-work/ai_coding/study/miniclaw-main/miniclaw-main

# 0. 确认 agent-runner 已构建
ls container/agent-runner/dist/pi-index.js

# 1. 确认实验栈在跑
cd incident && ./lab.sh ps && cd ..

# 2. 起 Miniclaw（没在跑的话）
node dist/index.js

# 3. 重建 cookie → 发消息 → 取 agent_reply
node incident/runs/mc-auth.mjs > /tmp/mc-cookie.txt
node incident/runs/ws-run.mjs "web:8ff36e4b-e8da-4dfd-be0a-b55d70fd9edb" \
     incident/runs/diag-prompt.txt
```

Agent 文本在 `agent_reply` 事件里，不在 `message`/`stream` 里——这个坑踩过一次。
`ws-probe.mjs` 把 `agent_reply` 全文累积并写到 `/tmp/agent-out.txt`；`ws-run.mjs` 只逐条打印
事件（每条截断 220 字符），排查事件流时用它。

> chatJid `web:8ff36e4b-e8da-4dfd-be0a-b55d70fd9edb` = 工作区「incident-lab」，
> `custom_cwd` 指向 `incident/workspace`（host 模式），所以 Agent 的 cwd 就是那个隔离仓库。
> 若工作区被重建，JID 会变，用 `GET /api/groups` 重新查。

**重放对照组的完整配方**（三段式，约 25 分钟，见上节设计；
**2026-10-27 07:27Z 那一轮就是照这个跑的**，只多了 §「复跑前做了什么」里的去泄漏与同步步骤）：

> ⚠️ 所有 compose 调用必须走 `incident/lab.sh`。裸跑 `docker compose` 会在找不到
> `.env` 时**静默把旋钮重置成 compose 里的默认值**——那等于凭空造出一次故障。
> `lab.sh` 强制 `--env-file`，缺文件直接报错退出。

```bash
cd incident

# 0. 旋钮文件必须存在
ls ~/.config/miniclaw-lab/lab.env

# 0.5 【2026-10-27 新增】复跑前必须做的去泄漏 + 同步（顺序不能颠倒）
cd ..
node incident/runs/memory-de-leak.mjs      # 工作区记忆：lesson 去结论、open_loop 作废+清正文
node incident/runs/sync-skills.mjs          # incident/skills/*/SKILL.md → data/skills/<userId>/
node incident/runs/sync-agent-profile.mjs   # incident/agent-profile/identity.json → agent_profiles 表

# 0.6 【2026-10-27 新增】开跑前的最后一道闸：扫 Agent 可读面上有没有残留的答案
#     扫五个面：服务仓库工作树 + git 历史、工作区记忆、运行时 Skill、Agent Profile
#     必须 0 命中。
#     ⚠️ 必须在**仓库根目录**跑（它用相对路径定位工作区、从 CWD 找数据库）。
#        跑错目录现在会 exit 1 并明确报出「不能报告 0 命中」及是哪个面没扫到。
#     ⚠️ 它**没有真正覆盖软删行**（listWorkspaceMemory 过滤了 status='deleted'），
#        tombstone 正文靠 0.5 步的 memory-de-leak.mjs 兜底。
#     ⚠️ 聊天历史**不在扫描面里**——上一轮冒烟测试留在 incident-lab 群里的那条消息
#        必须在开跑前清掉。
node incident/runs/leak-scan.mjs
cd incident

# 0.7 【2026-10-30 新增】如果仓库路径搬过家，先跑一遍「搬家后的验收清单」
#     （见上文「搬家造成的静默损坏」一节）：lab.sh ps / 挂载源 / app.log 是否在长 /
#     prometheus targets+rules / order1=200 & order2=500。
#     5 处静默损坏里有 3 处不会自己暴露——容器 healthy、日志文件还在但不增长，
#     只看「服务起没起来」发现不了。
./lab.sh ps

# 1. F2 缺陷已注入并已部署（服务仓库 HEAD = 072d275，其中服务源码仍是 3ca923c 那版，
#    镜像里带该缺陷：curl /api/orders/2 返回 500 NPE）。当前任务是让它「静默」——
#    order 2 不在 LOAD_PATHS 里 → 零异常。
#    只有把服务仓库退回基线时才需要重新注入（重复注入会报
#    "baseline text not found (already injected?)"）：
#    node faults/faults.mjs inject F2

# 2. 部署「静默版」（--no-deps，不顺带重建依赖服务）
./lab.sh recreate target-service

# 3. 等 >15 分钟，让提交落到窗口外

# 4. 只改一个旋钮 → 触发
sed -i 's/^DOWNSTREAM_TIMEOUT_MS=.*/DOWNSTREAM_TIMEOUT_MS=1/' ~/.config/miniclaw-lab/lab.env
./lab.sh recreate target-service

# 5. 等告警 firing（约 90 秒）→ 跑 Agent

# 6. 跑完把实验台恢复健康（否则下一轮会被上一次的故障态污染）
sed -i 's/^DOWNSTREAM_TIMEOUT_MS=.*/DOWNSTREAM_TIMEOUT_MS=2000/' ~/.config/miniclaw-lab/lab.env
./lab.sh recreate target-service
```

> ⚠️ **第 6 步别漏。** 10-27 那一轮跑完后实验栈一直停在故障态（旋钮 = 1），
> 我做复核时 5xx 比例还在 0.01–0.05 漂着。复现实验前务必先把旋钮调回 2000 再重建。

## 存档：暂缓执行的两项（2026-10-26 18:30 归档；第一项已于 2026-10-27 07:27Z 完成）

| 项 | 当前状态 | 恢复入口 |
| --- | --- | --- |
| ~~**通道合规复跑 + transcript 审计**~~ | **✅ 已完成（2026-10-27 07:27Z）**：改旋钮 → 重建容器 → 跑 Agent → 逐条审 transcript → 独立复核。四条标准 4/4、零越界；**取证环境残留 1 处非承重提示**（复核件 §7），已披露并修复。产出物与复核件见上文「F4 对照组复跑」一节。 | — |
| **F5（连接池类故障）重定义** | 按原定义不可观测（详见下节实测）。`incident/faults/load-hammer.mjs` 已写好。 | 见下节「F5 需要重定义」 |

**约束**：F5 重定义完成前，简历里 101/102 的取证口径说明**不得删除**。
但要注意 101/102 的披露内容**已经变了**：
10-26 那一轮说「证明的是结论正确、流程跑通，不是取证过程干净」；
**10-27 这一轮是清掉泄漏之后跑的**，所以披露要改成「复跑 + 报告里仍有 4 处数字问题主动列出
+ 取证环境残留 1 处非承重提示」——不是把旧的披露整段删掉，也不是假装没有问题，
更不能写成「无泄漏环境」（复核件 §7 查出了残留）。
⚠️ 复核件 §7 之后口径又变了一次：**下一轮开跑前必须重建服务仓库历史并让
`leak-scan.mjs` 0 命中**，否则那条披露还得继续挂着。

### 已处理：工作区仓库的 dirty 状态（2026-10-27 已提交，随后又换链一次）

原先 `incident/workspace/tools/incident-readonly.mjs` 相对它自己的 HEAD（当时的 `409d265`）
是 **modified**——就是「`git file` 路径越界」那处修复：外层仓库已提交，Agent 实际用的那份改了但没提交。

麻烦在于 `$LAB git diff <sha>` 比的是**提交 vs 工作区**，所以复跑时它会把这个工具文件的改动
一起带进 diff 输出，Agent 可能把它读成「窗口内有代码变更」——而 F4 对照组正是靠
「窗口内无代码变更」来排除发布假设的。

**已选方案 (b)：在工作区仓库提交这个修复**，提交 `e87d06f`（2026-10-27 换链后为 `8061f59`，
2026-10-30 再换链后为 `072d275`）。

| 项 | 结果 |
| --- | --- |
| 工作区是否干净 | 是，`git status` 无输出 |
| 提交动了什么 | 只有 `tools/incident-readonly.mjs`；`target-service/` 一行未动 |
| 服务源码 | 仍是 `3ca923c` 那版（换链前是 `409d265` / `35854c8`），F2 缺陷照旧在镜像里 |
| 提交日期 | 回填为文件真实写作时间 **2026-10-26T07:29:26Z**（mtime），不是提交当天——否则新提交会紧贴提交当天，复跑时可能被读成「窗口内有代码变更」 |
| 「最近一次提交」 | 变成 `072d275`（旧链 `8061f59`）。对 F4 判定**无影响**：复跑无论何时发生，它都远在 15 分钟窗口之外，「窗口内无代码变更」这条前提仍然成立 |
| `Δ=20.6 分钟` | 那是 10-26 04:29Z 那一轮对当时 HEAD 算出的历史事实，**不改**。新一轮复跑按新 HEAD 重算 Δ，取届时的新值 |
| **10-27 复跑实测的 Δ** | `8061f59` / `35854c8` 都在 2026-10-26，距 T_err **23h54m44.6s**（换链前后作者时间都没变；10-30 重建同样原样保留时间戳） |

提交正文里没有任何泄漏实验台身份的信息（不出现 agent / 诊断 / 故障 / F2 / 实验台字样），
Agent 看到的是一条只动 `tools/` 的普通修复提交。

## 已完成（别重做）

这几项曾列在待办里，实际早已落地，不要再当待办排期：

| 项 | 落地形态 | 位置 |
| --- | --- | --- |
| **只读 CLI 的 runtime-env 通道** | `$LAB runtime env` 吐实验台那几个旋钮的生效值 + 旋钮文件 mtime；`$LAB runtime started` 吐容器重建时刻与应用就绪时刻。工具内部调 `docker inspect`，所以从 Agent 侧看整条链仍留在通道内。 | `incident/tools/incident-readonly.mjs`（`case 'runtime'`）；`incident/agent-profile/identity.json` 的 `tools_prompt` 已把这两条命令写给 Agent |
| **旋钮文件挪出仓库** | 旋钮在 `~/.config/miniclaw-lab/lab.env`（chmod 600），仓库内已无 `incident/.env`；`incident/lab.sh` 强制 `docker compose --env-file` | `incident/lab.sh`、`incident/lab.env.example` |
| **服务仓库历史去泄漏并换链** | 2026-10-27 换链一次（`83c26bf / d306ad3 / 35854c8 / 8061f59`），2026-10-30 **再次重建**（`a9c8957 / 46ea5d5 / 3ca923c / 072d275`）。旧链存档在 `~/incident-lab-archive/service-repo-pre-rebuild.bundle`，旧 SHA 仍可解析 | `incident/workspace/`（独立仓）；`incident/runs/rebuild-service-history.mjs` |
| **工作区记忆去泄漏** | `lesson` 改写成只留方法；`open_loop` 作废 + tombstone 正文清空 | `incident/runs/memory-de-leak.mjs` |
| **Skill / Profile 同步回运行时** | 改了源不同步 = Agent 还在用旧契约 | `incident/runs/sync-skills.mjs`、`incident/runs/sync-agent-profile.mjs` |
| **通道合规复跑 + transcript 审计** | 4/4、零越界；**残留 1 处非承重提示**（`data.sql` 种子注释，Agent 于 07:31:42Z 读到并引用，不承重）；复核件 `runs/audit-2026-10-27T0727Z.md` §7。**该残留已于 2026-10-30 通过重建历史清掉** | `incident/runs/agent-report-2026-10-27T0727Z.md` + transcript |
| **答案泄漏扫描闸门** | 扫 Agent 能读到的五个面（服务仓库工作树 / 完整 git 历史 / 工作区记忆 / 运行时 Skill + Agent Profile），命中即 exit 1。**2026-10-30 起 0 命中**（必须在仓库根目录跑；软删行与聊天历史不在扫描面内，见上文「当前门禁状态」） | `incident/runs/leak-scan.mjs` |
| **仓库搬家后的静默损坏修复** | 5 处（compose 挂载路径 / `app.log` 属主 / `custom_cwd` / mount allowlist / identity.json 里的绝对路径）全部定位并修复，附验收清单 | `incident/RESUME.md`「搬家造成的静默损坏」一节 |

## 还没做的

- **【2026-10-30 07:00Z 已解除】模型额度**：MiniMax 额度已恢复，provider 切回
  MiniMax-M3，F2 轮已开跑（manifest 的 `provider` 字段记录本轮模型）。
  若以后改用「中转deepseek」，已跑的 F4 轮次必须一起重跑才可比。
- **【2026-10-30 新增，每轮开跑前必须核】清掉聊天历史**：本轮的 Agent 冒烟测试
  在 `incident-lab` 群（`web:8ff36e4b-e8da-4dfd-be0a-b55d70fd9edb`）里留了一条消息。
  聊天历史**不在 leak-scan 的扫描面里**，所以扫描 0 命中不代表它干净。
  `POST /api/groups/:jid/clear-history` 会**一并清掉 Workspace Memory 和工作目录**——
  清完必须重跑 `memory-de-leak.mjs` → `sync-skills.mjs` → `sync-agent-profile.mjs`，
  再跑一次 `leak-scan.mjs` 确认还是 0 命中。
  **【2026-10-30 复核 0738Z】这一面本轮是干净的**，两条独立证据：
  ① `messages` 表里该 chat 只有 2 行（07:55:33 本轮提问、08:07:11 本轮回答），
  开跑前没有任何历史；② Agent transcript 的 `<messages>` 块只有当轮一条。
  但这**不是自动闸门**——runner 不会替你检查，下一轮仍要人工核这两处。
- **【新增】leak-scan 还剩两个覆盖缺口**（见上文「当前门禁状态」）：
  ① 软删行不在扫描范围内（靠 `scrubTombstone` 兜底，脚本头部注释已改正）；
  ② 聊天历史完全不扫。
  「跑错目录会静默跳过」那个缺口本轮已修（现在 exit 1）。
  剩下这两个要么补进扫描器，要么写进每轮的开跑前清单。
- **【新增】F5 需要重定义**：按原定义（只调 `DB_POOL_SIZE`）在本实验台不可观测。
  可选方向：把连接获取超时纳入 F5 定义 + 配套负载发生器（`incident/faults/load-hammer.mjs`
  已写好），但 Hikari 250ms 下限决定了失败率只能在 0.5% 量级，**达不到 5% 告警阈值**——
  要么改告警阈值做专项演练，要么放弃 F5 走别的资源类故障。
- **【新增】底座 `forget` 不过滤 `get` 的 status**：`forgetWorkspaceMemory` 只置
  `status='deleted'`，`search` 会过滤掉它，但 `getWorkspaceMemory` 不过滤——
  拿着 id 仍能取回原文。本轮靠额外清空 tombstone 正文绕开，**底座本身该修**。
- **【新增】FTS5 trigram 短语匹配的全局排查**：底座检索用 `ftsPhrase(query)`，
  查询串必须是原文里**连续的一段**。已改 `historical-incident-lookup` 的示例（commit `0cb8033`），
  但其它 skill / 提示词里可能还有堆关键词的检索式，**全局还没查**。
- **只读 MCP 工具通道**（`pending`）。CLI 通道已经验证可用且够用，MCP 封装一直没做，
  因为 Pi SDK 的 MCP 兼容性和 `@modelcontextprotocol/sdk` 都不是本项目依赖。没验证之前别急着写。
- **logs 通道支持 `.gz`**（F2 那轮踩到，10-26 那轮又踩到一次：Agent 为了数「静默期 0 次 NPE」
  越过通道直接读了轮转文件）。**10-27 这一轮没有踩**——`logs` 通道已能读 `app.log.*`
  （gzip 与未压缩都读），本轮 Agent 全程没越界。
- **告警锚点口径统一**：`activeAt` = pending 时刻，firing = activeAt + `for`。
  10-27 这一轮已经按这个口径写了（且明说 `for` 值本通道不可读，不据此做任何推断）。

## MVP 缺口（2026-10-28 分析，下次先看这一节再排期）

先纠正一个容易跑偏的判断：**上面那几条「还没做的」大多是技术债，不是 MVP 阻塞项。**
按 `docs/PRD.md` §8 三周计划对表，现在的位置是 **W1 完成 + W2 的一个纵切面**，
不是「补三个小尾巴就收工」。PRD 原文：「**W2 是项目的分水岭**」。

| 计划 | 交付 | 现状 |
| --- | --- | --- |
| W1 | 栈 + 8 Skill + 只读通道，手工能走完一次诊断 | **完成**（8 Skill 全在，CLI 通道已替代 MCP 且验证可用） |
| W2 | 故障脚本 + 样本生成器 + **scorer** + 重放 runner → 完整指标表 | **部分**：故障定义只有 3 条；scorer 已有（v3 + 校准 7/7）；ground-truth 样本只有 F2/F4 两条；**新链上有效 3 轮（F2 1 + F4 2），其余轮次中止或作废** |
| W3 | 演示录制 + README + 简历素材 | 未做（简历素材另有 `overleaf` 目录，不算这周） |

### 真正的 MVP 缺口（四件）

1. **scorer**（✅ 2026-10-30 已落地，这条从缺口里划掉）。
   `incident/runs/score-report.mjs`（v3 实测）、`score-report-v1-replay.mjs`（v1 重放）、
   `rescore-all.mjs`、`calibrate-scorer.mjs`（7/7 + 一条负对照）、`round-table.mjs`（指标表）。
   判据口径 v3 见上节；**判据每改一次都要重跑校准 + 全量重打分**，这是已定的纪律。
2. **样本生成器 + 重放 runner**（部分）。ground-truth 只有
   `incident/runs/ground-truth/{F2,F4}.json` 两条，字段比 PRD §3.3 的
   `{sample_id, alert, symptom, injected, ground_truth}` 更细（按 C/D/Q 分组存正则判据），
   但**没有生成器**——每条样本仍是手工写的。重放方面 `score-report-v1-replay.mjs`
   能重放旧判据、`run-round.mjs` 能重跑整轮，但「读样本 → 自动跑 → 出指标」的闭环还没有。
3. **故障库 3 → 8**。当前 `incident/faults/faults.mjs` 只有 F2（代码）/ F4、F5（运行时）。
   缺 F1（缺索引慢 SQL）、F3（`@NotNull`）、F6（Redis 断连）、F7（OOM）、F8（配置改错）。
   其中 **F1 / F5 / F6 正是"测过度归因到发布"的那三类**——缺了它们，
   这个项目最核心的论点（SOP 存在过度归因偏置）就没有数据支撑。
4. **缺干净复跑（样本量还不够）**。10-26 的 F2 轮有泄漏且无干净版。
   **【2026-10-30 更新】闸门侧已经补齐**（历史重建 + leak-scan 0 命中），
   新链上已有 **3 轮有效证据**：
   - F2 `0738Z`：准确率 **1.0（hit）**、发布归因 **relevant · correct**、
     Q1–Q4 全 PASS、通道污染 **0**、leak-scan **0 命中**，有独立复核件；
   - F4 `0423Z` / `0431Z`：v3 **1.0 / excluded**、通道污染 **0**（越界 2 / 1），
     **尚无独立人工复核**（只有自动评分 + 通道审计）。

   但这不等于「干净证据已经齐了」，两点必须一起说：
   - 0738Z 的报告本身不完美：复核件记了 **5 处数字问题**（1 处硬错 D1、4 处过度声称/错位 D2–D5），
     分数不受影响是因为根因与归因判断正确，不是因为报告没毛病；
   - 样本量仍不够：F2 只有 1 轮，F4 两轮未经人工复核，F1/F6 还没跑。

   所以第 4 项的状态从「环境干净但没跑」变成「**新链上跑了 3 轮，样本量与复核深度还不够**」。
   复核件：`runs/audit-2026-10-30T0738Z.md`。

### 建议把 MVP 重定义为「3–5 条故障 × 各 2 次 × 有 scorer × 有指标表 × 干净取证」

不是 8×3。理由：

- **成本**：单轮 ≈ 重置 + 注入 + 部署 + 等告警（>15 min）+ 跑 Agent（~30 min）≈ 1 小时。
  8×3 = 24 轮是两天纯等待，还没算失败重跑。
- **3 条就够立论**：F1（该跳过发布归因）+ F2（变更类，该归因）+ F6（非代码变更，该跳过 git），
  正好覆盖「会不会过度归因」的三种情形，比 8 条平均分更有说服力。
- **scorer 不需要复杂**：30 行读 `ground_truth` + 报告打分即可。

### 收尾顺序（约 5 天）

```text
1. 重建服务仓库历史 → leak-scan 0 命中            （✅ 2026-10-30 已完成）
2. 清掉聊天历史 + 跑一次完整 smoke                 （✅ 2026-10-30 已完成：0738Z 前该 chat 无历史）
3. 写 scorer                                       （✅ 2026-10-30 已完成：v3 + 校准 7/7 + 负对照）
4. 写 sample 生成器 + replay runner                （未做；ground-truth 只有手工写的 F2/F4）
5. 补 F1 / F6 两条故障定义                          （未做）
6. 跑 3 故障 × 2 次 = 6 轮                          （进行中：F2 1/2、F1 0/2、F6 0/2；另有 F4 对照 2 轮已在同一新链上跑通，不计入这 6 轮）
7. 出指标表 + 结论                                  （表已能出：`round-table.mjs`；结论还缺样本量）
```

第 2 步不是一次性的：聊天历史**不在任何闸门的扫描面里**，每轮开跑前都要重核
（0738Z 核过：该 chat 开跑前 0 行历史）。`POST /api/groups/:jid/clear-history`
会一并清掉 Workspace Memory 和工作目录，清完要重跑
`memory-de-leak.mjs` / `sync-skills.mjs` / `sync-agent-profile.mjs`。
底座 `forget` 缺陷已用 `scrubTombstone` 绕开、只读 MCP 通道已被 CLI 通道等效替代，
两者都可以挂账不阻塞 MVP——写简历时口径改成「只读 CLI 通道」即可，不要写成 MCP。

## 简历包状态

`claim-incident-101`（F2 正例）与 `claim-incident-102`（F4 对照组 / 过度归因防护）
路径 `/home/fs-user/Desktop/文档/overleaf/miniclaw_incident相关/claim-ledger.json`。

**【2026-10-26 18:xx 本人决定】两条均已放行到 `resume_draft` / `resume_final`**，
放行条件是把各自的取证口径说明写进同一条简历表述。成稿见
`paste-ready-当前可贴.md`（5 条，直接贴）与 `paste-ready-最终版.md`（同样 5 条 + 复核记录 + 禁写清单）。

**【2026-10-27 更新】102 的主证据换成清过泄漏的那一轮复跑**（10-27 07:27Z 报告 + 复核件），
`last_verified` 改为 2026-10-27。101 的证据仍是 10-26 02:22Z 那一轮
（F2 正例轮没有清过泄漏的复跑版本，**披露不变**）。

**【2026-10-30 更新】101 的主证据已切换到干净链复跑**：F2 `0738Z`
（新链、leak-scan 0 命中、准确率 1.0 hit、发布归因 correct、通道污染 0），
复核件 `runs/audit-2026-10-30T0738Z.md`。**本人决定切换**，台账已改（仓库外文件）：
`claim-ledger.json` 的 101 现在以 `agent-report-2026-10-30T0738Z.md` +
`audit-2026-10-30T0738Z.md` 为主证据，10-26 那轮降为历史证据（其披露不删）。
披露同步换成「干净链 + 报告 5 处数字问题（D1 硬错、D2–D5 过度声称/错位）
+ 实验室侧 L1（观察窗内有前几轮容器活动，因历史改写而无法自证）+ 9 次越界读取（零污染）」。
连带改了 003（「三轮零越界」→「多轮无写动作 + 越界逐条披露」）与 002（「三轮」→「四轮」）。
`paste-ready-最终版.md` / `paste-ready-当前可贴.md` / `paste-ready-审计区.md` /
`agent-project-model.json` 已同步，`validate_resume_package.py` 校验通过。

披露口径随之调整（不是删掉旧披露，是换成新披露）：

| claim | 旧披露 | 新披露 |
| --- | --- | --- |
| 101 | 取证环境有答案泄漏 → 只能说「流程跑通」 | **换成干净链 0738Z**：报告 5 处数字问题（D1 硬错 + D2–D5 过度声称）+ 实验室侧 L1（观察窗混有前几轮失败注入的活动）+ 9 次越界读取（零污染）；10-26 那轮的旧披露保留为历史证据，不删 |
| 102 | 取证环境有答案泄漏 + 一个自相矛盾的数字 + 两次越界 | **清过泄漏后的复跑 + 报告里仍有 4 处数字问题（1 处硬错、3 处过度声称）+ 取证环境残留 1 处非承重提示**，全部主动列出 |

> **【2026-10-30 待办】台账里有一句现在变成假话了，必须改**：
> `claim-ledger.json` 中 `claim-incident-102` 的披露写着「**git 历史里那半句仍在**」——
> 这一句描述的是 10-27 的状态（当时取舍是保住复核件引用的 SHA，只披露不修）。
> **2026-10-30 已经把整条链重建，历史残留清零**（旧链存档在仓库外，旧 SHA 仍可解析）。
> 披露要改成「残留已修 + 怎么修的 + 旧链仍可审计」。
> ⚠️ 但**不要顺手把披露整段删掉**：10-27 那一轮的取证环境确实不干净，
> 报告里确实有 4 处数字问题——这些是历史事实，不因为环境后来修好了就消失。
> 正确写法是「该轮的残留已披露；残留本身已于 10-30 修复，但**该轮证据仍在历史环境里取得**」。
> 另外 101 的证据**已于 2026-10-30 切换**到干净链复跑（见上一节的【2026-10-30 更新】），
> 披露已同步换成新版。10-26 那一轮的泄漏**没有**被修掉覆盖过（修的是当前环境），
> 所以那一轮作为历史证据保留时，它的旧披露一个字都不能删。

`agent-project-model.json` 里对应的 artifact 已同步为 `Implemented`（`artifact-incident-007`，
`agent_layer: Eval`），避免台账自相矛盾；`coverage.eval` 由 `absent` 改为 `weak`
（有对照组实测，但完整八类故障指标表仍未跑）。

> 顺带修掉三处**台账自相矛盾**——它们不是新写的，而是上一轮把 artifact 从 `Design-only`
> 翻成 `Implemented` 时漏改的 `source_fact` / `boundary` / `risk_notes`：
> `claim-incident-002` 仍写「仓库中尚无任何 SKILL.md」、`claim-incident-003` 仍写「方案尚未搭建」、
> `claim-incident-001` 仍写「项目处于设计完成、编码未开始阶段」。审计时这三条会直接与
> artifact 注册表打架。三条已改为「本条只保留设计判断本身，实现与实测口径以 101 为准」。

> ⚠️ 对外引用时的口径纪律：这两轮**都不能**说「Agent 完美排除了所有误判」。
> 10-26 那轮的准确说法是「四条判定标准 4/4 通过，同时报告里有一个与自己证据表冲突的数字、
> 两次越过只读通道、取证环境有答案泄漏」。
> 10-27 那轮的准确说法是「四条判定标准 4/4 通过，通道零越界，但报告里仍有一处时间差算错
> （20h55m vs 23h55m）与三处过度声称，且取证环境残留 1 处非承重的答案提示，全部主动列出」。
> **不要说「无泄漏环境」**——复核件 §7 就是反例。主动写出缺陷比藏起来更经得起追问。
>
> **【2026-10-30】环境现在是干净的（leak-scan 0 命中），并且已在新链上跑通第一轮**。
> 但"干净"**不能倒推到 10-26 / 10-27 那两轮已取到的证据上**——那两轮取证时环境不干净，
> 这是历史事实，不因为环境后来修好而消失。
> 现在对外可以说的是两句：
> 1. 「**闸门已经建好并通过**」——可复现的 leak-scan + 历史重建 + 旧链存档（仓库外，仍可审计）；
> 2. 「**已在新链上完成一轮正例诊断**」——F2 `0738Z`，准确率 1.0、发布归因 correct、
>    通道零污染；**同时**报告里有 5 处数字问题、复核件记了 1 处取证面缺陷（L1 历史改写残留），
>    全部主动列出（`runs/audit-2026-10-30T0738Z.md`）。
>
> 仍然**不能说**「本项目在无泄漏环境下完成了诊断评测」：
> 新链上只有 3 轮有效（F2 1 + F4 2），F4 两轮还没有独立人工复核，F1/F6 没跑。
> 把这句话变成真的，是收尾顺序里的第 6 步（在新链上跑 6 轮）。
