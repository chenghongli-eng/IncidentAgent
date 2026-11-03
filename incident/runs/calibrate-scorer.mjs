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
 * 用法：node incident/runs/calibrate-scorer.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const { scoreReport, extractSections, scoreAccuracy, scoreDeployment } = await import(
  new URL('./score-report.mjs', import.meta.url).href
);

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
      '```diff\n'
      + '-        order.put("ship_to", "UNKNOWN");\n'
      + '+        order.put("ship_to", profile.get("address"));\n'
      + '```',
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
 * 替换必须真的发生。找不到原文就抛错——手术悄悄没生效的话，
 * 校准会以「本来就能过的报告」冒充「手术后的报告」通过，那是假证据。
 */
function replaceOnce(report, from, to) {
  if (!report.includes(from)) {
    throw new Error(`手术没找到待替换的原文：${from.slice(0, 48)}…`);
  }
  return report.replace(from, to);
}

/** 同上，替换一整块（按正则定位）。 */
function replaceBlock(report, re, to) {
  if (!re.test(report)) {
    throw new Error(`手术没找到待替换的区块：${re}`);
  }
  return report.replace(re, to);
}

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
    expect_absent: { section: 'root_cause', pattern: 'commit|提交|代码变更|重新引入|revert' },
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
    expect_absent: { section: 'root_cause', pattern: 'commit|提交|代码变更|重新引入|revert' },
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
  const deployment = scoreDeployment(truth.deployment_attribution?.expected, truth.deployment_attribution, sections);

  // 判据级断言：只看总分不够。负对照要证明的是「C2 那一环没被放过」，
  // 而不是「总分碰巧不是 1.0」。
  const critProblems = [];
  for (const [id, want] of Object.entries(c.expect_criteria ?? {})) {
    const got = accuracy.results.find((r) => r.id === id)?.result;
    if (got !== want) critProblems.push(`${id} 判成 ${got ?? '（缺该判据）'}，期望 ${want}`);
  }
  for (const [id, want] of Object.entries(c.expect_deployment_checks ?? {})) {
    const got = deployment.checks.find((r) => r.id === id)?.result;
    if (got !== want) critProblems.push(`${id} 判成 ${got ?? '（缺该判据）'}，期望 ${want}`);
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
      mutProblems.push(`${spec.section} 节里应当出现「${spec.pattern}」，实际没有`);
    }
    if (label === 'expect_absent' && hit) {
      mutProblems.push(`${spec.section} 节里不应出现「${spec.pattern}」，实际出现了（手术没生效？）`);
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
    `${ok ? '[PASS]' : '[FAIL]'} ${c.name}\n`
    + `        准确率 ${accuracy.score}（期望 ${c.expect.accuracy}，tier=${accuracy.tier}）`
    + ` | 发布归因 ${deployment.verdict}（期望 ${c.expect.deployment}）`
    + ` | 判定 ${deployment.correct}（期望 ${c.expect.correct}）`
    + (c.expect_criteria
      ? ` | 判据 ${Object.entries(c.expect_criteria)
        .map(([id, want]) => `${id}=${accuracy.results.find((r) => r.id === id)?.result ?? '—'}(期望${want})`)
        .join(' ')}`
      : ''),
  );
  if (!ok) {
    for (const p of critProblems) console.log(`        判据不符：${p}`);
    for (const p of mutProblems) console.log(`        手术不符：${p}`);
    for (const r of accuracy.results) {
      if (r.result === 'FAIL') console.log(`        未通过：${r.id} ${r.name} → ${(r.missing_patterns ?? []).join(' | ')}`);
    }
    for (const ch of deployment.checks) {
      if (ch.result === 'FAIL') console.log(`        未通过：${ch.id} ${ch.name}`);
    }
  }
}

console.log('');
if (failures) {
  console.log(`校准失败：${failures}/${CASES.length} 项与人工审计结论不一致。\n`);
  process.exit(1);
}
console.log(`校准通过：${CASES.length}/${CASES.length} 项与人工审计结论一致。\n`);
