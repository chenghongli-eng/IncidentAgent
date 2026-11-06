# 部署台账：把「构建号 → commit」变成机器可读

> 这份文档写于 2026-11-05。第 1–7 节是**设计**；**第 8 节的阶段 1（读侧）已经实现并
> 验证通过**（2026-11-06，控制脚本 39/39），见第 10 节；
> **阶段 2 的 registry 段（采集器）也已实现并验证**（同日），见第 12 节；
> **阶段 3 的 CI 段与 cluster 段在同一天接上了真实系统**（Jenkins 构建记录 + 集群只读），
> 见第 13 节。
> 读之前先看 `incident/REAL-TARGET.md` 的「部署台账」一节——那里是问题陈述，
> 这里是方案。

## 0. 结论先行

**采纳的判断**（用户给的）：台账的主数据源**不该是 Jenkins**，而该是
「集群里实际在跑的镜像 + Registry 的 OCI label」；Jenkins 降级成**可选富化源**
（构建结果、耗时、触发人、构建节点）；并且流水线要把**最终 image 字符串回写**一份。

这个判断是对的，理由在第 2 节。**但有一件事必须先说清楚，否则方案会落空：**

> **Registry label 这个源，今天不存在。**
> 12 个项目的 Dockerfile **全部** 0 条 `LABEL`——
> `org.opencontainers.image.revision` 谁都没写过。
> 所以「用 Registry label 做主源」不是一个"接一下就能用"的现成数据源，
> 而是一次**构建流水线的一行改动**。

由此推出本方案的核心结构：

| 事实                      | 今天就有吗 | 怎么来                                 |
| ------------------------- | ---------- | -------------------------------------- |
| 集群实际在跑的是哪个镜像  | ✅ 有      | pod 的 `imageID`（digest），k8s 直接给 |
| 这个镜像对应哪个 commit   | ❌ 没有    | **要新建**：构建时打 OCI label         |
| 集群现在跑的是哪个 commit | ❌ 没有    | **要新建**：部署时写 annotation 回写   |
| 构建号 → commit 的旁路    | ✅ 有      | Jenkins 构建历史（可作交叉校验与富化） |

**结论：台账的主键是 digest（今天就有），commit 是补上去的。**
在 label 上线之前，digest→commit 只能退到 Jenkins 或人工表——
所以「label」和「回写」两条路都要留，不是二选一。

## 1. 台账只回答一个问题

> **「Agent 现在看到的这个进程，是哪个 commit 跑起来的？」**

不是"这次部署改了什么"（那是 git 的活），
不是"谁在什么时候部署的"（那是审计的活），
不是"发布流程是怎样的"（那是人的活）。

只有第一个问题是 Agent 在诊断时真正需要的：
它要回答的是「**这个异常是不是这次发布带来的**」，
而要回答这个，就必须先把"正在跑的东西"翻译成"代码"。

## 2. 事实链，以及为什么主键是 digest

```
pod.status.containerStatuses[].imageID
    = docker-pullable://<repo>@sha256:<digest>          ← 集群侧事实：实际拉下来的那个镜像
        │
        ├─(Registry v2: GET manifest → config.digest → GET blobs/<digest>)
        ▼
    image config blob  →  config.Labels["org.opencontainers.image.revision"] = <commit sha>
        │
        ▼
    commit sha  →  git show <sha>                        ← 代码差异，Agent 用 git 通道读
```

同时有一条**冗余但可交叉校验**的支线：

```
Deployment annotation  deploy.<团队>/commit = <sha>       ← 部署侧回写：人 kubectl get 就能看到
Jenkins 构建历史        参数 GIT_COMMIT / 构建号         ← CI 侧自述：只作校验与富化
```

**为什么主键不能是构建号（tag）：**

- tag 是**可变的**。同一个 `:39` 可以先后指向不同镜像；
  回滚就是"把 tag 指回去"，从 tag 看不出现在是第几次发布。
- `imageID` 记的是**实际拉下来的那个镜像的 digest**——
  它就是"现在跑着的东西"本身，不需要任何推断。
- 时间戳推断（commit 时间 ≈ 构建时间 ≈ 部署时间）只是个 **15 分钟窗口的启发式**，
  用来判断"是不是这次发布"，不能用来确定"是哪个 commit"。
  两者别混：**窗口用于关联，digest 用于定性。**

**为什么 Jenkins 不做主源**（用户判断的补强）：

1. **CI 的自述和事实可能不一致**：构建成功但发布失败、发布用的不是这次构建的产物、
   构建后代码又变了、回滚到旧 tag。这些情况下 Jenkins 会自信地报一个错的 commit。
2. **Jenkins 的 commit 是"构建了谁"**，不是"跑着谁"。这两者只有在"发布=这次构建产物"
   时才相等——而这恰恰是需要被验证的事，不能拿它当前提。
3. Registry / k8s 侧**不需要 Jenkins 凭据**，是只读 GET，权限面更小。

## 3. 三层：采集器 / 台账文件 / 读侧

```
┌──────────────┐   联网、持凭据   ┌──────────────┐   只读文件   ┌──────────────┐
│  采集器       │ ──────────────▶ │  台账文件      │ ──────────▶ │  Agent 的      │
│ (collector)  │                 │ (仓库外, 冻结) │             │  deploy 通道  │
└──────────────┘                 └──────────────┘             └──────────────┘
   Registry v2                       append-only                 不联网
   k8s API                                                  git 通道读 commit
   (可选) Jenkins API
```

### 为什么不让 CLI 直接查 Registry

1. **实验室的第一原则是"CLI 只读、离线可复现"。**
   一个带凭据、能联网的 CLI 就是一个**可被复用的取数通道**——凭据进了 Agent 可达的范围。
2. **可复现**：一轮的结果必须能被重放。台账文件冻结 + 记哈希，
   同样的台账 + 同样的仓库 = 同样的结论。
3. **凭据边界**：采集器是唯一持凭据的组件，它在 Agent 的可达范围之外。

**代价**：台账会过期。所以每条台账必须带 `collected_at`，
且"台账过期/缺条目"必须是 Agent **看得见并必须说出来**的状态（见第 6 节）。

## 4. 台账条目

台账文件放**仓库外**（和答案键、工作区同一条规则），append-only 的 JSONL。
一行一条**观测**，不是一行一个镜像：同一个镜像部署两次是两条（各有自己的起跑时刻），
同一个镜像「被看到在跑」也是另一条。**判等看观测字段，不看 digest。**

```json
{
  "cluster": "<集群>",
  "namespace": "<命名空间>",
  "workload": "<制品名>",
  "image_ref": "<制品库>:8098/<制品名>:39",
  "digest": "sha256:1f3c…",
  "commit": "<commit-sha>",
  "commit_source": "oci-label",
  "built_at": "2026-11-03T02:11:07Z",
  "deployed_at": "2026-11-03T02:26:41Z",
  "deployed_by": "jenkins/pipeline-目标项目",
  "pod_started_at": "2026-11-03T02:27:03Z",
  "collected_at": "2026-11-05T02:30:00Z",
  "evidence": ["registry-manifest", "registry-config", "k8s-events"]
}
```

