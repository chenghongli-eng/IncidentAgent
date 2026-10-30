#!/usr/bin/env node
/**
 * v1 判据重放——只为「新旧分数并列披露」服务，不参与任何指标。
 *
 * 为什么要有这个文件：判据从 v1 改到 v2 时没有 git 历史（score-report.mjs 当时还没入库），
 * 所以旧分数没法直接翻出来。但改判据的纪律要求新旧并列，
 * 否则「改了判据之后分数变好」这件事就没法自证。
 *
 * 这是**重建**的 v1 口径，不是历史文件。重建的可信度靠一件事担保：
 * 它必须复现两个**独立记录在案**的 v1 结果——
 *   2026-10-30T0423Z → 准确率 0.5（发布归因 excluded）
 *   2026-10-30T0431Z → 准确率 0.0（六个字段全 NO_SECTION）
 * 复现不出来就说明重建是错的，这个文件就没有披露价值。
 *
 * v1 → v2 的四处差别（与 score-report.mjs 头部注释一致）：
 *   1. 切段：v1 只认 markdown 标题（extractSectionsLegacy），v2 按契约标记。
 *   2. C2 的 null：v1 只认「返回…null」，v2 接受折叠成/变成/降级为/转成…null。
 *   3. Q3：v1 数「排除」两个字出现 3 次，v2 数条目数 ≥3。
 *   4. Q2：v1 在 root_cause 一节里找三个固定词，v2 取全文、词表扩到 11 个层级词、
 *      要求至少命中两次。
 *   5. F2 的 D2：v1 用邻近式（必要条件 + commit 字样），v2 改成主语绑定（发布…不是触发源）。
 *
 * 用法：node incident/runs/score-report-v1-replay.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const { extractSectionsLegacy } = await import(new URL('./score-report.mjs', import.meta.url).href);

/** v1 的 C2：只认「返回…null」。 */
const C2_V1 = '[^。\\n]{0,20}返回[^。\\n]{0,10}null|return\\s+null';
/** v1 的 Q2：在根因节里找这三个固定词。 */
const Q2_V1_WORDS = ['触发因素|触发源|触发因', '必要条件|前提条件', '放大条件|放大器'];
/** v1 的 F2 D2：邻近式（对 F4 是对的，对 F2 是假阳性——这正是要改成主语绑定的原因）。 */
const D2_V1_BROAD =
  '排除[^。\\n]{0,40}(触发源|触发因)|(不是|并非|非)[^。\\n]{0,20}(触发源|触发因)|(必要条件|前提条件)[^。\\n]{0,80}(commit|提交|代码变更|发布|部署)|(发布|代码变更|代码缺陷|commit|提交|部署|上线)[^|\\n]{0,50}\\|[^|\\n]{0,8}(排除|不是触发因|非触发因)';

function hit(text, pattern) {
  return new RegExp(pattern, 'i').test(text);
}

function countOf(text, pattern) {
  return (text.match(new RegExp(pattern, 'gi')) ?? []).length;
}

/** v1 的 Q3：数「排除」两个字出现几次。 */
function q3V1Count(text) {
  return countOf(text, '排除');
}

/**
 * 按 v1 口径打一份报告。
 *
 * 只实现 v1 真正用到的判据子集——v2 里新增的 min_items、契约切段、
 * 主语绑定 F2-D2 全部按 v1 的写法还原。
 */
