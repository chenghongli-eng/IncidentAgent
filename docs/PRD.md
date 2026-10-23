# IncidentAgent — 线上故障诊断 Agent（作品集版）

> 目标：投 **AI 应用岗位**的作品集项目
> 底座：Miniclaw（fork，MIT）
> 日期：2026-10-23

---

## 1. 项目定位

一句话：**把资深工程师脑子里的故障诊断 SOP，固化成一组可复用的 Agent Skill，并用故障重放量化它的准确率。**

演示形态：故意搞坏一个真实运行的 Spring Boot 服务 → 告警触发 → Agent 走完 SOP →
输出带证据链的根因报告 → 人工确认。

---

## 2. 与 Miniclaw 的边界

> 简历上必须说清楚哪些是自己的贡献，否则一搜就露。

| 能力                                                            | 来源              | 说明                     |
| --------------------------------------------------------------- | ----------------- | ------------------------ |
| 多渠道接入、流式卡片、调度、计费、Workspace/Session/Memory 体系 | **Miniclaw 提供** | 不是本项目贡献，简历不提 |
| **SOP 拆解为 Skill 库**                                         | 本项目            | 核心产出                 |
| **故障注入 + 重放评测集**                                       | 本项目            | 核心产出，差异化         |
| **只读工具边界设计**                                            | 本项目            | 核心产出                 |
| **Agent 诊断报告的输出契约**                                    | 本项目            | 核心产出                 |
| Prompt 架构（骨架进 Prompt、细节进 Skill）                      | 本项目            | 核心产出                 |

---

## 3. 目标服务与故障注入

### 3.1 技术栈

```
Docker Compose:
  target-service     Spring Boot + Actuator，暴露 /actuator/prometheus
  prometheus         抓取 target-service
  alertmanager       规则：5xx 错误率 > 5%、P99 > 2s
  grafana            看板（可选）
```

日志不接真实日志平台 —— **stdout 重定向到文件，Agent 直接 grep**。省掉一整个系统，
但诊断能力完全不受影响。

> 不引入 K8s。PoC 阶段 Docker Compose 足够，`kubectl` 相关 Skill 推迟。

### 3.2 故障注入清单

这是整个项目的地基：**每种故障都是我自己注入的，所以真值 100% 已知、可无限复现、
难度可控、任何人都能跑一遍。**

| ID  | 故障         | 注入方式                       | 有 commit | 考点                       |
| --- | ------------ | ------------------------------ | --------- | -------------------------- |
| F1  | 缺索引慢 SQL | 删掉 `create_time` 索引        | 是        | **不该乱归因到发布**       |
| F2  | NPE 引发 5xx | 新增可能为 null 的调用不判空   | 是        | 变更关联                   |
| F3  | 必填参数校验 | 新增 `@NotNull` 校验           | 是        | 变更关联                   |
| F4  | 下游超时     | 调小 RestTemplate timeout      | 是        | 配置类变更                 |
| F5  | 连接池耗尽   | HikariCP `maximum-pool-size=2` | 是        | 资源类，**不该归因发布**   |
| F6  | Redis 故障   | 运行时断开 Redis               | 否        | 外部依赖，**不该归因发布** |
| F7  | 内存泄漏 OOM | 缓存无界增长                   | 是        | 资源类                     |
| F8  | 配置项改错   | 运行时改配置                   | 否        | **非代码变更**             |

**6 个代码变更 + 2 个运行时变更**，这个比例是刻意的：用来测 Agent 会不会**过度归因到
最近一次发布**。这是这类 Agent 最常见的失败模式。

> **注入必须带 commit。** 变更类故障要真的 `git commit` + 重新部署，否则 Agent 的
> Deployment / Git Diff 步骤无物可查。F6/F8 故意不 commit —— 那是用来验证 Agent
> 能不能处理非代码变更的。

### 3.3 样本 schema

由注入脚本自动生成（结构沿用初始 mock 数据）：