| 字段                  | 必填 | 来自哪                     | 说明                                                                             |
| --------------------- | ---- | -------------------------- | -------------------------------------------------------------------------------- |
| `digest`              | 是   | k8s pod `imageID`          | **主键**。不可变                                                                 |
| `image_ref`           | 是   | k8s pod `image`            | 人看的形式，含 tag（tag 可变，只作展示）                                         |
| `commit`              | 否   | OCI label / 回写 / Jenkins | **可能为空**——空必须原样保留，不能猜                                             |
| `commit_source`       | 是   | —                          | `oci-label` / `annotation` / `jenkins-parameter` / `manual` / `null`             |
| `built_at`            | 否   | image config `created`     | 构建时刻（不是发布时刻）                                                         |
| `deployed_at`         | 否   | k8s events / rollout       | 实际发布时间与操作人                                                             |
| `pod_started_at`      | 否   | k8s pod                    | **进程锚点**：Agent 看到的 `process_start_time_seconds` 与它对齐                 |
| `running_observed_at` | 否   | 人工确认 / cluster 查询    | **看到「这就是在跑的那个镜像」的时刻**。与 `pod_started_at` 是两件事，不互相替代 |
| `running_source`      | 否   | —                          | `human` / `k8s`：谁说的。人工确认是事实，但**不是机器测量**                      |
| `evidence`            | 是   | —                          | 这条是**哪些来源**支撑的。`registry-manifest` ≠ `registry-config` ≠ `k8s-events` |
| `collected_at`        | 是   | —                          | 采集时刻。**台账新鲜度**靠它判断                                                 |

`commit_source` 和 `evidence` 是这两个字段存在的理由：
**"从哪知道的"必须和"知道什么"一起被记录**，否则 Agent 没法判断这条台账可不可信。

## 5. `<BUILD_TAG>` 的替换点，以及「回写」的三种做法

`deployment.yaml` 里写的是 `<制品库>:8098/<repo>:<BUILD_TAG>`，
流水线把 `<BUILD_TAG>` 替换成构建号。**替换这件事本身不产生任何记录**——
所以事后只能靠反推。三种做法：

| 做法                                                 | 谁写           | 什么时候有   | 缺点                               |
| ---------------------------------------------------- | -------------- | ------------ | ---------------------------------- |
| **A. 构建时打 OCI label**                            | 构建脚本       | 下一次构建起 | **要改流水线一行**；改不了历史镜像 |
| **B. 部署时写 annotation**（`deploy.<团队>/commit`） | 部署步骤       | 下一次发布起 | **要改部署步骤**；历史发布没有     |
| **C. 构建号 → commit 旁路表**                        | Jenkins / 人工 | **现在就有** | CI 自述，可能与事实不符；靠人维护  |

**建议 A + B 一起上**，理由不是"多一条冗余"，而是：

- **A 给的是"镜像是什么"**（Registry 侧的事实）。
- **B 给的是"集群现在跑的是什么"**（集群侧的事实，`kubectl get deploy -o yaml` 肉眼可查）。
- 两者**互相独立**。采集器因此可以做**交叉校验**：
  不一致时**标红并如实记录**，而不是挑一个信——不一致本身就是重要信息。

**annotation 该写 digest，不是 tag。**

```yaml
metadata:
  annotations:
    deploy.<团队>/commit: '<commit-sha>'
    deploy.<团队>/image: '<制品库>:8098/<repo>@sha256:1f3c…'
```

tag 会被覆盖，digest 不会。
（`metadata.annotations` 不会自动传到 pod，要传得写到 `spec.template.metadata.annotations`。）

**A 的最小改动**（构建脚本一行）：

```bash
docker build \
  --label "org.opencontainers.image.revision=${GIT_COMMIT}" \
  --label "org.opencontainers.image.version=${BUILD_TAG}" \
  --label "org.opencontainers.image.source=${GIT_URL}" \
  -t "<registry>/<repo>:${BUILD_TAG}" .
```

跨语言通用（Java/Go/Python 都一样），比给每个项目接 `git-commit-id` 插件省事得多——
12 个 Dockerfile 都要改的话，流水线里改一次更划算。

## 6. 失败模式：每一条都必须有确定的说法

| #   | 现象                                    | 台账怎么表达                          | Agent 必须说什么                                |
| --- | --------------------------------------- | ------------------------------------- | ----------------------------------------------- |
| 1   | 镜像没有 revision label（**今天就是**） | `commit: null`，`commit_source: null` | 「这个镜像报不出 commit，**无法归因到发布**」   |
| 2   | tag 被覆盖 / 回滚                       | 两条 rollout，同 tag 不同 digest      | 「当前跑的是 digest X，对应 commit C」          |
| 3   | 构建自脏工作区                          | label 有，但 commit 未必等于发布内容  | 「label 指向 C，但无法确认构建产物与 C 一致」   |
| 4   | Jenkins 说的 commit 与 label 不一致     | 两条来源都记，`evidence` 全列         | 「两个来源冲突，**不选边**，报冲突」            |
| 5   | **台账里没有这个 digest**               | 查不到 → 硬报错                       | 「**台账缺条目**，不是'排除发布'」              |
| 6   | 台账过期（`collected_at` 太早）         | 时间戳可见                            | 「台账采集于 X，**可能不包含本次发布**」        |
| 7   | 灰度：多个 pod 不同 digest              | 每个 digest 一条 rollout              | 「集群上有 N 个版本，不能用单一 commit 下结论」 |
| 8   | 多集群 / 多环境                         | `cluster` 区分                        | 「这是 X 集群的部署，与 Y 无关」                |

**第 5 条是整套设计的地基。**
「台账缺条目」和「窗口内无代码变更」对 Agent 的意义**完全相反**：

- 前者 = **没查到**（不能下结论）
- 后者 = **查到了，没有变更**（可以排除发布）

把前者退化成后者，等于让 Agent 用沉默换一个有把握的错误结论。
所以读侧遇到缺条目**必须明确报错退出**，不能返回空集。

## 7. 这台机器上的现实约束（2026-11-05 实测）

| 事实                                              | 实测结果                                            | 对方案的影响                                                                 |
| ------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------- |
| Registry v2 API                                   | `http://<制品库>:8098/v2/` → **401**（v2 风格鉴权） | API 在，要凭据；**是 HTTP 不是 HTTPS**（采集器要配 `http`）                  |
| `kubectl`                                         | **本机没有**                                        | 采集器的**集群段**必须跑在有 kubeconfig 的机器上（Rancher / 4A / CI runner） |
| Dockerfile 的 `LABEL`                             | 12 个项目**全部 0 条**                              | OCI label 源要新建                                                           |
| `deployment.yaml` 的 `<BUILD_TAG>`                | 12+ 处，**统一形态**                                | 方案可一次覆盖全部项目                                                       |
| 应用自报 commit（`git-commit-id` / `build-info`） | 候选项目**都没有**                                  | 不能指望应用自己说                                                           |