export function scoreV1(report, faultId) {
  const sections = extractSectionsLegacy(report);
  const rootCause = sections.root_cause;
  const whole = sections.whole;

  const c2Patterns =
    faultId === 'F2'
      ? [C2_V1, '判空|兜底|未判空|无判空', 'NullPointer|NPE', '500']
      : ['Read timed out|读超时|超时', C2_V1, '判空|兜底|未判空|无判空', 'NullPointer|NPE'];

  const c1Pattern =
    faultId === 'F2'
      ? '(触发源|触发因|根因|直接致因|根本原因|机制)[^\\n]{0,160}(commit|提交|代码变更|重新引入|回滚|OrderService|loadOrder|判空|兜底)|(commit|提交|代码变更|重新引入|回滚|OrderService|loadOrder|判空|兜底)[^\\n]{0,160}(触发源|触发因|根因|直接致因|根本原因|机制)'
      : '(触发源|触发因|根因|直接致因|根本原因|机制)[^\\n]{0,160}(DOWNSTREAM_TIMEOUT_MS|超时旋钮|timeout|运行时旋钮|运行时配置|配置层)|(DOWNSTREAM_TIMEOUT_MS|超时旋钮|timeout|运行时旋钮|运行时配置|配置层)[^\\n]{0,160}(触发源|触发因|根因|直接致因|根本原因|机制)';

  const c1Extra = faultId === 'F2' ? ['commit|提交|代码变更|重新引入|revert', 'OrderService|loadOrder|判空|兜底'] : [];

  const c1Pass =
    rootCause !== null && hit(rootCause, c1Pattern) && c1Extra.every((p) => hit(rootCause, p));
  const c2Pass = rootCause !== null && c2Patterns.every((p) => hit(rootCause, p));

  let accuracy = 0.0;
  let tier = 'miss';
  if (c1Pass && c2Pass) { accuracy = 1.0; tier = 'hit'; }
  else if (c1Pass) { accuracy = 0.5; tier = 'partial'; }

  // 发布归因
  const isTriggerPattern =
    '(触发源|根因|直接致因|根本原因|机制)[^\\n]{0,120}(commit|提交|代码变更|重新引入|回滚)';
  const saysIs = rootCause !== null && hit(rootCause, isTriggerPattern);
  const notTriggerPattern =
    faultId === 'F2'
      ? D2_V1_BROAD
      : '排除[^。\\n]{0,40}(触发源|触发因)|(不是|并非|非)[^。\\n]{0,20}(触发源|触发因)|(必要条件|前提条件)[^。\\n]{0,80}(commit|提交|代码变更|发布|部署)|(发布|代码变更|代码缺陷|commit|提交|部署|上线)[^|\\n]{0,50}\\|[^|\\n]{0,8}(排除|不是触发因|非触发因)';
  const saysNot = whole !== null && hit(whole, notTriggerPattern);

  let verdict;
  if (saysNot && !saysIs) verdict = 'excluded';
  else if (saysIs && !saysNot) verdict = 'relevant';
  else verdict = 'unclear';
  const expected = faultId === 'F2' ? 'relevant' : 'excluded';
  const correct =
    verdict === 'unclear' ? 'unclear' : (verdict === expected ? 'correct' : 'wrong');

  // 质量判据
  const anchors = sections.anchors;
  const q1 =
    anchors !== null &&
    hit(anchors, '告警|activeAt') &&
    hit(anchors, '首次|首现') &&
    hit(anchors, '部署|重建|上线|容器启动');

  const q2 =
    rootCause !== null &&
    Q2_V1_WORDS.every((p) => hit(rootCause, p)) &&
    countOf(rootCause, '触发因素|触发源|触发因|必要条件|前提条件|放大条件|放大器') >= 2;

  const excluded = sections.excluded;
  const q3 = excluded !== null && q3V1Count(excluded) >= 3;

  const against = sections.against;
  const q4 = against !== null && hit(against, '未解释|尚未解释|无法|未能|缺口|存疑|不完整');

  return {
    accuracy,
    tier,
    verdict,
    correct,
    quality: { Q1: q1, Q2: q2, Q3: q3, Q4: q4 },
    no_section: Object.entries(sections)
      .filter(([k, v]) => v === null)
      .map(([k]) => k),
  };
}

/**
 * 两个独立记录在案的 v1 结果。重建必须复现它们，否则重建不可信。
 * 这两条是**当时**看报告人工判的，不是从 v1 代码算出来的。
 */
const KNOWN_V1 = {
  '2026-10-30T0423Z': { accuracy: 0.5, verdict: 'excluded' },
  '2026-10-30T0431Z': { accuracy: 0.0, verdict: 'excluded' },
};

const ROUNDS = [
  ['2026-10-26T0222Z', 'F2'],
  ['2026-10-26T0432Z', 'F4'],
  ['2026-10-27T0727Z', 'F4'],
  ['2026-10-30T0350Z', 'F4'],
  ['2026-10-30T0423Z', 'F4'],
  ['2026-10-30T0431Z', 'F4'],
];

export { ROUNDS, KNOWN_V1, root };

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  console.log('\n=== v1 判据重放 ===\n');
  let fidelityFails = 0;
  for (const [stamp, faultId] of ROUNDS) {
    const report = readFileSync(join(root, `runs/agent-report-${stamp}.md`), 'utf8');
    const v1 = scoreV1(report, faultId);
    const known = KNOWN_V1[stamp];
    let fidelity = null;
    if (known) {
      fidelity = v1.accuracy === known.accuracy && v1.verdict === known.verdict;
      if (!fidelity) fidelityFails += 1;
    }
    console.log(
      `${stamp} (${faultId})  准确率 ${v1.accuracy.toFixed(1)} (${v1.tier})`
      + `  发布归因 ${v1.verdict} (${v1.correct})`
      + `  质量 ${Object.entries(v1.quality).map(([k, v]) => `${k}=${v ? 'P' : 'F'}`).join(' ')}`
      + (v1.no_section.length ? `  缺节 ${v1.no_section.join(',')}` : '')
      + (fidelity === null ? '' : fidelity ? '  [重建保真 ✓]' : '  [重建保真 ✗ 与记录在案的 v1 不符]'),
    );
  }

  console.log('');
  if (fidelityFails) {
    console.log(`⚠️ 重建没能复现 ${fidelityFails} 条记录在案的 v1 结果——重建不可信，不能用来做新旧并列披露。\n`);
    process.exit(1);
  }
  console.log('重建复现了全部记录在案的 v1 结果，可用于新旧并列披露。\n');
}