```json
{
  "sample_id": "F2-run01",
  "alert": {
    "title": "target-service 5xx错误率>5%",
    "severity": "critical",
    "service": "target-service",
    "starts_at": "2026-10-20T14:20:00+08:00"
  },
  "symptom": "下单接口大量500，用户下单失败",
  "injected": {
    "fault_id": "F2",
    "commit": "a234bc5",
    "injected_at": "2026-10-20T14:18:00+08:00",
    "file_changed": "src/.../OrderHandler.java"
  },
  "ground_truth": {
    "root_cause": "新增调用未判空，null 触发 NPE",
    "expected_evidence": ["NullPointerException", "commit a234bc5"],
    "skipped_steps": []
  }
}
```

`ground_truth` 全段**只给 scorer，永不进 Agent 上下文**。早期 mock 版本把
`key_log_snippet`、`related_deployment` 放在输入里 —— 那是泄漏答案，会让评测失效。

---

## 4. SOP 设计

### 4.1 八步流程

```text
Alert → Metrics → Logs → Deployment → Git Diff
      → Historical → Root Cause → Mitigation
```

**SOP 是有序默认路径，不是硬编码流水线：**

- 证据充分可提前收敛，不必走完
- 步骤可跳过，但**必须显式说明跳过了哪步、为什么**
- **走完流程 ≠ 可以宣布根因**
- 每个根因假设**必须有至少一条证据支撑**；证据不足时输出"证据不足"，不猜

### 4.2 每步的 Agent 价值

| 步骤       | Agent 做什么                                                    | 人现在要做什么        |
| ---------- | --------------------------------------------------------------- | --------------------- |
| Alert      | 解析、定服务定严重级                                            | 看一眼                |
| Metrics    | 查告警指标 + 周边，判断异常形态（尖刺/台阶/缓慢增长），圈影响面 | **切 Grafana 拼查询** |
| Logs       | 检索错误模式，**定位首次出现时间点**                            | **切日志平台拼查询**  |
| Deployment | 查最近部署/重启时间与版本                                       | 查发布记录            |
| Git Diff   | 取部署窗口内 commit 与 diff，标注风险点                         | **翻 GitLab 翻 diff** |
| Historical | 召回 Workspace Memory 里的历史同类故障                          | 问老同事 / 翻 Jira    |
| Root Cause | 综合证据，输出假设 + 置信度 + 支持/反对证据                     | —                     |
| Mitigation | 给出处置建议与回滚方案（**只建议，不执行**）                    | 执行                  |

中间三行加粗的是当前人工切换最烦、最值得固化的部分。

---

## 5. Skills 架构

### 5.1 设计原则

| 原则                        | 做法                                                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 骨架进 Prompt，细节进 Skill | AGENTS 段只写 8 步流程和跳步规则；查询语法、判断启发、输出格式全在 SKILL.md                                      |
| Skill 懒加载                | 底座扫描时只读 frontmatter（name/description），正文按需展开 —— 8 个 Skill 的正文塞进 system prompt 会挤爆上下文 |
| 一个 Skill 一件事           | 不做"大而全的排查 Skill"                                                                                         |

### 5.2 Skill 清单

| Skill                        | 职责                           | 关键判断启发                                              |
| ---------------------------- | ------------------------------ | --------------------------------------------------------- |
| `alert-triage`               | 解析告警，定服务/严重级/时间窗 | payload 缺关键 label 时降级并声明                         |
| `metric-triage`              | 查告警指标 + 周边指标          | 尖刺→突发变更；台阶→配置或发布；缓慢增长→资源耗尽         |
| `log-triage`                 | 日志检索与错误模式分类         | **首次出现时间是最有价值的锚点**，用于对齐部署窗口        |
| `deployment-window`          | 查最近部署/重启时间与版本      | 部署时间 < 告警时间 ≤ +15min → 高度相关                   |
| `git-diff-analysis`          | 部署窗口内的 commit 与 diff    | 重点看改动模块是否在异常调用链上                          |
| `spring-diagnostics`         | Actuator 诊断                  | `/actuator/health`、`/threaddump`、`/env`、`/configprops` |
| `historical-incident-lookup` | 召回 Workspace Memory 历史故障 | 按服务 + 症状关键词检索                                   |
| `root-cause-report`          | 输出结构化根因假设             | 必须列出已排除的假设及排除依据                            |