因此采集器天然分两段：**registry 段**（本机可跑）和 **cluster 段**（要在有集群权限的机器上跑）。
两段的结果合并成一份台账文件。

## 8. 分期

| 阶段  | 内容                                                       | 阻塞什么                       | 状态                               |
| ----- | ---------------------------------------------------------- | ------------------------------ | ---------------------------------- |
| **0** | **人工建一条台账条目**（一次发布，人工填 digest + commit） | 读侧的设计验证，不依赖任何改动 | **已完成**（第 11 节，2026-11-06） |
| **1** | 读侧 `deploy` 通道 + **负对照** + 缺条目硬报错             | Agent 能用上台账               | **已实现并验证**（第 10 节）       |
| **2** | 采集器 registry 段（只读凭据）                             | 台账自动生成                   | **已实现并验证**（第 12 节）       |
| **3** | 流水线一行 label + 部署一步 annotation                     | commit 能自动填上              | 未开始                             |
| **4** | 采集器 cluster 段 + A/B 交叉校验                           | 「集群现在跑什么」自动化       | 未开始                             |

**阶段 0 现在就能做**，而且它能暴露设计里最容易被想当然的地方：
手工填的那一条，恰好是 Agent 最该会问的形状。

## 9. 自检清单（怎么证明台账是对的）

1. **digest 能反查 label**：给定台账里的 digest，采集器能独立取回 commit。
2. **digest 唯一**：同一个 digest 在台账里只出现一次（除非跨集群）。
3. **commit 在仓库里存在**：`git cat-file -e <sha>` 通过。
4. **采集器幂等**：连续两次采集，新增的只有新发生的 rollout，其余逐字节相同。
5. **负对照**：喂一个**不存在的 digest** 给读侧 → **必须明确报错**，
   且报错文本里出现「台账缺条目」，**不能**出现「窗口内无代码变更」。
6. **过期可见**：把 `collected_at` 改成很久以前 → Agent 的结论里必须带上这个提示。

第 5、6 条由 `incident/runs/deploy-ledger-control.mjs` 每次运行时验证（第 10 节）。

## 10. 阶段 1：读侧已实现并**验证通过**（2026-11-06，33/33）

> 2026-11-06 实跑 `incident/runs/deploy-ledger-control.mjs`：33 项全部通过（`exit=0`），
> 夹具容器在跑，两项 `current` 用例是真验成的。
> `node --check` 与 `npm run docs:check` 均通过。
> （最早一版是 21 项；同日补了短 digest 前缀、前缀歧义、commit 可信度、
> `running` 与多条观测，见 10.4–10.6。）

### 10.1 通道

`incident/tools/incident-readonly.mjs` 的 `deploy` 通道，**只读文件、不联网、不持凭据**：

| 命令                                        | 作用                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------ |
| `deploy current [--tolerance S]`            | 当前这次启动对应台账里的哪一条 rollout                                   |
| `deploy lookup <digest\|image_ref\|commit>` | 一条 rollout 的精确查询（同一 digest 多条时取最新一条，并报 `rollouts`） |
| `deploy running`                            | **现在跑的是哪个镜像**，以及是谁观测到的                                 |
| `deploy list [--limit N]`                   | 最近的 rollouts，按观测时间倒序                                          |
| `deploy check`                              | 台账健康度：条数、新鲜度、重复 digest、无可信 commit 的条目              |

台账路径解析顺序与其它描述符字段一致：**环境变量 `DEPLOY_LEDGER` 覆盖描述文件的 `ledgerPath`**。
（环境变量优先，是因为轮次编排器要把通道指向当轮的工作区，而不能去改描述文件。）

`deploy current` 的锚点走 `startAnchor()`：本地容器问 `docker inspect`，
不是本地容器（宿主进程形态的真实靶子）回落到描述文件的 `startedAt`，
输出里明确写出锚点来源。**拿不到锚点也是硬报错**——没有锚点就没有部署归因。

### 10.2 缺条目为什么是硬的

第 6 节第 5 条是整个设计的地基，实现上要顶住三种「悄悄退化成空集」的诱惑：

| 情形              | 天真做法（都是错的） | 本实现                    |
| ----------------- | -------------------- | ------------------------- |
| digest 不在台账里 | 返回空 / `[]`        | 非零退出 + 「台账缺条目」 |
| 台账文件不存在    | 当成空台账           | 非零退出 + 「台账缺条目」 |
| 某一行 JSON 坏了  | 跳过坏行             | 非零退出，**并报出行号**  |

坏行不能跳过的理由和缺条目同源：**被跳过的那一行可能正是要找的那一条**，
跳过它就会对一条就在眼前的记录回答「查不到」。

**报错文本里不能出现「窗口内无代码变更」这句话**——连"不是……"这种否定用法也不行。
理由不是措辞讲究，而是为了**让负对照可判定**：控制脚本断言的是
「stderr 含『台账缺条目』且不含『无代码变更』且 stdout 为空」，
只要错误路径上允许这句话出现，这条断言就退化成永远为真。
所以断言的可判定性反过来约束了措辞。

### 10.3 三条纪律写进了输出

1. **过期必须跟着答案走**，不能等 Agent 想起来单独跑一次检查。
   每个命中都带 `ledger_freshness`（`newest_collected_at` / `age_hours` / `stale`）。
   采集器三月就死了、十一月还在答「这个 digest 是 commit X」——这是台账最危险的谎，
   它不报错，只是过期。所以新鲜度和答案在**同一份输出**里。
2. **重复 digest 要报出来**，不能挑一条信（第 6 节第 2 条：回滚 = 同 tag 不同 digest，
   但同一个 digest 出现两次且 commit 不同，就是「哪个代码在跑」这个问题本身有歧义）。
   `deploy check` 列出重复及其行号。
3. **commit 为空就原样留空**（第 6 节第 1 条），不猜、不回落。

### 10.4 控制脚本

`incident/runs/deploy-ledger-control.mjs`，仓库根目录运行：

```bash
node incident/runs/deploy-ledger-control.mjs
```

它自己生成临时台账（含健康 / 过期 / 重复 / 坏行四种），跑完即删，不污染仓库。
每一条负对照都配一条**形状几乎相同、但必须成功**的正对照——
否则「一律拒绝」的实现会把所有拒绝类断言全骗过去。

覆盖：

