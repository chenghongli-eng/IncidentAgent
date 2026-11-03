#!/usr/bin/env node
/**
 * 从 manifest + score 文件生成指标表（markdown）。
 *
 * 为什么不让手打：这份台账吃过一次「数字与证据表不一致」的亏——
 * 指标表里的数是抄出来的，抄错一处没人看得出来。
 * 所以表由脚本从 round-manifest-*.json 与 score-*.json 直接生成，
 * 每个数都带得回它的来源文件。
 *
 * 用法：
 *   node incident/runs/round-table.mjs            # markdown 表
 *   node incident/runs/round-table.mjs --json     # 结构化
 *   node incident/runs/round-table.mjs <manifest目录>  # 换目录（负对照用）
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
// 负对照要能在临时目录里造合成 manifest，所以目录可以覆盖。
// 默认还是脚本自己所在的目录——真实表格永远从 incident/runs/ 出。
const RUNS_ARG = process.argv.slice(2).find((a) => !a.startsWith('-'));
const RUNS = RUNS_ARG ? resolve(RUNS_ARG) : here;
const REPO_ROOT = join(here, '../..');
const NODE = process.execPath;

const { scoreV1 } = await import(
  new URL('./score-report-v1-replay.mjs', import.meta.url).href
);

/**
 * manifest 里的路径在提交时做过脱敏：绝对路径被换成 `<repo>` / `<home>` 占位符。
 * 直接拿它当文件路径用会找不到文件——0738Z 那样「有报告、有分数、通道干净」的轮次
 * 会因为 score=null 被误判成「未跑完（中止或 dry-run，没有报告）」，
 * 指标表因此显示不出任何一轮的有效性。
 *
 * 所以逐个候选解析：原样 → 剥掉占位符前缀后按仓库根解析 → 按 RUNS 下的文件名解析。
 * 全部落空就返回 null，让调用方知道「这个面没拿到」而不是默默当成没有。
 */
