#!/usr/bin/env node
/**
 * 校准打分器：确认它复现人工审计的结论，而不是自己发明结论。
 *
 * 校验矩阵（report × truth）：
 *   1. 10-27 F4 报告 × F4 真值 → 1.0 / excluded / correct   （人工审计：满分、正确排除发布）
 *   2. 10-26 F2 报告 × F2 真值 → 1.0 / relevant / correct   （人工审计：满分、发布即根因）
 *   3. 10-26 F2 报告 × F4 真值 → 0.0 / relevant / wrong     （交叉：不该命中）
 *   4. 10-27 F4 报告 × F2 真值 → 0.0 / excluded / wrong     （交叉：不该命中）
 *   5. 症状复述模板   × F4 真值 → 0.0 / unclear  / unclear   （PRD §7.1「只复述症状 = 未命中」）
 *   6. 10-30 F2 报告 × F2 真值 → 1.0 / relevant / correct   （人工审计：满分、发布即根因）
 *   7. 10-30 F2 报告 −守卫概念 × F2 真值 → 0.5 / relevant / correct（**负对照**）
 *   8. 10-30 F2 报告 −契约标记（改写成同名 markdown 标题）× F2 真值 → 1.0 / relevant / correct（**v4 正对照**）
 *   9. 10-30 F2 报告 −守卫概念 +「空值防护」× F2 真值 → 1.0 / relevant / correct（**v4 正对照**）
 *  10. 10-30 F2 报告 −全部结构（标题与标记都去掉）× F2 真值 → 0.0 / unclear / unclear（**v4 负对照**）
 *  11. 10-30 F2 报告 −commit 措辞 +「部署」措辞 × F2 真值 → 1.0 / relevant / correct（**v5 正对照**）
 *  12. 10-30 F2 报告 −「发布→变更」这条链 × F2 真值 → 0.0 / unclear / unclear（**v5 负对照**）
 *  13. 11-04 F4 报告 × F4 真值 → 1.0 / excluded / correct（**v6 正对照**：配置侧写成动作句，v5 判不到）
 *  14. 11-04 F4 报告 −root_cause 里的配置侧动作句 × F4 真值 → 0.0 / excluded / correct（**v6 负对照 A**）
 *  15. 11-04 F4 报告 −全文配置侧证据（保留「发布无关：排除」）× F4 真值 → 0.0 / unclear / unclear（**v6 负对照 B**）
 *  16. 内联报告：把发布说成触发源 × F4 真值 → 0.0 / relevant / wrong（**v6 负对照 C：过度归因要抓得到**）
 *
 * 第 3、4 行是关键：打分器不能因为「报告里提到了 commit 和 null」就放行，
 * 必须看它把发布放在触发源还是必要条件的位置上。
 *
 * 第 7 行是 v3 判据的负对照。v3 把 C2 里「未判空」那一环的词表从
 * `判空|兜底` 扩到「null 守卫」的各种说法，扩得太宽就会退化成
 * 「报告里遇到过 null 就算识别了机制」。所以拿 0738Z 那份真报告做手术：
 * 把守卫概念整段拿掉（措辞换成别的），其余一字不改——报告里仍然有
 * 「返回 null」「profile is null」「return null」等一大堆 null。
 * C2 必须**仍然 FAIL**：这才是「词表扩了，但没扩成空白支票」的证据。
 * 它同时断言 F2-C1 仍然 PASS（说明分数掉的是机制那一环，不是别的）。
 *
 * 第 8、9、10 行是 v4 的三条：
 *   · 第 8 行证明**切段认标题写法**之后，契约标记那份报告分数不变
 *     （不是靠改口径抬分，是同一份内容换一种排版照样量得出来）。
 *   · 第 9 行证明新加的「空值防护」是一个**真的同义词**：把守卫概念拿掉之后
 *     只写这一个词，C2 就能过——同时它继承第 7 行的负对照：
 *     第 7 行那个连「空值防护」都没有的报告仍然必须 FAIL。
 *   · 第 10 行证明新加的标题通道**只认标题行**：把标题和标记全去掉、
 *     只剩同样字句的散文，五节全判 NO_SECTION，总分 0.0。
 *     没有这条，正文里随口一句「根因假设」就可能被当成一节。
 *
 * 第 11、12 行是 v5 的两条：
 *   · 第 11 行证明 v5 认的是**内容**不是字面量：把 root_cause 里指称那次变更时
 *     用的名词从「提交」换成「部署」，其余一个字不改，根因节里再也找不到
 *     `commit|提交|代码变更|重新引入|revert`，但「根因落在代码变更上、
 *     落在发布上、指名了文件与方法」这些实质全在——C1 与 D1 必须仍然 PASS。
 *     v4 在这份报告上判 FAIL，那正是「v4 是判据错」的可执行证据。
 *   · 第 12 行证明 v5 的放宽**不是空白支票**：把「发布→变更」这条链从 root_cause
 *     里抽掉——发布仍然作为时间锚点被提到，但报告从头到尾没说这次发布动了什么、
 *     把什么变成了故障——C1 与 D1 必须仍然 FAIL。
 *     没有这条，「报告里出现过发布两个字」就会变成命中条件。
 *
 * 第 13–16 行是 v6 的四条：
 *   · 第 13 行是 v6 的正对照：11-04 那轮把配置侧写成**动作句**
 *     （「运行时把下游读超时压到 1 ms」），不是名词枚举里的任何一项，
 *     v5 判 C1 FAIL、整轮 0.0、发布归因 unclear——而那份报告的诊断内容是对的
 *     （复核见 `audit-2026-11-04T0324Z.md`）。v6 必须判 1.0 / excluded / correct。
 *   · 第 14 行是 v6 的负对照 A：把 root_cause 里那句配置侧结论拿掉
 *     （其余一字不改，机制链、null 折叠、兜底全在）——C1 必须 FAIL。
 *     它证明 C1 量的是**结论里有没有落到配置层**，不是「报告里有没有出现过
 *     DOWNSTREAM_TIMEOUT_MS 这个名字」（这个名字在支持证据节里仍有）。
 *   · 第 15 行是 v6 的负对照 B：把**全文**的配置侧证据都拿掉，
 *     只留下「发布变更无关：排除」这一句排除声明——D1 必须 FAIL、发布归因必须
 *     判 unclear。没有这条，「只要写了排除两个字就算排除对了」会成为刷分路径：
 *     报告可以对发布说了一万句「无关」，却根本没找到真正的触发源。
 *   · 第 16 行是 v6 的负对照 C：一份把发布说成触发源的报告，发布归因必须判
 *     relevant / wrong（过度归因要抓得到）。这一行同时是 v6 给 F4-D2 补
 *     「发布/部署 + 变更动词」这条链的证明——没有它，F4 这一族对过度归因是瞎的。
 * 用法：node incident/runs/calibrate-scorer.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const {
  scoreReport,
  extractSections,
  scoreAccuracy,
  scoreDeployment,
  runCheck,
} = await import(new URL('./score-report.mjs', import.meta.url).href);

const SYMPTOM_ONLY = `# target-service 5xx 故障诊断报告

## 三个锚点
| 锚点 | 时间 |
|---|---|
| ① 告警起始 | 2026-10-30T00:00:00Z |
| ② 异常首次出现 | 2026-10-30T00:00:01Z |
| ③ 最近一次部署 | 2026-10-30T00:00:02Z |

## 【根因假设】
target-service 出现大量 HTTP 500，NullPointerException 频繁出现，订单接口报错，整体错误率抬升。

## 【支持证据】
日志里有 NullPointerException，指标显示 5xx 比例上升。

## 【反对证据 / 尚未解释】
暂无。

## 【已排除的假设及排除依据】
| 假设 | 结论 | 排除依据 |
|---|---|---|
| 流量激增 | 排除 | 流量恒定 |

## 【跳过的步骤及原因】
无。
`;

/**
 * v6 负对照 C 用的内联报告：把**发布**说成触发源。
 *
 * F4 的真值是「发布是必要条件，触发源是运行时旋钮」。
 * 这份报告反过来：把发布说成触发源（机制段里「部署 … 删除了 …」、
 * 层级词写「触发源」），而且全文没有一句把发布排除掉。
 * 发布归因必须判 relevant / wrong——**过度归因要抓得到**。
 */