| 类别   | 覆盖内容                                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------- |
| 正对照 | digest（带/不带 `sha256:` 前缀）、**短 digest 前缀**、image_ref、tag、commit 前缀各自的解析             |
| 正对照 | 健康台账自述健康；`list` 不倒序错；`current` 对上真实容器启动                                           |
| 正对照 | `DEPLOY_LEDGER` 覆盖描述文件；环境变量静默时用描述文件的 `ledgerPath`                                   |
| 正对照 | 同一台账里前缀有歧义时，**完整 digest 仍然查得到**                                                      |
| 负对照 | 不存在的 digest / 不存在的 tag / tag **前缀**不应误配                                                   |
| 负对照 | 不存在的**短 digest 前缀**是硬报错（形状与正对照相同）                                                  |
| 负对照 | 一个前缀同时命中两条时必须报「歧义」，不许挑一条                                                        |
| 负对照 | 台账文件不存在 / 根本没配台账 / 坏行（并要报出行号）                                                    |
| 纪律   | 过期台账仍可查，但答案必须带 `stale: true`                                                              |
| 纪律   | 重复 digest 必须被报出，不能静默挑一条                                                                  |
| 纪律   | OCI label 的 commit 标 `commit_reliable: true`；**推断来的 commit 必须标 false 并说明为什么可能是错的** |
| 正对照 | `running` 答出观测到的镜像与观测者；`lookup` 遇到同一 digest 多条观测时取最新并报 `rollouts`            |
| 负对照 | 台账里没有任何运行态观测时，`running` 是硬报错（**不是**「没有在跑的服务」）                            |

### 10.5 短 digest 前缀：一条真实的假阴性

`docker` 打印的是 **12 位短 image ID**，人也是这么粘的。
如果 `lookup` 只认完整 64 位 digest，短 ID 粘进来会得到「台账里没有」——
**在真实靶子上这句话等于把「我查的是缩写」说成了「没有这次发布」**，
和整份设计要防的那类谎是同一种。

所以 `lookup` 现在也认短 digest 前缀（≥7 位十六进制，可带可不带 `sha256:` 前缀）。
但**放宽匹配必须同时收紧歧义**：一个前缀同时命中两条时，
`lookup` 报「歧义」并要求用完整 digest，**不许挑一条**——
挑一条就等于把故障归因到一个可能根本没在跑的版本上。

对称的两条纪律：**查不到要硬报错，查太宽要报歧义**，两头都不许悄悄给一个答案。

### 10.6 `commit_reliable`：查到了也可能是错的

「查不到要硬报错」只解决了一半。另一半是：**查到了，但那个 commit 可能不是镜像里的代码。**
实测证据见 12.6——一张线上镜像的配置和本地**任何** commit 都不一致。

所以每条台账答案都带两个字段：

```json
"commit_reliable": false,
"commit_note": "commit 是按构建时刻从 git 历史推断，不是镜像自述——只能当线索。……"
```

判定规则只有一条：**commit 是不是镜像自己写进去的**。

| `commit_source`                    | `commit_reliable` | 理由                                   |
| ---------------------------------- | ----------------- | -------------------------------------- |
| `oci-label` / `annotation`         | **true**          | 构建时写进镜像，和镜像层一起不可变     |
| `git-window` / `git-head-fallback` | **false**         | 按时间推断；构建可能跑在未提交工作区上 |
| `jenkins-parameter` / `manual`     | **false**         | 别人的自述；与镜像内容没有绑定         |
| 缺失 / `null`                      | **false**         | 没有 commit，不等于「代码没变」        |

`git-window` 也判 false 是有意的：它只表示「构建时刻离某个 commit 很近」，
**并不表示镜像里就是那个 commit**。时间上的邻近推不出树的相同——
构建可以跑在**未提交的工作区**上，那么离得再近也不是那个 commit 的内容。
实测对不上的是 `git-head-fallback` 那一条（12.6），但两者失效的机制是同一个，
所以不能因为档位叫「window」就把它当事实。

### 10.7 `deploy running`：回答「现在跑的是哪个」，并把出处写出来

`pod_started_at` 需要集群；但**「现在跑的是哪个镜像」可以来自别处**——
一句人工确认就是事实，只是它**不是机器测量**。所以 `running` 的每条回答都带：

| 字段                  | 说明                                                         |
| --------------------- | ------------------------------------------------------------ |
| `observed_at`         | 什么时候看到「它在跑」                                       |
| `source`              | `human` 还是 `k8s`                                           |
| `pod_started_at`      | **仍然可能为空**：人工确认回答的是「是哪个」，不是「何时起」 |
| `running_for_seconds` | 起跑时刻未知时就是 `null`，并附 `pod_started_note` 说明原因  |

**台账里一条运行态观测都没有时，`running` 是硬报错**——
「没观测到」和「没有在跑的服务」是相反的结论，和「缺条目 ≠ 排除发布」是同一条纪律。

**已知边界**：闸门跑的是工作区那份 CLI（`lab-paths.json` 的 `readonlyCli`），
改了源要 `node incident/runs/sync-tools.mjs` 同步，否则闸门验的是旧 CLI。
这是全实验室共有的源/副本问题，不是本通道特有。

**尚未接上的一环**：合成夹具的每一轮 F2/F4 本身就是一次代码发布
（建 commit + 重建容器），但轮次编排器还**不写台账**。
所以夹具轮次里的 `deploy` 通道目前只能读手工/临时台账。
把「重建容器时写一条 rollout」接进 `run-round.mjs` 是阶段 2 的一部分。

## 11. 阶段 0：一条真实台账条目（2026-11-06）

### 11.1 建了什么

台账文件按设计放在**仓库外**（append-only JSONL）：
`/home/fs-user/incident-lab-archive/lab-data/deploy-ledger/ledger.jsonl`。

> **为什么在 home 树里，而不是工作区的邻域里**（2026-11-06 深夜补记）：
> Agent 以**宿主用户身份**跑（Bash 工具没有沙箱），`ls ..` 就能看到工作区上一层。
> 这份台账里是真实项目的镜像地址、namespace、commit——**离得近就会被顺手读进上下文**，
> 而合成夹具那一轮走的是第三方模型。邻域里放答案键叫「不相邻」，不叫「不可达」；
> 把公司数据放到**另一棵树**（家目录，和归档 bundle 同址）是现有设计里已有的做法。

条目不是编的，每一字段都来自机器事实：

| 字段             | 值                                                          | 事实来源                                                            |
| ---------------- | ----------------------------------------------------------- | ------------------------------------------------------------------- |
| `digest`         | `sha256:7d798eb8…501f0`                                     | `docker inspect target-service` 的 `.Image`（= 本地镜像的 imageID） |
| `image_ref`      | `incident/target-service:baseline`                          | `docker inspect` 的 `.Config.Image`                                 |
| `pod_started_at` | `2026-11-06T01:37:14.081Z`                                  | `docker inspect` 的 `.State.StartedAt`                              |
| `built_at`       | `2026-11-05T09:17:52.425Z`                                  | `docker images` 的镜像 `Created`                                    |
| `commit`         | `41ef6f23…b7135`                                            | target-service 仓库 HEAD（`git cat-file -e` 通过）                  |
| `commit_source`  | `manual`                                                    | **这条就是缺口 1，见 11.3**                                         |
| `evidence`       | `docker-image-id` / `docker-inspect-startedat` / `git-head` | 三处来源各自记名                                                    |

### 11.2 读侧消费这条真条目：全通

