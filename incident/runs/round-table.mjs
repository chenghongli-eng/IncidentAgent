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
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const RUNS = here;
const NODE = process.execPath;

const { scoreV1 } = await import(new URL('./score-report-v1-replay.mjs', import.meta.url).href);

/**
 * manifest 里没有审计结果的那几轮（旧版 runner 写的），
 * 现在用同一份审计脚本当场补跑——审计口径不能因为「当时没跑」就留空。
 */
function auditTranscript(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  const r = spawnSync(NODE, [join(RUNS, 'channel-audit.mjs'), transcriptPath, '--json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { verdict: 'not_run', why: r.err || r.stdout || '审计脚本没产出可解析的结果' };
  }
}

const manifests = readdirSync(RUNS)
  .filter((f) => f.startsWith('round-manifest-') && f.endsWith('.json'))
  .sort();

const rows = [];
for (const f of manifests) {
  const m = JSON.parse(readFileSync(join(RUNS, f), 'utf8'));
  const scorePath = m.score?.path ?? join(RUNS, `score-${m.stamp}.json`);
  let score = null;
  if (scorePath && existsSync(scorePath)) {
    score = JSON.parse(readFileSync(scorePath, 'utf8'));
  }
  let ca = m.channel_audit;
  if ((!ca || ca.verdict === 'not_run') && m.agent?.transcript) {
    ca = auditTranscript(m.agent.transcript);
  }
  const contaminated = ca?.verdict === 'contaminated';
  // 一轮要算数，三条都得满足：跑完了 Agent（有分数）、manifest 没标记无效、审计没判污染。
  // 中止在闸门或注入阶段的轮次没有分数，一律不算数。
  const ranAgent = Boolean(score);
  const valid = m.round_valid !== false && !m.invalid_reason && !contaminated && ranAgent;
  rows.push({
    stamp: m.stamp,
    fault: m.fault,
    manifest: f,
    valid,
    invalid_reason:
      m.invalid_reason
      ?? (contaminated ? '通道污染：审计判定 contaminated' : null)
      ?? (ranAgent ? null : '未跑完（中止或 dry-run，没有报告）'),
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
      ? score.quality.map((q) => `${q.id}${q.result === 'PASS' ? '✓' : '✗'}`).join(' ')
      : null,
    needs_review: score?.needs_review?.length ?? null,
  });
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

const yn = (v) => (v === null || v === undefined ? '—' : v ? '是' : '否');
const pad = (s, n) => String(s).padEnd(n, ' ');

console.log('\n| 轮次 | 故障 | 通道审计 | 有效 | 准确率 | 发布归因 | 质量判据 | rubric | manifest |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of rows) {
  const audit = r.audit === 'not_run'
    ? '未跑'
    : `${r.audit}（污染 ${r.contaminating ?? '?'} / 越界 ${r.out_of_surface ?? '?'}）`;
  const dep = r.deployment === null
    ? '—'
    : `${r.deployment}${r.deployment_correct === 'correct' ? ' ✓' : r.deployment_correct === 'wrong' ? ' ✗' : ''}`;
  console.log(
    `| ${r.stamp} | ${r.fault} | ${audit} | ${yn(r.valid)} | `
    + `${r.accuracy === null ? '—' : r.accuracy.toFixed(1)} | ${dep} | ${r.quality ?? '—'} | `
    + `${r.rubric_version ?? '—'} | \`${r.manifest}\` |`,
  );
}

console.log('\n### 每轮的注入与告警锚点（人工复核用）\n');
console.log('| 轮次 | 注入 commit | 注入时刻 | 告警 activeAt | 无效原因 |');
console.log('| --- | --- | --- | --- | --- |');
for (const r of rows) {
  console.log(
    `| ${r.stamp} | ${r.injection_commit ?? '—'} | ${r.injection_at ?? '—'} | `
    + `${r.alert_active_at ?? '—'} | ${r.invalid_reason ? r.invalid_reason.split('\n')[0] : '—'} |`,
  );
}

/**
 * 新旧分数并列：v1 口径重放 vs v2 实测 vs v3 实测。
 *
 * v1 的重建可信度由 `score-report-v1-replay.mjs` 自检保证——
 * 它必须复现两条**独立记录在案**的 v1 结果（0423Z=0.5、0431Z=0.0）。
 *
 * v2 那一列读的是归档件 `score-<stamp>.v2.json`，不是现算的：
 * 归档件是当时原样存下来的原件，现算的 v2 结果只能证明「重算一致」，
 * 不能替代原件。
 */
const REPORTS = [
  ['2026-10-26T0222Z', 'F2'],
  ['2026-10-26T0432Z', 'F4'],
  ['2026-10-27T0727Z', 'F4'],
  ['2026-10-30T0350Z', 'F4'],
  ['2026-10-30T0423Z', 'F4'],
  ['2026-10-30T0431Z', 'F4'],
  ['2026-10-30T0738Z', 'F2'],
];

console.log('\n### 新旧判据分数并列（v1 重放 / v2 实测 / v3 实测）\n');
console.log('| 轮次 | 故障 | v1 准确率 | v1 发布归因 | v2 准确率 | v2 发布归因 | v3 准确率 | v3 发布归因 | 差异来源 |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const [stamp, faultId] of REPORTS) {
  const reportPath = join(RUNS, `agent-report-${stamp}.md`);
  if (!existsSync(reportPath)) continue;
  const v1 = scoreV1(readFileSync(reportPath, 'utf8'), faultId);
  const v2Path = join(RUNS, `score-${stamp}.v2.json`);
  const v3Path = join(RUNS, `score-${stamp}.json`);
  const v2 = existsSync(v2Path) ? JSON.parse(readFileSync(v2Path, 'utf8')) : null;
  const v3 = existsSync(v3Path) ? JSON.parse(readFileSync(v3Path, 'utf8')) : null;
  const diff = [];
  if (v3 && v1.accuracy !== v3.root_cause_accuracy) diff.push('v1→v3 准确率');
  if (v3 && v1.verdict !== v3.deployment_attribution) diff.push('v1→v3 发布归因');
  if (v2 && v3 && v2.root_cause_accuracy !== v3.root_cause_accuracy) diff.push('v2→v3 准确率');
  if (v2 && v3 && v2.deployment_attribution !== v3.deployment_attribution) diff.push('v2→v3 发布归因');
  console.log(
    `| ${stamp} | ${faultId} | ${v1.accuracy.toFixed(1)}（${v1.tier}） | ${v1.verdict} | `
    + `${v2 ? v2.root_cause_accuracy.toFixed(1) : '—'} | ${v2 ? v2.deployment_attribution : '—'} | `
    + `${v3 ? v3.root_cause_accuracy.toFixed(1) : '—'} | ${v3 ? v3.deployment_attribution : '—'} | `
    + `${diff.length ? diff.join(' + ') : '无'} |`,
  );
}
console.log('');