### 5.3 底座能力对应

| 需要什么                         | Miniclaw 现成的                                  |
| -------------------------------- | ------------------------------------------------ |
| Skill 懒加载、manifest hash 失效 | `src/effective-skill-resolver.ts`                |
| Agent 身份与 Prompt 四段         | AgentProfile（IDENTITY / SOUL / AGENTS / TOOLS） |
| 历史故障知识按服务隔离           | Workspace Memory（`lesson` 类型，带 provenance） |
| 故障间上下文不串                 | 一个 Session = 一次故障                          |
| 人机协作、中途接管               | Session 持久化 + follow-up 注入                  |

---

## 6. 只读边界

**PoC 阶段不给任何写凭据。** Agent 只诊断、不执行。

| 通路                      | 给什么     | 能力                               |
| ------------------------- | ---------- | ---------------------------------- |
| Prometheus MCP            | 只读 token | 只能 query，**物理上不存在写接口** |
| Git                       | 只读 token | 只能 log/diff/show                 |
| 日志文件                  | 读权限     | 只能 grep                          |
| Actuator                  | HTTP GET   | health / threaddump / env          |
| ~~kubectl / docker exec~~ | **不给**   | —                                  |

理由：安全边界建在**接口层**而不是 prompt 层。只读 MCP 根本没有写这个动作，
所以不存在"Agent 忘了别写"的可能。底座自带的 `security-rules.md` 红线是 prompt 软约束，
对一个本来就有生产权限的系统不够 —— 这是个值得在面试里讲的判断。

**Mitigation 只输出命令草案，不执行。**

---

## 7. 评测方案

### 7.1 三个指标

| 指标                    | 定义                                        | 说明                   |
| ----------------------- | ------------------------------------------- | ---------------------- |
| **Root Cause Accuracy** | 命中 1.0 / 部分命中 0.5 / 未命中 0.0 的均值 | **主指标**             |
| **Tool Calls**          | 单次诊断的工具调用数，按类型拆分            | 效率与成本代理         |
| **MTTD**                | 告警 firing → 根因输出的耗时                | 与"我自己手工排查"对照 |

判定分档：

| 档位     | 标准                             |
| -------- | -------------------------------- |
| 命中     | 定位到同一模块 + 同一失效机制    |
| 部分命中 | 定位到正确模块，但未识别具体机制 |
| 未命中   | 定位到错误模块，或只复述症状     |

> PoC 全只读，所以没有 Unsafe Action Rate。留到真接生产再讲。

### 7.2 重放方式

```
for each fault in [F1..F8]:
    for run in 1..3:
        reset 容器 → 注入 fault → commit → 部署
        → 等 Alertmanager 触发
        → 喂给 Agent → 采集输出
        → scorer 对 ground_truth 打分
```

**每种故障跑 3 次**：验证可复现性，同时看输出稳定性。

**场景化指标**：按 `fault_id` 分组看准确率。预期会出现
「变更类准确率高、F1/F5/F6 这类低」—— **这本身就是有价值的结论**，
说明 SOP 存在过度归因偏置，比一个笼统的平均分信息量大得多。

### 7.3 补充语料（可选）

从目标项目的 git 历史挖真实 revert commit，做第二组测试。
好处是真实代码历史；代价是只覆盖代码变更类。**有精力再做，不是必须。**

---

## 8. 三周计划

| 周     | 交付                                                                                                                | 完成标志                                                       |
| ------ | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **W1** | Docker Compose 起栈（目标服务 + Prometheus + Alertmanager）；8 个 Skill 写完；Prometheus/日志/Git 三个只读 MCP 接好 | 在 Miniclaw Web 界面手工问，Agent 能完整走完一次诊断并给出根因 |
| **W2** | 故障注入脚本 + 样本生成器 + scorer + 重放 runner                                                                    | 跑出 8 故障 × 3 次的完整指标表                                 |
| **W3** | 演示录制 + README/架构图 + 简历素材整理                                                                             | 有一段 2 分钟的完整演示视频                                    |