| 调用                                   | 结果                                                                  |
| -------------------------------------- | --------------------------------------------------------------------- |
| `deploy check`                         | `entries=1`、`distinct_digests=1`、无重复、无缺 commit、`stale=false` |
| `deploy lookup <digest>`               | `matched_on=digest`，回出同一条                                       |
| `deploy lookup 41ef6f2`（commit 前缀） | `matched_on=commit prefix`，回出同一条                                |
| `deploy current`                       | `matched=true`、`delta_seconds=0`、`anchor_source="docker inspect"`   |

`deploy current` 的 `anchor_source` 是 `"docker inspect"`——锚点走的是**机器读的容器启动时间**，
不是描述文件里手填的时间戳。

按第 9 节的自检清单逐条对账：

| #   | 自检项              | 结果                                            |
| --- | ------------------- | ----------------------------------------------- |
| 1   | digest 能反查 label | **不适用**——镜像没有 OCI label（这正是缺口 1）  |
| 2   | digest 唯一         | ✅ `distinct_digests=1`，`duplicate_digests=[]` |
| 3   | commit 在仓库里存在 | ✅ `git cat-file -e` 通过                       |
| 4   | 采集器幂等          | **不适用**——还没有采集器                        |
| 5   | 负对照              | ✅ 第 10 节的 9 项负对照每次跑都过              |
| 6   | 过期可见            | ✅ `ledger_freshness` 随命中带出                |

### 11.3 这一步暴露的两个缺口（**不是台子的问题，是设计的问题**）

**缺口 1：`commit` 与 `digest` 的绑定没有任何机器凭据。**

这一条我填的是 `commit_source: "manual"`。填法是「镜像构建时刻（09:17:52Z）之前最近的
git HEAD」——**不是从镜像里读出来的 commit**。如果构建与提交之间有并发提交、
或者构建的是稍早的 commit，这条台账会**自信地给出错误的 commit**，
而台账里**没有任何字段能暴露这一点**。

第 5 节的三种「回写」做法（OCI label / annotation / Jenkins 参数）都是为了消除这个缺口。
而实测是：**12 个候选项目的 Dockerfile 全部 0 条 `LABEL`**。
所以在真实靶子上，**这个缺口是默认状态，不是例外**——
`commit_source: "manual"` 才是常态，而不是过渡态。

⚠️ 推论：在 OCI label 落地（第 3 阶段）之前，**部署归因的 commit 结论不可自动采信**，
只能作为线索。Agent 侧必须能看出 `commit_source` 是 `manual` 还是机器来源，
否则它会把人工填的 commit 当成事实陈述。

**缺口 2：台账主键 `digest` 在宿主进程形态的靶子上不存在。**

第 2 节把 digest 定为主键，前提是「靶子以镜像部署，k8s pod 有 `imageID`」。
但 **P2 体检实例是宿主进程形态**（`java -jar`，不是容器，
描述文件里已写明「进程是宿主机上的 java -jar」）：
**没有镜像，也就没有 imageID，主键直接不存在。**

这不是边角情况——公司里 java 服务直接 `java -jar` 部署是常态形态。
宿主进程形态需要**另一个主键**（候选：构建产物自身的 sha256、
或「jar 路径 + mtime + commit」三元组），否则采集器只会支持容器形态，
而真实靶子的一半根本进不来。

**这条必须在阶段 2 采集器开工之前定下来**，否则采集器会先按 digest 写死再发现一半用不了。

### 11.4 补充（2026-11-06 晚）：**「读不到镜像源」这个判断本身是错的**

第 11.3 节的两个缺口是在**没有采集器**的前提下得出的。同一晚做了几项只读探测，
结论推翻了「读不到镜像源」：

- 内部制品库**不是 Harbor，是 Nexus 3.36 (OSS)**。
  之前勘察记的「`GET /v2/` 返回 401」被读成了「读不到」——
  **401 是 registry 根路径的正常行为**；
  **具体仓库的 `tags/list` / `manifests` / `blobs` 是匿名可读的**
  （`/v2/token` 直接发匿名 token）。
- Nexus 的 REST API 也能匿名读，**组件属性 `attributes` 是 `null`**——
  没人给组件打过属性，所以 Nexus 侧同样没有 commit。

**匿名就能拿到的台账字段**（实测，对 P2 的部署仓库）：

| 台账字段    | 来源                                         | 备注                        |
| ----------- | -------------------------------------------- | --------------------------- |
| `digest`    | `manifests/<tag>` 的 `Docker-Content-Digest` | 就是 pod `imageID` 那个形态 |
| `image_ref` | `tags/list` + 部署清单                       | tag = 构建号                |
| `built_at`  | image config 的 `created`                    | 构建时刻                    |
| `commit`    | **只能靠 git 时间窗口关联**（见下）          | registry 与 Nexus 都没有    |

⚠️ 两个踩过的坑：**请求 manifest 必须带 `Accept` 头**（否则 Nexus 回 404）；
**Nexus 的 REST API 与 registry 是两个端口/两个 context**，别指望一个端口通吃。

**commit 的机器来源只有 git 时间窗口，而且必须分置信度。** 用 P2 仓库实测三个构建号：

| 构建号 | 构建时刻前最后一个 commit | 距构建                 | 下一个 commit 距构建 | 判定                    |
| ------ | ------------------------- | ---------------------- | -------------------- | ----------------------- |
| 645    | a5e211ee                  | **0.3h**               | 4.4h                 | 关联强                  |
| 647    | 7b8db711                  | **0.2h**               | 0.8h                 | 关联强                  |
| 649    | cf2642bd                  | **354.2h**（仓库沉寂） | 无                   | 只能取 HEAD，**是推断** |

→ 采集器要按两条规则打 `commit_source`：

- `git-window`：构建时刻紧邻前一个 commit、且明显早于下一个 commit → 关联确定。
- `git-head-fallback`：构建时刻远离所有 commit（仓库沉寂后重建）→ 取 HEAD，
  **必须标成低置信推断**，不能当成事实陈述。

**仍然拿不到的（真正的边界）**：

- `pod_started_at` 与「现在跑的是哪个 digest」这个**查询键**：
  需要**集群访问**，而这台开发机**没有 kubectl**。
  靶子自己也不会报（候选项目都没有 git-commit-id / build-info 插件，actuator 不暴露）。
  → **没有这一环，Agent 在真实靶子上根本问不出「当前 digest」，读侧做得再全是空转。**
- 宿主形态靶子的制品 hash：Nexus 的 maven 仓库里**搜不到该项目的制品**。

**缺口 2 因此降级**：实测生产是 **k8s Deployment**（Rancher 建的工作负载，
镜像 tag = 构建号、`imagePullPolicy: Always`），
**生产是容器形态，digest 主键成立**。
「宿主进程没有 digest」只影响本地自建/体检实例这类靶子——
但采集器仍要给它们留一条路（主键待定），别写成只支持容器。

> 完整实测记录（含内部标识符）放在**仓库外**：`/home/fs-user/incident-lab-archive/lab-data/target-survey/registry-probe-2026-11-06.md`。

## 12. 阶段 2 的 registry 段：采集器已实现并验证（2026-11-06）

### 12.1 放在哪，为什么

