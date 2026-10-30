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
 *
 * 第 3、4 行是关键：打分器不能因为「报告里提到了 commit 和 null」就放行，
 * 必须看它把发布放在触发源还是必要条件的位置上。
 *
 * 第 7 行是 v3 判据的负对照。v3 把 C2 里「未判空」那一环的词表从
 * `判空|兜底` 扩到「null 守卫」的各种说法，扩得太宽就会退化成
 * 「报告里出现过 null 就算识别了机制」。所以拿 0738Z 那份真报告做手术：
 * 把守卫概念整段拿掉（措辞换成别的），其余一字不改——报告里仍然有
 * 「返回 null」「profile is null」「return null」等一大堆 null。
 * C2 必须**仍然 FAIL**：这才是「词表扩了，但没扩成空白支票」的证据。
 * 它同时断言 F2-C1 仍然 PASS（说明分数掉的是机制那一环，不是别的）。
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
];

let failures = 0;
console.log('\n=== 打分器校准 ===\n');
for (const c of CASES) {
  const raw = c.inline ?? readFileSync(c.report, 'utf8');
  const reportText = c.mutate ? c.mutate(raw) : raw;
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

  const ok =
    accuracy.score === c.expect.accuracy &&
    deployment.verdict === c.expect.deployment &&
    deployment.correct === c.expect.correct &&
    critProblems.length === 0;
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