**W2 是项目的分水岭。** W1 只是把 Agent 跑通（很多人停在这），W2 的量化评测才是
和 demo 拉开差距的地方。

---

## 9. 演示脚本

```
1. 展示正常状态：Grafana 曲线平稳
2. git commit 一行改动（制造 NPE），重新部署
3. 3 分钟后 Grafana 错误率飙升 → Alertmanager 触发
4. 飞书/群里 Agent 自动开始输出：
     ✓ Metrics  错误率 0.2% → 8%，QPS 正常，无发布以外的异常
     ✓ Logs     首次出现 14:20:07 NullPointerException @ OrderHandler:89
     ✓ Deploy   v1.2.0 于 14:18 上线
     ✓ GitDiff  commit a234bc5，OrderHandler.java 第 89 行新增
                 getUserInfo().getAddress() 未判空
     ✓ RootCause 置信度 0.89 —— 新增调用未判空导致 NPE
     ⚠ Mitigation 建议：回滚 a234bc5（命令草案）
5. 人工执行回滚，曲线恢复
```

**关键演示点**：故意先跑一次不注入部署的故障（F6 Redis 故障），展示 Agent
**正确地跳过了 Git Diff** 并解释原因。这一条比"每次都猜对"更有说服力。

---

## 10. 简历素材

### 推荐表述

> **IncidentAgent — 线上故障诊断 Agent**（个人项目）
>
> 基于 Miniclaw 多渠道 Agent 框架，为 Spring Boot 服务构建故障诊断 Agent。
>
> - 将 8 步故障诊断 SOP 拆解为 9 个可复用 Agent Skill，实现懒加载的能力编排，
>   避免诊断方法论挤占上下文预算
> - 设计**故障注入式评测集**：注入 8 类真实故障（含 2 类非代码变更），
>   ground truth 完全已知，构建可复现的诊断准确率基准，**Root Cause Accuracy XX%**，
>   并识别出 SOP 对"发布变更"的过度归因偏置
> - 采用**接口层只读边界**（只读 MCP 无写接口）替代 prompt 层安全约束，
>   确保诊断 Agent 在架构上不具备变更生产能力
> - 故障知识按服务隔离沉淀于 Workspace Memory，支持历史同类故障召回

> 占位符 `XX%` 必须用真实跑出来的数字替换。**面试官会追问这个数字怎么来的**，
> 所以注入脚本和 scorer 要能当场演示。

### 面试可深挖的点

| 问题                                        | 你的答案在哪                             |
| ------------------------------------------- | ---------------------------------------- |
| 为什么 SOP 要拆成 Skill 而不是写进 Prompt？ | 上下文预算 + 懒加载机制                  |
| 怎么防止 Agent 乱执行生产命令？             | 接口层只读，不是 prompt 约束             |
| 怎么证明 Agent 真的有用？                   | 故障注入评测集，不是"我觉得"             |
| Agent 在哪类故障上表现差？                  | 按 fault_id 分组的结果 —— 会看到过度归因 |
| 你在这个项目里具体写了什么？                | 第 2 节边界表                            |

---

## 11. 主要风险

| 风险                   | 影响               | 应对                                    |
| ---------------------- | ------------------ | --------------------------------------- |
| 诊断准确率低（< 50%）  | 项目说服力打折     | W1 手工验证，不达标就先调 Skill 再进 W2 |
| 只读能力不足以定位根因 | SOP 需调整         | Actuator 端点是补位手段                 |
| 底座改造过多           | 维护成本失控       | 坚持"只配置不改造"，改动需论证          |
| 只做到了 W1 的 demo    | 沦为普通 demo 项目 | **W2 评测是分水岭，不可省**             |