const DEPLOYMENT_AS_TRIGGER = `# target-service 5xx 故障诊断报告

## 三个锚点
| 锚点 | 时间 |
|---|---|
| ① 告警起始 | 2026-11-04T03:42:04Z |
| ② 异常首次出现 | 2026-11-04T03:41:43Z |
| ③ 最近一次部署 | 2026-11-04T03:41:38Z |

## 【根因假设】
机制：本次部署 852d339 删除了 OrderService 中的判空兜底，触发源就是这次发布带来的缺陷。

## 【支持证据】
- \`runtime env\`：DOWNSTREAM_TIMEOUT_MS=1
- 容器重建后 5xx 比例抬升

## 【反对证据 / 尚未解释】
- 无

## 【已排除的假设及排除依据】
- 资源类：排除。

## 【跳过的步骤及原因】
无。
`;

/**
 * 负对照手术：把「null 守卫」这个概念从报告里整段拿掉。
 *
 * 只动守卫概念的**说法**，不动别的：
 *   · 「null 保护」→「该分支」
 *   · 「解引用 null」→「直接取值」
 *   · 那段展示「删掉判空」的 diff → 换成一段与判空无关的 diff
 *
 * 手术之后报告里**仍然**有大量 null（「返回 null」「profile is null」
 * 「return null」……）。所以如果 C2 还能 PASS，说明词表已经宽到
 * 「见过 null 就算数」了——那正是这次要防的事。
 */
function stripGuardConcept(report) {
  return report
    .replace(/null\s*保护/g, '该分支')
    .replace(/解引用\s*null/g, '直接取值')
    .replace(
      /```diff\n[\s\S]*?```/,
      '```diff\n' +
        '-        order.put("ship_to", "UNKNOWN");\n' +
        '+        order.put("ship_to", profile.get("address"));\n' +
        '```',
    );
}

/**
 * 手术 A：把契约标记改写成同名 markdown 标题。
 *
 * 内容一个字不动，只把 '## 【根因假设】' 变成 '## 根因假设'。
 * v4 起切段认这种写法，所以分数必须与原报告**完全一致**。
 */