| 东西                   | 位置                                 | 理由                                                                |
| ---------------------- | ------------------------------------ | ------------------------------------------------------------------- |
| 采集器**代码**         | 仓库内 `incident/collector/`         | 要能审计；**不含任何内部标识符**（registry 地址、仓库名全部是参数） |
| 采集器**产物**（台账） | 仓库外                               | 与设计一致：台账不进仓库                                            |
| 采集器**运行位置**     | Agent 可达范围外                     | 它是唯一联网、唯一可能持凭据的组件                                  |
| 读侧 CLI               | 工作区 `tools/incident-readonly.mjs` | Agent 只读台账，不写、不联网                                        |

「采集器不进 Agent 工作区」现在有**守卫**：`incident/runs/sync-tools.mjs`
在同步之后检查工作区里有没有采集器的副本，有就**报错退出**——
这条不变量靠脚本守着，不靠记性。

### 12.2 采集器做什么

```
node incident/collector/collect-registry.mjs \
  --registry <host:port> --repo <repository> --ledger <path> \
  [--git <repo path>] [--tags a,b,c] [--limit N] [--since <iso>] \
  [--near-hours N] [--token <jwt>] [--dry-run]
```

链路：`tags/list` → `manifests/<tag>`（拿 `Docker-Content-Digest`）→
`blobs/<config>`（拿 `created`）→ 用 `built_at` 去 git 历史里关联 commit → **追加**台账。

### 12.3 commit 的四档（这是采集器最要紧的部分）

| `commit_source`     | 什么时候                                                   | 能不能当事实           |
| ------------------- | ---------------------------------------------------------- | ---------------------- |
| `git-window`        | 构建前**最近的** commit 距构建 ≤ `--near-hours`（默认 2h） | 可以当**强线索**       |
| `git-head-fallback` | 最近的 commit 离得很远（仓库沉寂后重建）                   | **是推断**，必须当线索 |
| `ambiguous`         | 两个 commit **共享同一个时间戳**且离构建最近               | 不写 commit            |
| `null`              | 没有 git 仓库，或**构建早于所有 commit**                   | 不写 commit            |

**实测（真实数据）**：P2 的 6 个构建号里，3 个是 `git-window`（距构建 0.2–0.7h），
3 个是 `git-head-fallback`（34h / 354h / 427h）。
真实项目一天提交十几次，所以**这两种档都会出现**——这不是异常，是常态。

### 12.4 采集器自己守的纪律

1. **缺信息就硬报错，绝不写半条**：tag 取不到 manifest、manifest 没有 digest、
   config 没有构建时刻、响应不是 JSON、tag 列表为空 —— 全部非零退出，
   **台账文件都不创建**。半条记录是谎，读侧会把它当事实复述。
2. **不猜**：`pod_started_at` 采集器拿不到，就**留空**（cluster 段填，或者永远空着）。
3. **append-only**：同一批 tag 采两次，第二次 **0 追加**、全部记为「已存在」。
4. **同一 digest 的两条事实冲突时报出来，不挑一条**：同 digest 但 `built_at`
   不同、或两边都有 commit 而 commit 不同 → 冲突、**不写**、非零退出，旧条目原样保留。

**一行是一条「观测」，不是一个镜像**（2026-11-06 修正）。去重键原来只有
`digest + commit + built_at`，后果是「同一个镜像重新部署一次」会被当成重复**静默吞掉**——
而那正是「跑了多久」这个数字的来源。现在按**观测字段**判等（含 `pod_started_at`、
`running_observed_at`），`collected_at` 明确排除在判等之外（否则重采一次就多一行）。

控制脚本 `incident/collector/collector-control.mjs`（本地假 registry）：
registry 段与 CI/cluster 段**一起 29/29 通过**（第 13 节新增了 9 项）。

### 12.5 这一步修掉的一个**真 bug**（不是测试没过，是会给出错误答案）

第一版关联逻辑在「窗口内没有 commit」时，取的是**仓库里最新的 commit**——
而那可能是**构建之后**才提交的。真实数据上直接暴露：

```
tag 648  built 2026-10-19T01:49:43Z
  → "nearest is -6.0h earlier"     ← 负数：把未来的 commit 关联给了更早的构建
```

这正是「自信地给出错误的 commit」。修法两处：

- fallback 取**构建之前最近**的 commit，不是全局最新的；
- 构建**早于所有 commit** 时 → `commit_source: "null"`，**不写 commit**
  （配了对应的负对照）。

另外**调了一次规则**：原来用「6 小时窗口内只有 1 个 commit」判强关联，
真实数据上 6 小时内有 4 个 commit 是常态 → 几乎每次都 `ambiguous`、采集器等于没用。
改成「**取构建前最近的 commit**（唯一）+ **按距离分档**」，同一批真实数据立刻
从「3 条 ambiguous」变成「3 条 git-window + 3 条 git-head-fallback」。

### 12.6 一张真实镜像里的代码，对不上任何 commit（2026-11-06 实测）

用户指认了线上正在跑的那张镜像。把它的 `app.jar` 从镜像层里取出来，逐个比对打包进去的文件：

| 文件                    | 镜像里的    | 本地 HEAD 的 | 一致 |
| ----------------------- | ----------- | ------------ | ---- |
| `application.yaml`      | `c5578da1…` | `2bb4c665…`  | ✗    |
| `application-dev.yaml`  | `a0ac4224…` | `159551ac…`  | ✗    |
| `application-prod.yaml` | `95708b3d…` | `e4c63e2c…`  | ✗    |
| `logback-spring.xml`    | `e576e875…` | `e576e875…`  | ✓    |

并且 `git grep` 了**全部本地 ref**，没有任何分支含有镜像里那批配置。
**结论：这张镜像是用「不在任何本地 commit 里」的工作区构建的。**

这正是 11.3 缺口 1 所说的「自信地给出错误的 commit」，只是这次是**实证**而不是推测：
台账把该镜像关联到 HEAD，而 HEAD 的树并不是镜像里的代码。

**由此定下的 Agent 侧约束（读侧已实现）**：每条台账答案都带 `commit_reliable`，
只有当 commit 来自**镜像自身**（OCI label / annotation）时才为 `true`；
按构建时刻从 git 推断的（`git-window` / `git-head-fallback`）一律为 `false`，
并附一句说明：**这是线索，不要据此读源码并断言「这就是当时在跑的代码」**。

这也说明为什么「查不到要硬报错」不够——**查到了也可能是错的**，
所以每个值都必须带「它从哪来、能不能当事实」。

### 12.7 还没做（写于 2026-11-06 白天；cluster 段当晚已补上，见第 13 节）

**cluster 段**（阶段 4）：`pod_started_at`，以及「现在跑的是哪个 digest」的**机器来源**。
它需要**集群访问**（Rancher / kubeconfig），而这台开发机没有 kubectl。
→ 当晚接上了 Rancher 只读 API，**没有 kubectl、也没有 kubeconfig**，
做法与实测见第 13 节。

**阶段 2 还剩另一半**：把「重建容器时写一条 rollout」接进 `run-round.mjs`。
合成夹具的每一轮 F2/F4 本身就是一次发布（建 commit + 重建容器），
现在轮次里的 `deploy` 通道仍然只能读手工台账——**它还没有自己的发布记录**。