function resolveRepoPath(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const stripped = raw.replace(/^<(?:repo|home)>\/?/, '');
  const candidates = [
    raw,
    join(REPO_ROOT, stripped),
    join(RUNS, basename(stripped)),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * manifest 里没有审计结果的那几轮（旧版 runner 写的），
 * 现在用同一份审计脚本当场补跑——审计口径不能因为「当时没跑」就留空。
 *
 * 审计跑不起来 = **这轮算不算数不知道**，不能当成「没发现问题」。
 * 2026-11-02 实测过：审计脚本用 `process.exit()` 收尾，stdout 是管道时
 * 会截断自己的 JSON（19911 字节只剩 16384），`JSON.parse` 炸掉，
 * 旧写法把它降级成 `verdict: 'not_run'`——而 'not_run' 不是 'contaminated'，
 * 于是这一轮**照常被算成有效证据**。
 * 所以这里解析失败就让它炸：宁可表格生成不出来，也不能悄悄放行。
 */
function auditTranscript(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  const r = spawnSync(
    NODE,
    [join(here, 'channel-audit.mjs'), transcriptPath, '--json'],
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  try {
    return JSON.parse(r.stdout);
  } catch (e) {
    throw new Error(
      `通道审计的输出不是合法 JSON（${transcriptPath}）：${e.message}\n` +
        `脚本退出码 ${r.status}，输出 ${(r.stdout ?? '').length} 字节。\n` +
        '审计跑不起来就不能判这轮有效——先修审计，再出表。',
    );
  }
}

const manifests = readdirSync(RUNS)
  .filter((f) => f.startsWith('round-manifest-') && f.endsWith('.json'))
  .sort();

const rows = [];
for (const f of manifests) {
  const m = JSON.parse(readFileSync(join(RUNS, f), 'utf8'));
  const scorePath =
    resolveRepoPath(m.score?.path) ?? join(RUNS, `score-${m.stamp}.json`);
  let score = null;
  if (scorePath && existsSync(scorePath)) {
    score = JSON.parse(readFileSync(scorePath, 'utf8'));
  }
  let ca = m.channel_audit;
  /**
   * 当场重跑审计，并与 manifest 里存的那份对账。
   *
   * 不一致只有两种可能：审计脚本改过（口径变了），或者证据被动过。
   * 两种都不能悄悄选一边——所以这一轮直接作废，逼人先查清楚。
   * 口径变更的那次就发生过：0738Z 的记录是旧版脚本写的「污染 0 处」，
   * 修好相对路径判定后是「污染 1 处」。
   */
  const fresh = m.agent?.transcript
    ? auditTranscript(resolveRepoPath(m.agent.transcript))
    : null;
  let auditMismatch = null;
  if (fresh) {
    if (
      ca &&
      ca.verdict !== 'not_run' &&
      (ca.contaminating !== fresh.contaminating ||
        ca.out_of_surface !== fresh.out_of_surface)
    ) {
      auditMismatch =
        `审计记录（污染 ${ca.contaminating} / 越界 ${ca.out_of_surface}）` +
        `与当场审计（污染 ${fresh.contaminating} / 越界 ${fresh.out_of_surface}）不一致`;
    }
    ca = fresh;
  }
  const contaminated = ca?.verdict === 'contaminated';
  // 一轮要算数，三条都得满足：跑完了 Agent（有分数）、manifest 没标记无效、审计没判污染。
  // 中止在闸门或注入阶段的轮次没有分数，一律不算数。
  const ranAgent = Boolean(score);
  /**
   * 「审计没跑成」不等于「审计说没问题」。
   *
   * 2026-11-02 复现出来的洞：transcript 解析不出来时 `fresh` 是 null，
   * 于是只剩 manifest 里存的那份——而 runner 在审计脚本挂掉时会写
   * `{verdict:'not_run'}`。这一路组合（有分数 + 无 transcript + 审计 not_run）
   * 原先会被判成**有效轮**，准确率照样进表。
   *
   * 这正是 0350Z 的病根：那一轮当时没留审计记录，表里「没有污染」=「没有污染」。
   * 它是因为后来手工补跑审计才作废的，不是表自己发现的。
   * 所以这里补一条：**审计状态未知 = 这一轮不算数**。
   */
  const auditUnknown = !fresh && (!ca || ca.verdict === 'not_run');
  const valid =
    m.round_valid !== false &&
    !m.invalid_reason &&
    !contaminated &&
    !auditMismatch &&
    !auditUnknown &&
    ranAgent;
  rows.push({
    stamp: m.stamp,
    fault: m.fault,
    manifest: f,
    valid,
    invalid_reason:
      m.invalid_reason ??
      auditMismatch ??
      (contaminated ? '通道污染：审计判定 contaminated' : null) ??
      (auditUnknown
        ? '通道审计状态未知：transcript 解析不出来且审计未跑成'
        : null) ??
      (ranAgent ? null : '未跑完（中止或 dry-run，没有报告）'),
    audit: ca?.verdict ?? 'not_run',
    contaminating: ca?.contaminating ?? null,
    out_of_surface: ca?.out_of_surface ?? null,
    injection_commit: m.injection?.commit ?? null,
    injection_at: m.injection?.at ?? null,
    alert_active_at: m.alert?.activeAt ?? null,
    rubric_version: score?.rubric_version ?? null,
    accuracy: score?.root_cause_accuracy ?? null,
    tier: score?.accuracy_tier ?? null,
    deployment: score?.deployment_attribution ?? null,
    deployment_correct: score?.deployment_attribution_correct ?? null,
    quality: score?.quality
      ? score.quality
          .map((q) => `${q.id}${q.result === 'PASS' ? '✓' : '✗'}`)
          .join(' ')
      : null,
    needs_review: score?.needs_review?.length ?? null,
  });
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2));
  // 用 exitCode 而不是 process.exit()：管道里 process.exit() 会截断输出。
  process.exitCode = 0;
}

const yn = (v) => (v === null || v === undefined ? '—' : v ? '是' : '否');
const pad = (s, n) => String(s).padEnd(n, ' ');

console.log(
  '\n| 轮次 | 故障 | 通道审计 | 有效 | 准确率 | 发布归因 | 质量判据 | rubric | manifest |',
);
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of rows) {
  const audit =
    r.audit === 'not_run'
      ? '未跑'
      : `${r.audit}（污染 ${r.contaminating ?? '?'} / 越界 ${r.out_of_surface ?? '?'}）`;
  const dep =
    r.deployment === null
      ? '—'
      : `${r.deployment}${r.deployment_correct === 'correct' ? ' ✓' : r.deployment_correct === 'wrong' ? ' ✗' : ''}`;
  console.log(
    `| ${r.stamp} | ${r.fault} | ${audit} | ${yn(r.valid)} | ` +
      `${r.accuracy === null ? '—' : r.accuracy.toFixed(1)} | ${dep} | ${r.quality ?? '—'} | ` +
      `${r.rubric_version ?? '—'} | \`${r.manifest}\` |`,
  );
}

console.log('\n### 每轮的注入与告警锚点（人工复核用）\n');
console.log('| 轮次 | 注入 commit | 注入时刻 | 告警 activeAt | 无效原因 |');
console.log('| --- | --- | --- | --- | --- |');
for (const r of rows) {
  console.log(
    `| ${r.stamp} | ${r.injection_commit ?? '—'} | ${r.injection_at ?? '—'} | ` +
      `${r.alert_active_at ?? '—'} | ${r.invalid_reason ? r.invalid_reason.split('\n')[0] : '—'} |`,
  );
}