function markersToHeadings(report) {
  return report.replace(/^(#{1,6}\s*)【([^】]+)】/gm, '$1$2');
}

/**
 * 手术 B：守卫概念整段拿掉，只留一个新词「空值防护」。
 *
 * 先做 stripGuardConcept（拿掉 null 保护 / 解引用 null / 那段 diff），
 * 再把它留下的「该分支」替换成「空值防护」。
 * 结果：root_cause 节里**只有**「空值防护」这一个守卫词。
 * C2 必须 PASS——证明新加的词确实量的是「null 守卫」这个概念。
 */
function guardAsEmptyValueProtection(report) {
  return stripGuardConcept(report).replace(/该分支/g, '空值防护');
}

/**
 * 手术 C：把标题与契约标记全去掉，只剩同样字句的散文。
 *
 * v4 新增了「同名 markdown 标题」这一条切段路径，所以必须证明它
 * 只认**标题行**：字句还在，但没有结构 → 五节全 NO_SECTION → 0.0。
 */
function stripSectionStructure(report) {
  return report
    .replace(/^#{1,6}\s*【[^】]+】/gm, '')
    .replace(/^#{1,6}\s+/gm, '');
}

/**
 * 手术 D（v5 正对照）：把 root_cause 里指称那次变更时用的**名词**换掉。
 *
 * 内容一个字没改，改的只是「用提交还是用部署来指它」：
 *   「提交 `852d339` 把 … 原样回退」→「部署 `852d339` 删除了 …」
 *
 * 换完之后 root_cause 节里再也找不到 `commit|提交|代码变更|重新引入|revert`，
 * 但「根因落在代码变更上、落在那次发布上、指名了文件与方法、指名了它就是机制」
 * 这些实质一个字没少。v4 在这里判 FAIL，v5 必须判 PASS。
 */
function deploymentWording(report) {
  return replaceOnce(
    replaceOnce(
      report,
      '**机制**：提交 `852d339`（07:54:14Z）把 `7bb726a` 恢复的 null 保护原样回退，',
      '**机制**：部署 `852d339`（07:54:14Z）删除了 `7bb726a` 恢复的 null 保护，',
    ),
    '- 必要条件（缺陷层）：`852d339` 删除 null 保护 —— 栈顶行与 diff 改动行逐字一致，且该 commit 未改任何其他文件。',
    '- 必要条件（缺陷层）：部署 `852d339` 删除 null 保护 —— 栈顶行与 diff 改动行逐字一致，且该次上线未改任何其他文件。',
  );
}

/**
 * 手术 E（v5 负对照）：把「发布 → 变更」这条链从 root_cause 里抽掉。
 *
 * 报告还是同一份报告：机制链、受控对照、三层归因的架子全在，
 * **「最近一次发布」也仍然被提到**——但它只作为时间锚点出现，
 * 报告从头到尾没说这次发布动了什么、把什么变成了故障：
 * 触发源被写成了长期存在的数据事实，代码变更根本没进 root_cause。
 *
 * 判据的实质（根因定位到代码变更、并把它指认为致因）被抽掉之后，
 * C1 与 D1 必须仍然 FAIL。发布两个字还在那儿，所以这一条同时证明
 * v5 认的是「发布 + 变更动词」，不是「发布」两个字本身。
 */
function releaseAsAnchorOnly(report) {
  return replaceBlock(
    report,
    /## 【根因假设】[\s\S]*?(?=\n### 【支持证据】)/,
    `## 【根因假设】置信度 **0.95**

**机制**：\`/api/orders/2\`（其 user 9999 无 profile 行）触发下游 404 → \`fetchProfile\` 返回 null → \`OrderService.java:29\` 解引用 null 抛 NPE → HTTP 500；负载驱动 5 条路径中 1 条命中，5xx 比例 8.86% > 阈值 5%。

**分层（必要条件 vs 触发源）**
- 必要条件（缺陷层）：\`OrderService.loadOrder\` 对下游返回的 null 没有判空保护 —— 栈顶行与缺陷行逐字一致。
- 触发源（数据层）：order 2 引用了没有 profile 行的 user 9999，该数据事实一直存在。
- 2026-10-30T07:54:15.975Z 重建容器后开始报错 —— 最近一次发布 07:54:15.975Z，与故障起点同时。
- **不是**资源类、**不是**依赖宕机、**不是**运行时配置漂移。

`,
  );
}

/**
 * 手术 F（v6 负对照 A）：把 root_cause 里那句配置侧结论拿掉。
 *
 * 只动**这一句**——「运行时把下游读超时压到 1 ms（knob 文件 …）」换成
 * 「下游读超时（Read timed out）」。机制链、null 折叠、兜底缺失、NPE、
 * 两组对照实验一个字没改。
 *
 * 手术之后报告里**仍然**有 `DOWNSTREAM_TIMEOUT_MS`（在支持证据节里），
 * 所以如果 C1 还能 PASS，说明 C1 量的是「报告里出现过那个环境变量名」，
 * 而不是「结论落到了配置层」——那正是这一条要防的。
 */
function stripConfigSideFromRootCause(report) {
  return replaceOnce(
    report,
    '机制：运行时把下游读超时压到 1 ms（knob 文件 03:41:37.614 改、03:41:38.052 容器重建生效），',
    '机制：下游读超时（Read timed out），',
  );
}

/**
 * 手术 G（v6 负对照 B）：把**全文**的配置侧证据都拿掉。
 *
 * 保留「发布变更无关：排除」这一句排除声明，其余配置侧痕迹全部换成
 * 不带任何配置层词的说法（配置项 / 运行侧设置 / 某超时配置项 / 文件）。
 *
 * 这条是 v6 给 F4-D1 挂 `any_of` 并列约束的证明：
 * 只写「发布无关」而根本没说触发源是什么，D1 必须 FAIL、发布归因必须 unclear。
 */
function stripAllConfigEvidence(report) {
  const out = replaceAllChecked(report, [
    ['DOWNSTREAM_TIMEOUT_MS', '某超时配置项'],
    ['knob 文件', '配置文件'],
    ['knob', '配置文件'],
    ['运行时配置层', '运行侧设置'],
    ['旋钮', '配置项'],
    ['运行时配置项', '运行侧参数'],
    [
      '机制：运行时把下游读超时压到 1 ms（配置文件 03:41:37.614 改、03:41:38.052 容器重建生效），',
      '机制：下游读超时（配置文件 03:41:37.614 变更、03:41:38.052 容器重建生效），',
    ],
  ]);
  // 手术后必须真的没有配置侧痕迹了：any_of 一旦还能命中，这条校准就是假证据。
  const leftovers = out.match(
    /DOWNSTREAM_TIMEOUT_MS|旋钮|knob|运行时配置|运行期配置|配置层/g,
  );
  if (leftovers) {
    throw new Error(
      `手术没清干净，仍残留：${[...new Set(leftovers)].join(' / ')}`,
    );
  }
  return out;
}

/**
 * 替换必须真的发生。找不到原文就抛错——手术悄悄没生效的话，
 * 校准会以「本来就能过的报告」冒充「手术后的报告」通过，那是假证据。
 */
function replaceOnce(report, from, to) {
  if (!report.includes(from)) {
    throw new Error(`手术没找到待替换的原文：${from.slice(0, 48)}…`);
  }
  return report.replace(from, to);
}

/** 同上，批量替换：每一处都必须真的替换到（`split/join` 全文替换）。 */
function replaceAllChecked(report, pairs) {
  let out = report;
  for (const [from, to] of pairs) {
    if (!out.includes(from)) {
      throw new Error(`手术没找到待替换的原文：${from.slice(0, 48)}…`);
    }
    out = out.split(from).join(to);
  }
  return out;
}

/** 同上，替换一整块（按正则定位）。 */
function replaceBlock(report, re, to) {
  if (!re.test(report)) {
    throw new Error(`手术没找到待替换的区块：${re}`);
  }
  return report.replace(re, to);
}

/**
 * v7 的正对照报告：**带编号的标题 + 独立成行的加粗小标题**。
 *
 * 这是真实靶子那一轮（2026-11-10T0820Z）实际用的写法：
 * 「### 四、根因假设」「### 五、已排除的假设」「**反对证据 / 尚未解释**」。
 * v6 只认「以字段名开头的标题」，编号前缀让三节切不出来，
 * 于是那轮六条判据里四条判 NO_SECTION、整轮 0.0——
 * 而报告的诊断内容是对的。
 *
 * 内容用的是合成夹具自己的机制（下游读超时旋钮），不碰真实靶子的答案。
 */
const NUMBERED_HEADINGS_REPORT = `# target-service 5xx 故障诊断报告

### 一、三个锚点

| 锚点 | 时间 | 证据 |
|---|---|---|
| 告警起始 | 2026-11-04T03:42:04Z | \`metrics alerts\` → activeAt |
| 异常首次出现 | 2026-11-04T03:41:43Z | \`logs first 'Read timed out'\` |
| 最近一次容器重建 | 2026-11-04T03:41:38Z | \`deploy current\` → pod_started_at |

### 二、根因假设

**置信度：0.90**

**机制**：运行时把下游读超时压到 1 ms（\`DOWNSTREAM_TIMEOUT_MS\` 由 2000 ms 调成 1 ms，容器重建后生效），回环调用耗时约 2.5 ms 超过预算 → Read timed out → fetchProfile 返回 null → OrderService.loadOrder 没有判空兜底 → NullPointerException → HTTP 500。

**分层**：
- **触发源（配置层）**：运行时把下游读超时压到 1 ms（超时旋钮 DOWNSTREAM_TIMEOUT_MS=1），容器重建让它生效。
- **必要条件（缺陷层）**：commit 852d339 删除了 OrderService.loadOrder 的判空兜底。
- **放大条件**：订单端点与负载探针共用同一条被压到 1 ms 的出站路径。

**支持证据**

- \`runtime env\`：DOWNSTREAM_TIMEOUT_MS=1（重建后进程环境里的生效值）
- \`logs first 'Read timed out'\`：2026-11-04T03:41:43Z
- \`actuator health\`：db=UP、redis=UP，仅下游调用超时

**反对证据 / 尚未解释**

1. 我没有直接读到重建前那个容器的进程环境，「它当时是 2000 ms」是推断（重建前 5xx 比例 = 0）。
2. 那批零星 503 在故障窗口之外，无法在现有证据下归因，未解释。

### 三、已排除的假设

- **资源类（连接池 / 内存 / 线程）**：排除。5xx 是台阶不是缓慢增长。
- **依赖宕机**：排除。db / redis / ping 均 UP。
- **流量激增**：排除。请求速率故障前后一致。
- **最近一次发布**：排除（必要条件，不是触发源）。发布 852d339 删了判空兜底，触发源是运行时旋钮那次改动。

### 四、跳过的步骤及原因

- **git-diff-analysis**：窗口内没有新的代码变更，digest 未变；缺陷来自更早的 852d339。
`;

/**
 * v7 近邻正对照：只去掉标题里的编号，内容一个字不动。
 *
 * 分数必须与带编号那份**完全一致**——证明 v7 认的是「字段名在不在」，
 * 不是「编号在不在」。
 */
function dropEnumerators(report) {
  return report.replace(/^(#{1,6}\s+)[一二三四五六七八九十]+、/gm, '$1');
}

/**
 * v8 手术 A：把字段名换成**同义写法**，内容一个字不动。
 *
 * 真实靶子 2026-11-11T0150Z 那轮就是这么写的：
 *   「### 主假设（触发源，置信度 高）」代替「根因假设」
 *   「### 证据缺口（诚实声明）」代替「反对证据 / 尚未解释」
 * 语义对得上，名字不是契约里的那六个——v7 只认契约名，
 * 于是 root_cause 与 against 两节都切不出来，判据 NO_SECTION、整轮 0.0，
 * 而那份报告的诊断内容是对的。
 *
 * 分数必须与带编号那份**完全一致**：证明 v8 认的是「字段在不在」，
 * 不是「字段名是不是契约里那六个字」。
 */
function renameFieldsToAliases(report) {
  return replaceAllChecked(report, [
    ['### 二、根因假设', '### 主假设（触发源，置信度 高）'],
    ['**支持证据**', '### 支持证据'],
    ['**反对证据 / 尚未解释**', '### 证据缺口（诚实声明）'],
    ['### 三、已排除的假设', '### 已排除的假设（附排除依据）'],
    ['### 四、跳过的步骤及原因', '### 跳过的步骤及原因'],
  ]);
}

/**
 * v8 负对照 A：把根因节的标题换成**排除项**的名字。
 *
 * 报告里唯一一个带「假设」二字的标题变成了「已排除的假设」——
 * 如果别名匹配写得太松（拿「假设」当别名，而不是「主假设」），
 * root_cause 就会把排除项那一节抢过来，把排除理由当成根因判据的证据。
 *
 * root_cause 必须仍然是 NO_SECTION，excluded 必须照常找到。
 */
function renameRootCauseToExcluded(report) {
  return replaceOnce(
    report,
    '### 主假设（触发源，置信度 高）',
    '### 已排除的假设（附排除依据）',
  );
}

/**
 * v8 负对照 B：把根因节的标题换成**不承载字段的标题**。
 *
 * 「主假设」两个字还在正文里（还在同一节里），但节标题没了 →
 * root_cause 必须 NO_SECTION。证明别名只在**标题**上认，
 * 正文里随口一句「主假设」不算数。
 */
function renameRootCauseToPlainHeading(report) {
  return replaceOnce(report, '### 主假设（触发源，置信度 高）', '### 诊断结论');
}

/**
 * v9 的报告骨架：字段名、机制、排除项都固定，只有「反对证据」那一节待替换。
 *
 * 反对证据那一节是**同一个字段的两种内容**：
 *   · 一份真的列了反例（「读不到」「只能证明」「不构成」）
 *   · 一份只把排除项复述了一遍
 * 两份结构完全一样，差的是内容——这才是「列了反对证据」与「列了排除项」的差别。
 */
const AGAINST_SKELETON = `# target-service 5xx 故障诊断报告

### 三个锚点

| 锚点 | 时间 |
|---|---|
| 告警起始 | 2026-11-04T03:42:04Z |
| 异常首次出现 | 2026-11-04T03:41:43Z |
| 最近一次容器重建 | 2026-11-04T03:41:38Z |

### 根因假设

**机制**：运行时把下游读超时压到 1 ms（\`DOWNSTREAM_TIMEOUT_MS\` 由 2000 ms 调成 1 ms，容器重建后生效）→ Read timed out → fetchProfile 返回 null → OrderService.loadOrder 没有判空兜底 → NullPointerException → HTTP 500。

- **触发源（配置层）**：运行时把下游读超时压到 1 ms（超时旋钮 DOWNSTREAM_TIMEOUT_MS=1）。
- **必要条件（缺陷层）**：commit 852d339 删除了 OrderService.loadOrder 的判空兜底。
- **放大条件**：订单端点与负载探针共用同一条被压到 1 ms 的出站路径。

### 反对证据 / 尚未解释

@@AGAINST@@

### 已排除的假设及排除依据

- **资源类**：排除。5xx 是台阶不是缓慢增长。
- **依赖宕机**：排除。db / redis / ping 均 UP。
- **流量激增**：排除。请求速率故障前后一致。
- **最近一次发布**：排除（必要条件，不是触发源）。发布 852d339 删了判空兜底，触发源是运行时旋钮那次改动。
`;

/**
 * v9 正对照：反对证据那一节**真的列了反例**。
 *
 * 措辞是真实轮次里出现过的写法：「读不到」「只能证明」「不构成」「无因果贡献」——
 * 它们在旧词表（未解释|尚未解释|无法|未能|缺口|存疑|不完整）里一个都不沾，
 * 于是旧 rubric 把「列了三条真反例」判成 FAIL。
 */
const AGAINST_WITH_COUNTER_EVIDENCE = `1. 旋钮文件在 03:24:53 被编辑，但该窗口 NPE 0 次、5xx 比例序列不存在 ⇒ 配置层无因果贡献；这次编辑的具体内容读不到，只能证明它未造成本故障。
2. \`profile lookup failed\` 的 ERROR 在故障前已每 4 秒一条，是长期噪音；它不构成本次根因（404 速率故障前后完全一致）。
3. 5xx 比例观测到 9.9% 的瞬时高点略高于 8.5% 平台值，归因于 1m 窗口边界与流量抖动。`;

/**
 * v9 负对照：同一节、同样三条，但只是把排除项复述了一遍。
 *
 * 里面既没有反例，也没有未解释项——「列了三条」不等于「列了反对证据」。
 * 这一条必须 FAIL：否则 v9 的词表就成了一张空白支票。
 */
const AGAINST_WITH_EXCLUSIONS_ONLY = `1. 资源类：已排除。
2. 依赖宕机：已排除。
3. 流量激增：已排除。`;

function withAgainstSection(content) {
  const out = AGAINST_SKELETON.replace('@@AGAINST@@', content);
  if (out.includes('@@AGAINST@@')) throw new Error('反对证据那一节没替换上');
  return out;
}

/**
 * v7 负对照 A：把结构全拆掉，只剩同样字句的散文。
 *
 * 标题的编号去掉（标题行本身也去掉）、加粗小标题行也去掉。
 * 没有结构 → 五节全 NO_SECTION → 0.0。
 */
function flattenStructure(report) {
  return report
    .replace(/^#{1,6}\s+.*$/gm, '')
    .replace(/^\s*\*\*(支持证据|反对证据 \/ 尚未解释)\*\*\s*$/gm, '');
}

/**
 * v7 负对照 B：把 root_cause 里那句配置侧结论抽掉。
 *
 * 其余一字不改（机制链、判空缺失、NPE、对照组全在），
 * 只是不再把触发源落到配置层 → C1 必须 FAIL。
 */
function stripConfigSideFromNumbered(report) {
  return replaceOnce(
    replaceOnce(
      report,
      '**机制**：运行时把下游读超时压到 1 ms（`DOWNSTREAM_TIMEOUT_MS` 由 2000 ms 调成 1 ms，容器重建后生效），',
      '**机制**：下游读超时（Read timed out），',
    ),
    '- **触发源（配置层）**：运行时把下游读超时压到 1 ms（超时旋钮 DOWNSTREAM_TIMEOUT_MS=1），容器重建让它生效。\n',
    '- **触发源（状态层）**：下游读超时（Read timed out）。\n',
  );
}

/**
 * v7 负对照 C：只留一个字段标签行，内容一个字没有。
 *
 * 证明「字段名不能满足它自己那条判据」：
 * 契约标记「【反对证据 / 尚未解释】」里就有「尚未解释」四个字，
 * v6 把它算进本节正文，于是 Q4 白拿一次命中。
 * v7 起标记行只当标题 → against 节里必须**查不到**「尚未解释」。
 */
const LABEL_ONLY_REPORT = `# 空报告

**反对证据 / 尚未解释**
`;

const CASES = [
  {
    name: '10-27 F4 报告 × F4 真值',
    report: join(root, 'runs/agent-report-2026-10-27T0727Z.md'),
    truth: join(root, 'runs/ground-truth/F4.json'),
    expect: { accuracy: 1.0, deployment: 'excluded', correct: 'correct' },
  },
  {
    name: '10-26 F2 报告 × F2 真值',
    report: join(root, 'runs/agent-report-2026-10-26T0222Z.md'),
    truth: join(root, 'runs/ground-truth/F2.json'),
    expect: { accuracy: 1.0, deployment: 'relevant', correct: 'correct' },
  },
  {
    name: '10-26 F2 报告 × F4 真值（交叉，不该命中）',
    report: join(root, 'runs/agent-report-2026-10-26T0222Z.md'),
    truth: join(root, 'runs/ground-truth/F4.json'),
    expect: { accuracy: 0.0, deployment: 'relevant', correct: 'wrong' },
  },
  {
    name: '10-27 F4 报告 × F2 真值（交叉，不该命中）',
    report: join(root, 'runs/agent-report-2026-10-27T0727Z.md'),
    truth: join(root, 'runs/ground-truth/F2.json'),
    expect: { accuracy: 0.0, deployment: 'excluded', correct: 'wrong' },
  },
  {
    name: '症状复述模板 × F4 真值（未命中）',
    report: null,
    inline: SYMPTOM_ONLY,
    truth: join(root, 'runs/ground-truth/F4.json'),
    expect: { accuracy: 0.0, deployment: 'unclear', correct: 'unclear' },
  },
  {
    name: '10-30 F2 报告 × F2 真值（人工审计：机制链、受控对照、发布即根因全对）',
    report: join(root, 'runs/agent-report-2026-10-30T0738Z.md'),
    truth: join(root, 'runs/ground-truth/F2.json'),
    expect: { accuracy: 1.0, deployment: 'relevant', correct: 'correct' },
    expect_criteria: { 'F2-C1': 'PASS', 'F2-C2': 'PASS' },
  },
  {
    name: '10-30 F2 报告 −守卫概念（负对照：机制链还在，守卫那一环没了）',
    report: join(root, 'runs/agent-report-2026-10-30T0738Z.md'),
    mutate: stripGuardConcept,
    truth: join(root, 'runs/ground-truth/F2.json'),
    expect: { accuracy: 0.5, deployment: 'relevant', correct: 'correct' },
    expect_criteria: { 'F2-C1': 'PASS', 'F2-C2': 'FAIL' },
  },
  {
    name: '10-30 F2 报告 −契约标记（改写成同名 markdown 标题，正对照）',
    report: join(root, 'runs/agent-report-2026-10-30T0738Z.md'),
    mutate: markersToHeadings,
    truth: join(root, 'runs/ground-truth/F2.json'),
    expect: { accuracy: 1.0, deployment: 'relevant', correct: 'correct' },
    expect_criteria: { 'F2-C1': 'PASS', 'F2-C2': 'PASS' },
  },
  {
    name: '10-30 F2 报告 −守卫概念 +「空值防护」（正对照：新词量的是同一个概念）',
    report: join(root, 'runs/agent-report-2026-10-30T0738Z.md'),
    mutate: guardAsEmptyValueProtection,
    truth: join(root, 'runs/ground-truth/F2.json'),
    expect: { accuracy: 1.0, deployment: 'relevant', correct: 'correct' },
    expect_criteria: { 'F2-C1': 'PASS', 'F2-C2': 'PASS' },
  },
  {
    name: '10-30 F2 报告 −全部结构（负对照：同样的字句，没有标题就没有节）',
    report: join(root, 'runs/agent-report-2026-10-30T0738Z.md'),
    mutate: stripSectionStructure,
    truth: join(root, 'runs/ground-truth/F2.json'),
    expect: { accuracy: 0.0, deployment: 'unclear', correct: 'unclear' },
    expect_criteria: { 'F2-C1': 'NO_SECTION' },
  },
  {
    name: '10-30 F2 报告 −commit 措辞 +「部署」措辞（v5 正对照：实质还在，v4 判不到）',
    report: join(root, 'runs/agent-report-2026-10-30T0738Z.md'),
    mutate: deploymentWording,
    truth: join(root, 'runs/ground-truth/F2.json'),
    expect: { accuracy: 1.0, deployment: 'relevant', correct: 'correct' },
    expect_criteria: { 'F2-C1': 'PASS', 'F2-C2': 'PASS' },
    expect_deployment_checks: { 'F2-D1': 'PASS', 'F2-D2': 'FAIL' },
    // 手术必须真的把 commit 侧的词清干净，否则这条就是在考「本来就能过的报告」。
    expect_absent: {
      section: 'root_cause',
      pattern: 'commit|提交|代码变更|重新引入|revert',
    },
    expect_present: { section: 'root_cause', pattern: '部署' },
  },
  {
    name: '10-30 F2 报告 −「发布→变更」这条链（v5 负对照：只剩发布这个时间锚点）',
    report: join(root, 'runs/agent-report-2026-10-30T0738Z.md'),
    mutate: releaseAsAnchorOnly,
    truth: join(root, 'runs/ground-truth/F2.json'),
    expect: { accuracy: 0.0, deployment: 'unclear', correct: 'unclear' },
    expect_criteria: { 'F2-C1': 'FAIL', 'F2-C2': 'PASS' },
    expect_deployment_checks: { 'F2-D1': 'FAIL', 'F2-D2': 'FAIL' },
    // 「发布」两个字必须还在 root_cause 里：只有它还在，C1/D1 仍然 FAIL
    // 才说明判据认的是「发布 + 变更动词」，不是「发布」两个字本身。
    expect_present: { section: 'root_cause', pattern: '发布|部署|上线' },
    expect_absent: {
      section: 'root_cause',
      pattern: 'commit|提交|代码变更|重新引入|revert',
    },
  },
  {
    name: '11-04 F4 报告 × F4 真值（v6 正对照：配置侧写成动作句，v5 判不到）',
    report: join(root, 'runs/agent-report-2026-11-04T0324Z.md'),
    truth: join(root, 'runs/ground-truth/F4.json'),
    expect: { accuracy: 1.0, deployment: 'excluded', correct: 'correct' },
    expect_criteria: { 'F4-C1': 'PASS', 'F4-C2': 'PASS' },
    expect_deployment_checks: { 'F4-D1': 'PASS', 'F4-D2': 'FAIL' },
    // 这一轮的配置侧结论写在 root_cause 里，措辞是动作句：
    // 「运行时把下游读超时压到 1 ms」——v5 的名词枚举一个都不沾，于是判 FAIL。
    expect_present: {
      section: 'root_cause',
      pattern: '运行时把下游读超时压到 1 ms',
    },
  },
  {
    name: '11-04 F4 报告 −root_cause 里的配置侧结论（v6 负对照 A：结论没落到配置层）',
    report: join(root, 'runs/agent-report-2026-11-04T0324Z.md'),
    mutate: stripConfigSideFromRootCause,
    truth: join(root, 'runs/ground-truth/F4.json'),
    expect: { accuracy: 0.0, deployment: 'excluded', correct: 'correct' },
    expect_criteria: { 'F4-C1': 'FAIL', 'F4-C2': 'PASS' },
    // 关键：那个环境变量名在支持证据节里**仍然**有——
    // C1 仍然 FAIL 才说明它量的是「结论」，不是「出现过那个名字」。
    expect_present: { section: 'whole', pattern: 'DOWNSTREAM_TIMEOUT_MS' },
    expect_absent: {
      section: 'root_cause',
      pattern: '旋钮|knob|DOWNSTREAM_TIMEOUT_MS|运行时配置|配置层',
    },
  },
  {
    name: '11-04 F4 报告 −全文配置侧证据（v6 负对照 B：只写「发布无关」不算数）',
    report: join(root, 'runs/agent-report-2026-11-04T0324Z.md'),
    mutate: stripAllConfigEvidence,
    truth: join(root, 'runs/ground-truth/F4.json'),
    expect: { accuracy: 0.0, deployment: 'unclear', correct: 'unclear' },
    expect_criteria: { 'F4-C1': 'FAIL', 'F4-C2': 'PASS' },
    expect_deployment_checks: { 'F4-D1': 'FAIL', 'F4-D2': 'FAIL' },
    // 排除声明必须还在：D1 判 FAIL 才说明是「并列约束」把它拦下来的，
    // 而不是「排除措辞没匹配上」。
    expect_present: { section: 'whole', pattern: '发布变更无关：排除' },
    expect_absent: {
      section: 'whole',
      pattern: 'DOWNSTREAM_TIMEOUT_MS|旋钮|knob|运行时配置|运行期配置|配置层',
    },
  },
  {
    name: '内联报告：把发布说成触发源（v6 负对照 C：过度归因要抓得到）',
    report: null,
    inline: DEPLOYMENT_AS_TRIGGER,
    truth: join(root, 'runs/ground-truth/F4.json'),
    expect: { accuracy: 0.0, deployment: 'relevant', correct: 'wrong' },
    expect_deployment_checks: { 'F4-D1': 'FAIL', 'F4-D2': 'PASS' },
  },
  {
    name: '编号标题 + 加粗小标题的报告 × F4 真值（v7 正对照 A：v6 会判 0.0）',
    report: null,
    inline: NUMBERED_HEADINGS_REPORT,
    truth: join(root, 'runs/ground-truth/F4.json'),
    expect: { accuracy: 1.0, deployment: 'excluded', correct: 'correct' },
    expect_criteria: { 'F4-C1': 'PASS', 'F4-C2': 'PASS' },
    expect_deployment_checks: { 'F4-D1': 'PASS', 'F4-D2': 'FAIL' },
    // 编号必须真的在标题上：否则这一条就是在考「本来就能过的那份」。
    expect_present: { section: 'whole', pattern: '### 二、根因假设' },
  },
  {
    name: '同一份报告去掉标题编号（v7 近邻正对照 B：编号只是排版）',
    report: null,
    inline: NUMBERED_HEADINGS_REPORT,
    mutate: dropEnumerators,
    truth: join(root, 'runs/ground-truth/F4.json'),
    expect: { accuracy: 1.0, deployment: 'excluded', correct: 'correct' },
    expect_criteria: { 'F4-C1': 'PASS', 'F4-C2': 'PASS' },
    expect_deployment_checks: { 'F4-D1': 'PASS', 'F4-D2': 'FAIL' },
    expect_absent: { section: 'whole', pattern: '### 二、根因假设' },
  },
  {
    name: '同一份报告拆掉全部结构（v7 负对照 A：没结构就没有节）',
    report: null,
    inline: NUMBERED_HEADINGS_REPORT,
    mutate: flattenStructure,
    truth: join(root, 'runs/ground-truth/F4.json'),
    expect: { accuracy: 0.0, deployment: 'excluded', correct: 'correct' },
    expect_criteria: { 'F4-C1': 'NO_SECTION' },
  },
  {
    name: '同一份报告抽掉 root_cause 里的配置侧结论（v7 负对照 B：没放松成空白支票）',
    report: null,
    inline: NUMBERED_HEADINGS_REPORT,
    mutate: stripConfigSideFromNumbered,
    truth: join(root, 'runs/ground-truth/F4.json'),
    expect: { accuracy: 0.0, deployment: 'excluded', correct: 'correct' },
    expect_criteria: { 'F4-C1': 'FAIL', 'F4-C2': 'PASS' },
    // 环境变量名在支持证据节里**仍然**有：C1 仍然 FAIL 才说明它量的是结论。
    expect_present: { section: 'whole', pattern: 'DOWNSTREAM_TIMEOUT_MS' },
  },
  {
    name: '只有一个字段标签行、没有内容（v7 负对照 C：字段名不能满足自己那条判据）',
    report: null,
    inline: LABEL_ONLY_REPORT,
    truth: join(root, 'runs/ground-truth/F4.json'),
    expect: { accuracy: 0.0, deployment: 'unclear', correct: 'unclear' },
    expect_criteria: { 'F4-C1': 'NO_SECTION' },
    expect_absent: { section: 'against', pattern: '尚未解释' },
  },
  {
    name: '字段名换成同义写法（v8 正对照 A：v7 只认契约名，会判 0.0）',
    report: null,
    inline: NUMBERED_HEADINGS_REPORT,
    mutate: renameFieldsToAliases,
    truth: join(root, 'runs/ground-truth/F4.json'),
    expect: { accuracy: 1.0, deployment: 'excluded', correct: 'correct' },
    expect_criteria: { 'F4-C1': 'PASS', 'F4-C2': 'PASS' },
    expect_deployment_checks: { 'F4-D1': 'PASS', 'F4-D2': 'FAIL' },
    expect_quality: { Q3: 'PASS', Q4: 'PASS' },
    // 同义写法必须真的换掉了：否则这一条考的是「本来就能过的那份」。
    expect_present: {
      section: 'whole',
      pattern: '### 主假设（触发源，置信度 高）',
    },
    expect_absent: { section: 'whole', pattern: '### 二、根因假设' },
  },
  {
    name: '唯一带「假设」的标题变成排除项（v8 负对照 A：root_cause 不能被抢走）',
    report: null,
    inline: NUMBERED_HEADINGS_REPORT,
    mutate: (r) => renameRootCauseToExcluded(renameFieldsToAliases(r)),
    truth: join(root, 'runs/ground-truth/F4.json'),
    expect: { accuracy: 0.0, deployment: 'excluded', correct: 'correct' },
    expect_criteria: { 'F4-C1': 'NO_SECTION' },
    expect_quality: { Q3: 'PASS' },
    // 排除项那一节必须照样找得到（没被 root_cause 抢走，也没整节丢掉）；
    // root_cause 必须仍然是空的。
    expect_present: { section: 'excluded', pattern: '触发源' },
    expect_absent: { section: 'root_cause', pattern: '触发源' },
  },
  {
    name: '根因节标题换成普通标题（v8 负对照 B：别名只在标题上认）',
    report: null,
    inline: NUMBERED_HEADINGS_REPORT,
    mutate: (r) => renameRootCauseToPlainHeading(renameFieldsToAliases(r)),
    truth: join(root, 'runs/ground-truth/F4.json'),
    expect: { accuracy: 0.0, deployment: 'excluded', correct: 'correct' },
    expect_criteria: { 'F4-C1': 'NO_SECTION' },
    expect_quality: { Q3: 'PASS' },
  },
  {
    name: '反对证据那一节真的列了反例（v9 正对照：旧词表判 FAIL）',
    report: null,
    inline: withAgainstSection(AGAINST_WITH_COUNTER_EVIDENCE),
    truth: join(root, 'runs/ground-truth/F4.json'),
    expect: { accuracy: 1.0, deployment: 'excluded', correct: 'correct' },
    expect_criteria: { 'F4-C1': 'PASS', 'F4-C2': 'PASS' },
    expect_quality: { Q3: 'PASS', Q4: 'PASS' },
    // 反例的措辞必须在 against 节里：否则这一条考的是「本来就能过的那份」。
    expect_present: {
      section: 'against',
      pattern: '读不到|只能证明|不构成|无因果贡献',
    },
    // 旧词表里的词一个都不许有：只有这样，v9 才是这条校准的鉴别点。
    expect_absent: {
      section: 'against',
      pattern: '未解释|尚未解释|无法|未能|缺口|存疑|不完整',
    },
  },
  {
    name: '反对证据那一节只复述了排除项（v9 负对照：列了三条不等于列了反例）',
    report: null,
    inline: withAgainstSection(AGAINST_WITH_EXCLUSIONS_ONLY),
    truth: join(root, 'runs/ground-truth/F4.json'),
    expect: { accuracy: 1.0, deployment: 'excluded', correct: 'correct' },
    expect_criteria: { 'F4-C1': 'PASS', 'F4-C2': 'PASS' },
    expect_quality: { Q3: 'PASS', Q4: 'FAIL' },
    expect_present: { section: 'against', pattern: '已排除' },
  },
];

let failures = 0;
console.log('\n=== 打分器校准 ===\n');
for (const c of CASES) {
  const raw = c.inline ?? readFileSync(c.report, 'utf8');
  const mutProblems = [];
  let reportText = raw;
  if (c.mutate) {
    try {
      reportText = c.mutate(raw);
    } catch (e) {
      mutProblems.push(`手术失败：${e.message}`);
    }
  }
  const truth = JSON.parse(readFileSync(c.truth, 'utf8'));
  const sections = extractSections(reportText);
  const accuracy = scoreAccuracy(truth.accuracy, sections);
  const deployment = scoreDeployment(
    truth.deployment_attribution?.expected,
    truth.deployment_attribution,
    sections,
  );

  // 判据级断言：只看总分不够。负对照要证明的是「C2 那一环没被放过」，
  // 而不是「总分碰巧不是 1.0」。
  const critProblems = [];
  for (const [id, want] of Object.entries(c.expect_criteria ?? {})) {
    const got = accuracy.results.find((r) => r.id === id)?.result;
    if (got !== want)
      critProblems.push(`${id} 判成 ${got ?? '（缺该判据）'}，期望 ${want}`);
  }
  for (const [id, want] of Object.entries(c.expect_deployment_checks ?? {})) {
    const got = deployment.checks.find((r) => r.id === id)?.result;
    if (got !== want)
      critProblems.push(`${id} 判成 ${got ?? '（缺该判据）'}，期望 ${want}`);
  }
  // 质量判据（Q1–Q4）以前从不被校准——它们只进指标表，
  // 于是「切段认不出来」这件事在质量维度上是隐形的。v8 起纳入断言。
  for (const [id, want] of Object.entries(c.expect_quality ?? {})) {
    const spec = (truth.quality ?? []).find((q) => q.id === id);
    if (!spec) {
      critProblems.push(`真值里没有 ${id} 这条质量判据`);
      continue;
    }
    const got = runCheck(spec, sections).result;
    if (got !== want)
      critProblems.push(`${id} 判成 ${got ?? '（缺该判据）'}，期望 ${want}`);
  }

  // 手术有效性断言：证明「手术后的报告」确实是手术后的那份，
  // 而不是「本来就能过的那份」——否则这一条校准是假证据。
  for (const [label, spec] of [
    ['expect_present', c.expect_present],
    ['expect_absent', c.expect_absent],
  ]) {
    if (!spec) continue;
    const sec = sections[spec.section] ?? '';
    const hit = new RegExp(spec.pattern, 'i').test(sec);
    if (label === 'expect_present' && !hit) {
      mutProblems.push(
        `${spec.section} 节里应当出现「${spec.pattern}」，实际没有`,
      );
    }
    if (label === 'expect_absent' && hit) {
      mutProblems.push(
        `${spec.section} 节里不应出现「${spec.pattern}」，实际出现了（手术没生效？）`,
      );
    }
  }

  const ok =
    accuracy.score === c.expect.accuracy &&
    deployment.verdict === c.expect.deployment &&
    deployment.correct === c.expect.correct &&
    critProblems.length === 0 &&
    mutProblems.length === 0;
  if (!ok) failures += 1;
  console.log(
    `${ok ? '[PASS]' : '[FAIL]'} ${c.name}\n` +
      `        准确率 ${accuracy.score}（期望 ${c.expect.accuracy}，tier=${accuracy.tier}）` +
      ` | 发布归因 ${deployment.verdict}（期望 ${c.expect.deployment}）` +
      ` | 判定 ${deployment.correct}（期望 ${c.expect.correct}）` +
      (c.expect_criteria
        ? ` | 判据 ${Object.entries(c.expect_criteria)
            .map(
              ([id, want]) =>
                `${id}=${accuracy.results.find((r) => r.id === id)?.result ?? '—'}(期望${want})`,
            )
            .join(' ')}`
        : ''),
  );
  if (!ok) {
    for (const p of critProblems) console.log(`        判据不符：${p}`);
    for (const p of mutProblems) console.log(`        手术不符：${p}`);
    for (const r of accuracy.results) {
      if (r.result === 'FAIL')
        console.log(
          `        未通过：${r.id} ${r.name} → ${(r.missing_patterns ?? []).join(' | ')}`,
        );
    }
    for (const ch of deployment.checks) {
      if (ch.result === 'FAIL')
        console.log(`        未通过：${ch.id} ${ch.name}`);
    }
  }
}

console.log('');
if (failures) {
  console.log(
    `校准失败：${failures}/${CASES.length} 项与人工审计结论不一致。\n`,
  );
  process.exit(1);
}
console.log(
  `校准通过：${CASES.length}/${CASES.length} 项与人工审计结论一致。\n`,
);
