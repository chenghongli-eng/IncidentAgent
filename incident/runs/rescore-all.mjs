#!/usr/bin/env node
/**
 * 用同一个 rubric 版本把**所有**轮次重新打一遍。
 *
 * 为什么需要这个脚本：rubric 一改，历史分数就不能直接和新的并排放——
 * 一张表里混着 v1 和 v2 的数，谁也说不清某个数字是哪个口径出来的。
 * 纪律是「改了判据就全部重打」，而「全部重打」必须可复现，不能靠手抄
 * （这个项目栽过的跟头就是「数字与证据表不一致」）。
 *
 * 它做三件事：
 *   1. 旧分数归档到 `score-<stamp>.<旧版本>.json`（原样保留，不改一个字）
 *   2. 用当前 rubric 重打，写回 `score-<stamp>.json`，并记下 `rescored_from`
 *   3. 把 manifest 里内嵌的那份分数摘要同步过来
 *
 * 「报告 ↔ 真值」的配对从**旧分数文件**里读，不从文件名单独推断——
 * 配对错一次，整张表就错一次。
 *
 * 用法：
 *   node incident/runs/rescore-all.mjs --dry-run
 *   node incident/runs/rescore-all.mjs
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNS = resolve(dirname(fileURLToPath(import.meta.url)));
const DRY_RUN = process.argv.includes('--dry-run');

const { scoreReport } = await import(new URL('./score-report.mjs', import.meta.url).href);

/** 旧分数文件里的路径可能是相对的（相对 incident/runs），也可能是绝对的。 */
function resolveMaybe(p) {
  if (!p) return null;
  if (p.startsWith('/')) return p;
  return join(RUNS, p);
}

const scoreFiles = readdirSync(RUNS)
  .filter((f) => /^score-\d{4}-\d{2}-\d{2}T\d{4}Z\.json$/.test(f))
  .sort();

if (!scoreFiles.length) {
  process.stderr.write('没有找到任何 score-<stamp>.json，先跑一轮再说。\n');
  process.exit(1);
}

const rows = [];
for (const f of scoreFiles) {
  const path = join(RUNS, f);
  const old = JSON.parse(readFileSync(path, 'utf8'));
  const stamp = f.replace(/^score-/, '').replace(/\.json$/, '');

  const reportPath = resolveMaybe(old.report);
  const truthPath = resolveMaybe(old.ground_truth);
  if (!reportPath || !existsSync(reportPath)) {
    process.stderr.write(`跳过 ${f}：报告读不到（${old.report}）\n`);
    continue;
  }
  if (!truthPath || !existsSync(truthPath)) {
    process.stderr.write(`跳过 ${f}：真值文件读不到（${old.ground_truth}）\n`);
    continue;
  }

  const truth = JSON.parse(readFileSync(truthPath, 'utf8'));
  const score = scoreReport(readFileSync(reportPath, 'utf8'), truth, {
    reportPath: reportPath.replace(`${RUNS}/`, ''),
    truthPath: truthPath.replace(`${RUNS}/`, ''),
  });
  score.rescored_from = {
    rubric_version: old.rubric_version ?? null,
    root_cause_accuracy: old.root_cause_accuracy ?? null,
    accuracy_tier: old.accuracy_tier ?? null,
    deployment_attribution: old.deployment_attribution ?? null,
    deployment_attribution_correct: old.deployment_attribution_correct ?? null,
  };

  // 归档：旧文件原样保留，文件名带上旧版本号。
  const oldVersion = old.rubric_version ?? 'v0';
  const archiveName = `score-${stamp}.${oldVersion}.json`;
  const archivePath = join(RUNS, archiveName);
  if (existsSync(archivePath)) {
    const archived = readFileSync(archivePath, 'utf8');
    if (archived !== readFileSync(path, 'utf8')) {
      process.stderr.write(
        `归档已存在且内容不同：${archiveName}\n`
        + '  这一轮在归档之后又被改过。先查清楚，别拿新的盖掉旧的。\n',
      );
      process.exit(1);
    }
  }

  const manifestPath = join(RUNS, `round-manifest-${stamp}.json`);
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;

  const changed =
    old.root_cause_accuracy !== score.root_cause_accuracy ||
    old.accuracy_tier !== score.accuracy_tier ||
    old.deployment_attribution !== score.deployment_attribution;

  rows.push({ stamp, file: f, archiveName, changed, old, score, manifest, manifestPath });

  if (DRY_RUN) continue;

  if (!existsSync(archivePath)) writeFileSync(archivePath, readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify(score, null, 2));
  if (manifest) {
    manifest.score = {
      path,
      rubric_version: score.rubric_version,
      root_cause_accuracy: score.root_cause_accuracy,
      accuracy_tier: score.accuracy_tier,
      deployment_attribution: score.deployment_attribution,
      deployment_attribution_correct: score.deployment_attribution_correct,
      deployment_expected: score.deployment_expected,
      needs_review: score.needs_review,
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }
}

console.log(`\nrubric：${rows[0]?.score.rubric_version ?? '—'}\n`);
console.log('| 轮次 | 旧版本 | 旧分数 | 新分数 | 旧发布归因 | 新发布归因 | 变化 |');
console.log('| --- | --- | --- | --- | --- | --- | --- |');
for (const r of rows) {
  console.log(
    `| ${r.stamp} | ${r.old.rubric_version} | ${r.old.root_cause_accuracy}（${r.old.accuracy_tier}） | `
    + `${r.score.root_cause_accuracy}（${r.score.accuracy_tier}） | ${r.old.deployment_attribution} | `
    + `${r.score.deployment_attribution} | ${r.changed ? '**变了**' : '无'} |`,
  );
}
const changedCount = rows.filter((r) => r.changed).length;
console.log(`\n共 ${rows.length} 轮重打，${changedCount} 轮分数发生变化。`);
if (DRY_RUN) console.log('（dry run，没有写任何文件）');
console.log('');