## 13. 阶段 3：CI 段与 cluster 段（2026-11-06 深夜）

### 13.1 三个源，三个不同种类的知识

```
registry  -- 镜像是什么：       digest、构建时刻
CI        -- 构建用了什么：     它检出的那个 commit   ← 事实
cluster   -- 现在跑着什么：     pod、imageID、起跑时刻 ← 事实
```

这三段描述的是**同一次发布**，所以采集器把它们**合并成一行**再写台账——
把合并留给读侧，读侧就会自己接错，而接错的那一行没人会发现。

「构建号 → commit」从此不再是推断：**tag 就是构建号**（实测 tag 651 ↔ build 651），
Jenkins 构建记录里的 `lastBuiltRevision.SHA1` 就是这次构建**实际检出**的 commit。
这是机器事实，不是「按时间猜的」。

### 13.2 采集器怎么用

```bash
node incident/collector/collect-deploy.mjs \
  --registry <host:port> --repo <repository> --ledger <path> \
  [--git <repo path>] [--tags a,b,c] [--limit N] [--near-hours N] [--dry-run] \
  [--jenkins-url <url> --jenkins-job <job> --jenkins-credentials-file <f>] \
  [--rancher-url <url> --rancher-cluster <id> --rancher-namespace <ns> \
   --rancher-credentials-file <f> --rancher-ca <pem>]
```

凭据**只从仓库外的文件读**，永远不进 argv（argv 会进 shell 历史和进程列表）。
采集器代码在仓库里（`incident/collector/`），但**不含任何内部标识符**——
地址、仓库名、namespace 全部是参数。

### 13.3 commit 的权威分级

| `commit_source`                | 权威 | 是什么                                  |
| ------------------------------ | ---- | --------------------------------------- |
| `oci-label` / `annotation`     | 3    | 镜像自己写的 label                      |
| `jenkins-build`                | 3    | CI 构建记录里这次检出的 commit          |
| `git-window`                   | 2    | 按构建时刻从 git 历史推断（窗口内）     |
| `git-head-fallback`            | 2    | 按构建时刻从 git 历史推断（沉寂后重建） |
| `jenkins-parameter` / `manual` | 1    | 人填的参数 / 人工填写                   |

**两个来源冲突时，权威高的赢，权威低的留下来**（`superseded_commit`），
而不是把错的那个抹掉——「推断错了，而且正确的那个在旁边」比一条干净的记录更有用。

### 13.4 实测：推断有多不可靠（6 个构建号）

同一批构建号，CI 记录和 git 推断给出的答案**并不总是一致**：

| 推断档位            | 条数 | 与 CI 记录一致 | 一致率  |
| ------------------- | ---- | -------------- | ------- |
| `git-window`        | 3    | 3              | **3/3** |
| `git-head-fallback` | 3    | 1              | **1/3** |

**根因不是算法，是本地 clone 陈旧**：本地 HEAD 停在 2026-10-19，
其中一次构建用的 commit **本地根本不存在**，
于是推断只能回退到 HEAD —— 把两次不同的构建**都**指向了同一个 commit。

这跟 12.6 是同一件事的两面：**本地 git 历史不足以当事实源**。
CI 构建记录不需要 clone 新鲜、不会猜、而且**已经存在**。

**因此：commit 优先取 CI 记录；git 推断降级为 `commit_inferred` 保留在行里**，
读侧把「推断与事实不符」显式标出来（`commit_inference_conflict`）。

### 13.5 cluster 段：没有 kubectl 怎么读集群

Rancher 的 `/v3` 管理 API 之后挂了一个 **Kubernetes 代理**：
`/k8s/clusters/<id>/api/v1/namespaces/<ns>/pods`。
用 Rancher 的 API 密钥当 Bearer token 就能读，**不需要 kubectl、不需要 kubeconfig**。

两个实测细节：

- **TLS 不能关校验**。集群用的是私有 CA，`-k` 会被当成「关掉 TLS 认证」——
  正确做法是把 CA 从 `GET /v3/settings/cacerts` 取出来**钉住**（`--cacert`），
  校验照做。
- **namespace 范围受 RBAC 限制**：集群级的「列出所有 namespace」是 403，
  但**指定 namespace 读 pods 是通的**。所以采集器按 namespace 逐个读，
  不做集群级枚举。

采集器从 pod 里取：pod 名、节点、`pod_scheduled_at`、容器 `imageID` 的 digest、
容器 `started_at`。**它不猜**——取不到就留空。

**一条硬纪律**：pod 的 `imageID` digest 与该 tag 在 registry 的 digest 不一致时，
**不写**，非零退出并说明「运行中的镜像与这个 tag 不是同一份」。
这是「tag 被重新推送过」，是矛盾，不是第二次发布。

### 13.6 读侧跟着改的三件事

1. **`commit_reliable` 对 `jenkins-build` 为 `true`**：CI 构建记录是事实。
   但仍附一句提醒：构建工作区当时若有未提交改动，镜像内容仍可能与该 commit 的树不同——
   **当「最可能的那份代码」，不要断言「逐字节相同」**。
2. **`commit_inference_conflict`**：行里同时有事实与推断且两者不同 → 显式报出来，
   并指明「以记录里的 commit 为准」。错的推断不被抹掉，但不会被当成结论。
3. **`rollouts` 不再等于行数**。台账现在有**心跳行**（同一 pod 被反复观测，每次多一行），
   按行数算会把心跳说成「发布过 3 次」。
   现在按 **(digest, pod 起点)** 分桶计数，观测行数另给 `observations`；
   起跑时刻未知的行单独归一桶并由 `rollouts_without_start_time` 报出来——
   **不把「读不到起点」算成一次发布**。

### 13.7 现在的实测结果

- 台账里 **6 个构建号的 commit 全部来自 CI 构建记录**；
  2 次推断被 CI 记录**推翻**，`superseded_commit` 里留着原来那个错的。
- 真实集群上正在跑的那张镜像：`pod_started_at` = 2026-11-06T02:49:04Z，
  观测时刻 07:53Z → **已运行约 5 小时**；pod 的 `imageID` digest 与 registry digest **逐字相同**。
- `deploy running` 现在能答「现在跑的是哪个」，且 `running_source = k8s`——
  **机器来源，不是人工确认**。

控制脚本：

| 脚本                                       | 覆盖                                 | 结果      |
| ------------------------------------------ | ------------------------------------ | --------- |
| `incident/collector/collector-control.mjs` | 采集器（registry/CI/cluster 假服务） | **29/29** |
| `incident/runs/deploy-ledger-control.mjs`  | 读侧                                 | **39/39** |

### 13.8 还没做

- ~~**`run-round.mjs` 还没有自己的发布记录**~~ → 第 14 节（2026-11-06 晚，已做）。
- ~~**P12 语义修复**~~ → 第 15 节（2026-11-06 晚，已做）。
- **本地 clone 陈旧**这件事本身没解决：现在只是不再依赖它。
  如果哪天真要靠 git 推断，第一步是**把 clone 更新到构建时刻**。

