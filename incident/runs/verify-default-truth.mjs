#!/usr/bin/env node
/**
 * 验证**默认真值**与已采纳的真值口径一致。
 *
 * 为什么需要这个闸门：`run-round.mjs` 跑真实靶子轮次时，
 * 默认真值路径是 `realTruthDir/<故障ID>.json`——也就是 `R1.json` / `R2.json`。
 * 一旦这两个「默认」文件落后于实际在用的版本（`R1.v4.json` / `R2.v7.json`），
 * 新跑一轮**不带 `--truth`** 就会静默按旧口径打分：数字照出、不报错、没人看得出来。
 * 这个仓库已经栽过一次同类跟头（默认真值落后于已采纳版本，见 RESUME.md）。
 *
 * 所以「默认文件要推到最新」不能靠人记得做，要能**验**：
 *   ① 默认口径重打 == 已采纳口径重打（逐轮、逐字段）
 *   ② 默认口径重打 == 落盘的历史分数文件（逐轮、逐判据）
 *   ③ 默认口径重打 == 官方总表 `real-target-rounds.json`（只对独立样本轮次）
 *
 * 用法：
 *   node incident/runs/verify-default-truth.mjs
 *   node incident/runs/verify-default-truth.mjs --json
 *
 * 退出码：0 全部一致；1 有不一致。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const LAB_PATHS = JSON.parse(
  readFileSync(new URL('../lab-paths.json', import.meta.url), 'utf8'),
);
const TRUTH_DIR = LAB_PATHS.realTruthDir;
const ROUNDS_DIR = LAB_PATHS.realRoundsDir;

const { scoreReport } = await import(
  new URL('./score-report.mjs', import.meta.url).href
);
const official = JSON.parse(
  readFileSync(new URL('./real-target-rounds.json', import.meta.url), 'utf8'),
);

const asJson = process.argv.includes('--json');

/** 已采纳的真值版本（默认真值应该与它们逐字节相同）。 */
const ADOPTED = { R1: 'R1.v4.json', R2: 'R2.v7.json' };

const qOf = (s) =>
  (s.quality ?? [])
    .map((c) => `${c.id}=${c.result ?? (c.pass ? 'PASS' : 'FAIL')}`)
    .join(' ');

/** 比分数时排除「真值路径」——它本来就该不同（默认 vs 显式版本文件）。 */
const comparable = (s) => JSON.stringify({ ...s, ground_truth: undefined });

const files = readdirSync(ROUNDS_DIR).filter(
  (f) => f.startsWith('score-') && f.endsWith('.json') && !/\.v\d/.test(f),
);

const report = {
  rounds_total: files.length,
  default_vs_adopted: { same: 0, diff: 0 },
  default_vs_stored: { same: 0, diff: 0 },
  official_reconciliation: { checked: 0, mismatch: 0 },
  problems: [],
  rounds: [],
};

for (const f of files) {
  const stored = JSON.parse(readFileSync(join(ROUNDS_DIR, f), 'utf8'));
  const reportPath = stored.report?.startsWith('/')
    ? stored.report
    : join(ROUNDS_DIR, stored.report);
  let text;
  try {
    text = readFileSync(reportPath, 'utf8');
  } catch {
    continue; // 报告原文已被归档清理，跳过（不计入一致率）
  }

  const fault = stored.fault_id;
  const defaultPath = join(TRUTH_DIR, `${fault}.json`);
  const adoptedPath = join(TRUTH_DIR, ADOPTED[fault]);

  const withDefault = scoreReport(
    text,
    JSON.parse(readFileSync(defaultPath, 'utf8')),
    { reportPath, truthPath: defaultPath },
  );
  const withAdopted = scoreReport(
    text,
    JSON.parse(readFileSync(adoptedPath, 'utf8')),
    { reportPath, truthPath: adoptedPath },
  );

  if (comparable(withDefault) === comparable(withAdopted)) {
    report.default_vs_adopted.same++;
  } else {
    report.default_vs_adopted.diff++;
    report.problems.push({ round: f, kind: '默认口径 != 已采纳口径' });
  }

  const sameStored =
    withDefault.accuracy_tier === stored.accuracy_tier &&
    qOf(withDefault) === qOf(stored) &&
    withDefault.deployment_attribution_correct ===
      stored.deployment_attribution_correct;
  if (sameStored) {
    report.default_vs_stored.same++;
  } else {
    report.default_vs_stored.diff++;
    report.problems.push({
      round: f,
      kind: '默认口径重打 != 落盘分数',
      stored: {
        tier: stored.accuracy_tier,
        quality: qOf(stored),
        deployment: stored.deployment_attribution_correct,
      },
      now: {
        tier: withDefault.accuracy_tier,
        quality: qOf(withDefault),
        deployment: withDefault.deployment_attribution_correct,
      },
    });
  }

  const round = f.replace(/^score-|\.json$/g, '');
  const row = {
    round,
    tier: withDefault.accuracy_tier,
    quality: qOf(withDefault),
  };
  const off = official.rounds.find((r) => r.round === round);
  if (off) {
    report.official_reconciliation.checked++;
    const got = Object.fromEntries(
      row.quality.split(' ').map((p) => {
        const [id, v] = p.split('=');
        return [id, v];
      }),
    );
    const bad = Object.entries(off.quality).filter(([k, v]) => got[k] !== v);
    const tierOk = off.root_cause === 'hit' ? row.tier === 'hit' : true;
    if (bad.length || !tierOk) {
      report.official_reconciliation.mismatch++;
      report.problems.push({
        round,
        kind: '与官方总表不一致',
        official: { tier: off.root_cause, quality: off.quality },
        now: { tier: row.tier, quality: got },
      });
    }
  }
  report.rounds.push(row);
}

const ok =
  report.default_vs_adopted.diff === 0 &&
  report.default_vs_stored.diff === 0 &&
  report.official_reconciliation.mismatch === 0;

if (asJson) {
  console.log(JSON.stringify({ ok, ...report }, null, 2));
} else {
  console.log(`轮次 ${report.rounds_total} 个`);
  console.log(
    `默认口径 vs 已采纳口径：相同 ${report.default_vs_adopted.same}，不同 ${report.default_vs_adopted.diff}`,
  );
  console.log(
    `默认口径 vs 落盘分数：  相同 ${report.default_vs_stored.same}，不同 ${report.default_vs_stored.diff}`,
  );
  console.log(
    `与官方总表对账：        ${report.official_reconciliation.checked} 轮，不一致 ${report.official_reconciliation.mismatch} 轮`,
  );
  for (const p of report.problems) console.log('  ✗', JSON.stringify(p));
  console.log(ok ? '\n全部一致。' : '\n有不一致——不要拿这批数字对外。');
}

process.exit(ok ? 0 : 1);
