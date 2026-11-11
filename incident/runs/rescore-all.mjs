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
 * 扫哪个目录可以指定：真实靶子的轮次在**仓库外**
 * （`~/incident-lab-archive/lab-data/rounds`，真值在 `~/incident-lab-archive/real-ground-truth/`）。
 * 以前这个脚本只扫仓库内，于是「改了判据就全部重打」这条纪律
 * **只覆盖了仓库那一半**——真实轮次那一半留在旧 rubric 下，
 * 而指标表把两边的数并排放着，没人看得出来。
 * 目录是参数：给了就扫那个目录，不给就扫仓库内。
 *
 * 用法：
 *   node incident/runs/rescore-all.mjs --dry-run
 *   node incident/runs/rescore-all.mjs
 *   node incident/runs/rescore-all.mjs /home/fs-user/incident-lab-archive/lab-data/rounds
 *   node incident/runs/rescore-all.mjs <目录> --truth <新真值> --only-fault <故障ID>
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNS = resolve(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = resolve(RUNS, '..', '..');
const DRY_RUN = process.argv.includes('--dry-run');
const DIR_ARG = process.argv.slice(2).find((a) => !a.startsWith('-'));
const DIR = DIR_ARG ? resolve(DIR_ARG) : RUNS;

/**
 * `--truth <真值文件>` / `--only-fault <故障ID>`：用**新的**真值重打。
 *
 * 为什么需要：重打的真值路径是从**旧分数文件**里读的（`ground_truth` 字段）。
 * 判据改版时，旧的真值文件路径还记在分数文件里——于是「换了判据就全部重打」
 * 这条纪律**打不中**：它永远用旧版本打，改了判据等于没改。
 *
 * `--only-fault` 是配套的安全闸：真值文件是按故障类型分的，一个目录里往往躺着
 * 好几类故障的轮次，不限定故障 ID 就会拿 A 故障的判据去打 B 故障的报告。
 * 两者必须一起给；只给 `--truth` 而不给 `--only-fault` 时直接拒绝执行。
 */
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
const TRUTH_OVERRIDE = argValue('--truth');
const ONLY_FAULT = argValue('--only-fault');
if (TRUTH_OVERRIDE && !ONLY_FAULT) {
  process.stderr.write(
    '给了 --truth 却没有 --only-fault：那个目录里可能躺着别的故障类型的轮次，' +
      '拿一份真值去打所有报告会打乱那张表。两者一起给。\n',
  );
  process.exit(1);
}

const { scoreReport } = await import(
  new URL('./score-report.mjs', import.meta.url).href
);

/**
 * 旧分数文件里的路径有三种写法：
 *   1. 相对轮次目录（`agent-report-….md`）——大多数轮次
 *   2. 绝对路径（`/mnt/…/incident/runs/…`）——最近几轮
 *   3. `<repo>/incident/runs/…`——**脱敏过的**（11-03 那轮手工替换过）
 *
 * 第 3 种以前会被当成「报告读不到」**静默跳过**——那一轮于是留在了旧 rubric 下，
 * 指标表里混着两个版本，而表本身看不出来。这就是 L1 改动面第 14 项说的
 * 「脱敏是手工的」的代价：现在把 `<repo>` 也认了，别再跳过。
 */
function resolveMaybe(p) {
  if (!p) return null;
  if (p.startsWith('<repo>/'))
    return join(REPO_ROOT, p.slice('<repo>/'.length));
  if (p.startsWith('/')) return p;
  return join(DIR, p);
}

/** 存回分数文件里的路径写相对 DIR 的形式（仓库内那批仍是相对 incident/runs）。 */
function relToDir(p) {
  const r = relative(DIR, p);
  return r.startsWith('..') ? p : r;
}

const scoreFiles = readdirSync(DIR)
  .filter((f) => /^score-\d{4}-\d{2}-\d{2}T\d{4}Z\.json$/.test(f))
  .sort();

if (!scoreFiles.length) {
  process.stderr.write(`没有找到任何 score-<stamp>.json（扫的是 ${DIR}）。\n`);
  process.exit(1);
}

const rows = [];
for (const f of scoreFiles) {
  const path = join(DIR, f);
  const old = JSON.parse(readFileSync(path, 'utf8'));
  const stamp = f.replace(/^score-/, '').replace(/\.json$/, '');

  const reportPath = resolveMaybe(old.report);
  const truthOverrideApplies =
    TRUTH_OVERRIDE && ONLY_FAULT && old.fault_id === ONLY_FAULT;
  const truthPath = truthOverrideApplies
    ? resolve(TRUTH_OVERRIDE)
    : resolveMaybe(old.ground_truth);
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
    reportPath: relToDir(reportPath),
    truthPath: relToDir(truthPath),
  });

  // 「变了」不只看准确率：质量判据（Q1–Q4）变了也得算变了。
  // v9 只动 Q4 词表，准确率与发布归因一字未改——
  // 只看前两项的话，这一轮会被报成「无变化」，而它的 Q4 其实翻了个个儿。
  const qualitySig = (s) =>
    JSON.stringify((s.quality ?? []).map((q) => [q.id, q.result]));
  const changed =
    old.root_cause_accuracy !== score.root_cause_accuracy ||
    old.accuracy_tier !== score.accuracy_tier ||
    old.deployment_attribution !== score.deployment_attribution ||
    qualitySig(old) !== qualitySig(score) ||
    // 换了真值文件也算「变了」：分数文件里记着用的是哪份判据，
    // 只换判据不改分数的话，那一行会指着旧真值——口径就说不清了。
    (truthOverrideApplies &&
      old.ground_truth !== relToDir(truthPath) &&
      old.ground_truth !== truthPath);

  // 同一个判据版本再跑一遍，结论一模一样：一个字节都不改。
  //
  // 为什么必须幂等：重打会往分数文件里写 `rescored_from`（记它是从哪一版
  // 重打来的）。同一个版本重打两次，第二次就会把 `rescored_from` 从 v8 改成
  // v9，文件内容变了——于是「归档已存在且内容不同」的护栏会在**第三次**
  // 运行时误报：那不是有人改过这一轮，是这个脚本自己上一轮改的。
  // 无变化就不归档、不写盘：护栏只在真的要归档时才该说话。
  if (
    !changed &&
    (old.rubric_version ?? null) === (score.rubric_version ?? null)
  ) {
    rows.push({
      stamp,
      file: f,
      archiveName: null,
      changed: false,
      qualityChanged: false,
      old,
      score,
      manifest: null,
      manifestPath: null,
      skipped: true,
    });
    continue;
  }

  score.rescored_from = {
    rubric_version: old.rubric_version ?? null,
    root_cause_accuracy: old.root_cause_accuracy ?? null,
    accuracy_tier: old.accuracy_tier ?? null,
    deployment_attribution: old.deployment_attribution ?? null,
    deployment_attribution_correct: old.deployment_attribution_correct ?? null,
  };

  // 归档：旧文件原样保留，文件名带上旧版本号。
  const oldVersion = old.rubric_version ?? 'v0';
  // 换了真值文件时，归档名带上真值文件名：否则同一轮在两种判据下的两份分数
  // 会抢同一个归档名，护栏会在第二次重打时误报「有人改过这一轮」。
  const truthTag = truthOverrideApplies
    ? `.${basename(truthPath).replace(/\.json$/, '')}`
    : '';
  const archiveName = `score-${stamp}.${oldVersion}${truthTag}.json`;
  const archivePath = join(DIR, archiveName);
  if (existsSync(archivePath)) {
    const archived = readFileSync(archivePath, 'utf8');
    if (archived !== readFileSync(path, 'utf8')) {
      process.stderr.write(
        `归档已存在且内容不同：${archiveName}\n` +
          '  这一轮在归档之后又被改过。先查清楚，别拿新的盖掉旧的。\n',
      );
      process.exit(1);
    }
  }

  const manifestPath = join(DIR, `round-manifest-${stamp}.json`);
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : null;

  rows.push({
    stamp,
    file: f,
    archiveName,
    changed,
    qualityChanged: qualitySig(old) !== qualitySig(score),
    old,
    score,
    manifest,
    manifestPath,
  });

  if (DRY_RUN) continue;

  if (!existsSync(archivePath))
    writeFileSync(archivePath, readFileSync(path, 'utf8'));
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

console.log(`\n扫的目录：${DIR}`);
console.log(`rubric：${rows[0]?.score.rubric_version ?? '—'}\n`);
console.log(
  '| 轮次 | 旧版本 | 旧分数 | 新分数 | 旧发布归因 | 新发布归因 | 变化 |',
);
console.log('| --- | --- | --- | --- | --- | --- | --- |');
for (const r of rows) {
  console.log(
    `| ${r.stamp} | ${r.old.rubric_version} | ${r.old.root_cause_accuracy}（${r.old.accuracy_tier}） | ` +
      `${r.score.root_cause_accuracy}（${r.score.accuracy_tier}） | ${r.old.deployment_attribution} | ` +
      `${r.score.deployment_attribution} | ${r.changed ? '**变了**' : '无'} |`,
  );
}
const changedCount = rows.filter((r) => r.changed).length;
const qualityChangedCount = rows.filter((r) => r.qualityChanged).length;
console.log(
  `\n共 ${rows.length} 轮重打，${changedCount} 轮发生变化（其中 ${qualityChangedCount} 轮是质量判据变了）。`,
);
if (DRY_RUN) console.log('（dry run，没有写任何文件）');
console.log('');