## 14. 阶段 4：合成夹具自己的台账（2026-11-06 晚）

### 14.1 缺的是什么

合成夹具每跑一轮就是一次发布（重建镜像 + 重建容器），但它**从没被推到任何
镜像库**，所以第 12 节的 registry 段看不见它——台账一直是空的。

而「台账里没有这一条」和「这一轮没有发布」是**相反的结论**。空台账让 Agent
的 `deploy` 通道只能回答「没查到」，它连「这一轮发布过」这个事实都拿不到。
这一轮测的恰恰是发布归因，所以这件事不是锦上添花。

### 14.2 写入侧：夹具自己的采集器

`incident/collector/collect-local.mjs`（配套 `local-image.mjs`）：

- 不联网、不持凭据——它读的是本机 docker daemon。
- digest 用**本地镜像 id**（docker 的内容哈希，和镜像库 digest 同一类身份）：
  宿主进程形态的靶子没有镜像库 digest，这是它能拿到的最硬的键。
- commit 取镜像自己的 `org.opencontainers.image.revision`，
  `commit_source: 'oci-label'`——读侧认这一档为可靠（`commit_reliable: true`）。
- 镜像**没有**这个 label 时，commit 记 null，**不回退到「当前 HEAD」**：
  在没提交的工作区上构建，回退出来的 commit 看起来像事实，其实不是。
  那个错在真实项目上实测到过（12.6）。

### 14.3 轮次接线（`incident/runs/run-round.mjs`）

- 每一次重建之后写一条记录：`setup` / `inject` / `restore`。
  写进 `manifest.deploy_ledger.entries`，manifest 里能看到这一轮写了哪几条。
- 台账路径交给 Agent 的方式：写进该工作区的容器环境配置
  （`data/config/container-env/<folder>.json` 的 `customEnv.DEPLOY_LEDGER`），
  host 模式下 runner 每次运行都把它注入 Agent 的 shell。
  Agent 读得到台账文件，读不到 docker socket。
- 台账文件在开跑前先建出来（可以是空的）：Agent 拿到的是「台账里没有这一条」，
  而不是「文件不存在」这种崩溃。

### 14.4 实测：一条真实的夹具记录

```json
{
  "digest": "sha256:625d055081ad98abdaf0622fbe653413172d1d33db82902c820b4b9a2c5c6c7f",
  "built_at": "2026-11-06T09:00:24Z",
  "commit": "41ef6f230272e8334ccd92b6dfe51b985d1b7135",
  "commit_source": "oci-label",
  "pod_started_at": "2026-11-06T09:00:26.799623594Z",
  "running_source": "docker"
}
```

读侧 `deploy current` 对上锚点（delta 0 秒），`commit_reliable: true`，
`commit_inference_conflict: false`。

### 14.5 实测：docker 的 `Created` **不是**构建时刻

写台账时踩到一个坑，值得单列：**`docker image inspect` 的 `Created` 不能当
构建时刻用**。

实测（本机 BuildKit + `docker compose build`）：

| 动作                     | digest             | `Created`                             |
| ------------------------ | ------------------ | ------------------------------------- |
| 换内容重建（label 变了） | `sha256:7f8dac78…` | `2026-11-04T11:25:30.058272836+08:00` |
| 再换内容重建             | `sha256:625d0550…` | `2026-11-04T11:25:30.058272836+08:00` |

digest 变了，`Created` 却是**纳秒级完全相同**的同一个值——它是第一次构建
留下的缓存残留，不是构建时刻。更糟的是它比镜像自己声明的那个 commit 还早，
拿它当 `built_at`，台账里就会出现一条「构建于提交之前」的荒谬记录。

所以：

- 构建时刻由**构建自己**写进镜像：`incident/lab.sh` 导出 `BUILD_TIME`，
  `docker-compose.yml` 的 `build.labels` 把它打进 `io.incident-lab.build-time`。
- 采集器只认这个 label。没有它就记 `built_at: null`（未知就是未知），
  **不回退到 `created`**。
- 用自己的命名空间而不用 `org.opencontainers.image.created`：基础镜像
  （ubuntu）已经带着那个 label，它说的是**基础镜像**的构建时间。

### 14.6 还没做

- 夹具台账只在**本机 docker**这一种形态上验过；宿主进程形态（真实靶子）
  的台账行由 `incident/collector/host-target.mjs` 负责，形态不同。

## 15. 阶段 5：P12 的语义修复（2026-11-06 晚）

### 15.1 原来的闸门问错了问题

P12 原来跑的是 `scripts/test-real-model-smoke.ts`：一句「只回复这一行」的
小请求。它证明的是**「provider 活着」**，闸门记录的却是「额度恢复了」——
两个不同的结论，而额度类故障的形状恰好让前者成立、后者不成立：

| 轮次             | 闸门 | 实际                       |
| ---------------- | ---- | -------------------------- |
| 2026-11-02 0802Z | 全绿 | 跑到最后一刻才发现额度不通 |
| 2026-11-02 1000Z | 全绿 | 轮次中途 429               |
| 2026-11-05       | 全绿 | 轮次跑完才发现额度用完     |

所以「闸门绿」被当成了「整轮可跑」，三轮白等。

### 15.2 改成什么

1. **轮次规模探测**（`incident/runs/provider-probe.ts`）：载荷是**本地合成**的，
   规模取自**上一轮真实的 transcript 字节数**（实测 206KB ≈ 5 万 token），
   问 provider 接不接得住。它问的是「接得住一轮的上下文吗」。
   探测体是合成的：探测要证明的是额度/限流在那个规模下通得过，
   不是把项目内容再发一遍——Agent 自己会发它真正要读的东西。
2. **开跑前再探一次**（P12b）：前置闸门到开跑之间隔着静默期的十几分钟，
   额度就是在那段时间里死的。前置闸门的结论不能替「开跑那一刻」作证。
3. **跑完后回查 transcript**：额度可以在跑到一半时耗尽，报告照样交上来
   （只是后半段是编的）。额度类错误一律判**整轮作废**，且记 provider 的账，
   不记 Agent 的。
4. **闸门的话改掉**：结论只到「这个规模下通」。provider 没有额度查询接口
   （`/key/info`、`/health`、`/model/info` 全部 401，实测过），
   所以「额度够跑完整轮」这句话，闸门没有资格说。

### 15.3 实测

```
[PASS] P12  provider 接得住一轮规模（51645 token / 1588ms，基准：上一轮的 transcript）
```

探测的真实用量（直连 Anthropic 协议拿到的 `usage`）：`input_tokens 72401`、
`output_tokens 45`、耗时 2.98 秒。

### 15.4 代价

每次探测是一次**真实请求**，规模与一轮相当，会产生真实费用；
一轮跑两次（P12 + P12b）。换来的是「不白等一轮」——
2026-11-05 那轮白等的代价是一次完整轮次（几分钟静默期 + 一次 Agent 运行）。