/**
 * 新旧分数并列：v1 口径重放 vs v2 实测 vs v3 实测 vs v4 实测 vs v5 实测。
 *
 * v1 的重建可信度由 `score-report-v1-replay.mjs` 自检保证——
 * 它必须复现两条**独立记录在案**的 v1 结果（0423Z=0.5、0431Z=0.0）。
 *
 * v2 / v3 / v4 那一列读的是归档件 `score-<stamp>.v2.json` 等，
 * 不是现算的：归档件是当时原样存下来的原件，现算的结果只能证明「重算一致」，
 * 不能替代原件。v5 是当前 rubric，读的就是当前的 `score-<stamp>.json`。
 *
 * 2026-11-02T0702Z 与 2026-11-02T0827Z 两轮**通道污染、本身作废**，但分数
 * 照样进这张表：判据改了，所有轮次都得用同一个版本重打并并列披露；
 * 作废与否是通道审计的事，不是不打分的事。
 *
 * 2026-11-03T0324Z 是 provider 换成 deepseek 之后的第一轮，它只测过 v5，
 * v2/v3/v4 那一列是空的——那一轮之前的 rubric 已经改过好几版，
 * 补测旧 rubric 也换不回同一个模型，只能缺着，不能假装有。
 * 换个模型出分不等于换了标尺：这行只说明「同一份报告在 v1 口径下也是几分」。
 */
const REPORTS = [
  ['2026-10-26T0222Z', 'F2'],
  ['2026-10-26T0432Z', 'F4'],
  ['2026-10-27T0727Z', 'F4'],
  ['2026-10-30T0350Z', 'F4'],
  ['2026-10-30T0423Z', 'F4'],
  ['2026-10-30T0431Z', 'F4'],
  ['2026-10-30T0738Z', 'F2'],
  ['2026-11-02T0702Z', 'F2'],
  ['2026-11-02T0827Z', 'F2'],
  ['2026-11-03T0324Z', 'F2'],
];

console.log(
  '\n### 新旧判据分数并列（v1 重放 / v2 实测 / v3 实测 / v4 实测 / v5 实测）\n',
);
console.log(
  '| 轮次 | 故障 | v1 准确率 | v1 发布归因 | v2 准确率 | v2 发布归因 | v3 准确率 | v3 发布归因 | v4 准确率 | v4 发布归因 | v5 准确率 | v5 发布归因 | 差异来源 |',
);
console.log(
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
);
for (const [stamp, faultId] of REPORTS) {
  const reportPath = join(RUNS, `agent-report-${stamp}.md`);
  if (!existsSync(reportPath)) continue;
  const v1 = scoreV1(readFileSync(reportPath, 'utf8'), faultId);
  const readScore = (p) =>
    existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  const v2 = readScore(join(RUNS, `score-${stamp}.v2.json`));
  const v3 = readScore(join(RUNS, `score-${stamp}.v3.json`));
  const v4 = readScore(join(RUNS, `score-${stamp}.v4.json`));
  const v5 = readScore(join(RUNS, `score-${stamp}.json`));
  const diff = [];
  if (v5 && v1.accuracy !== v5.root_cause_accuracy) diff.push('v1→v5 准确率');
  if (v5 && v1.verdict !== v5.deployment_attribution)
    diff.push('v1→v5 发布归因');
  if (v4 && v5 && v4.root_cause_accuracy !== v5.root_cause_accuracy)
    diff.push('v4→v5 准确率');
  if (v4 && v5 && v4.deployment_attribution !== v5.deployment_attribution)
    diff.push('v4→v5 发布归因');
  console.log(
    `| ${stamp} | ${faultId} | ${v1.accuracy.toFixed(1)}（${v1.tier}） | ${v1.verdict} | ` +
      `${v2 ? v2.root_cause_accuracy.toFixed(1) : '—'} | ${v2 ? v2.deployment_attribution : '—'} | ` +
      `${v3 ? v3.root_cause_accuracy.toFixed(1) : '—'} | ${v3 ? v3.deployment_attribution : '—'} | ` +
      `${v4 ? v4.root_cause_accuracy.toFixed(1) : '—'} | ${v4 ? v4.deployment_attribution : '—'} | ` +
      `${v5 ? v5.root_cause_accuracy.toFixed(1) : '—'} | ${v5 ? v5.deployment_attribution : '—'} | ` +
      `${diff.length ? diff.join(' + ') : '无'} |`,
  );
}
console.log('');
