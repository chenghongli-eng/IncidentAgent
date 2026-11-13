#!/usr/bin/env node
/**
 * 把真实靶子上的轮次结果汇成**仓库内机器可读的总表** `real-target-rounds.json`。
 *
 * 为什么要有这个：简历包里那几条数字（几个独立样本、命中几轮、归因对几轮、
 * 分层归因几轮）原先只能回指到**仓库外**的产物——公开仓库里查不到，
 * 面试里被人追问「这个数哪来的」时只能口头解释。加上这份总表之后，
 * 数字在公开仓库里可以直接被机器核对，`validate-resume-package.mjs` 的
 * C6 会拿它跟简历包对账。
 *
 * 口径（与 `incident/RESUME.md` 的现行口径一致）：
 *   · **分母只算独立样本**：由独立性审计判 `independent` 的轮次才算数；
 *     `contaminated` 与 `unknown` 一律不进分母（unknown ≠ 干净）。
 *   · 命中按当前真值版本重打分的结果取（真值与对照在仓库外）。
 *   · 质量判据 Q1–Q4 同样只在这批独立样本上统计。
 *
 * 这份总表**只放计数与判定**，不放报告正文、不放靶子标识、不放任何公司信息
 * （仓库里的真实项目一律用代号指代）。
 *
 * 用法：
 *   node incident/runs/build-real-target-summary.mjs \
 *     --rounds  <仓库外 lab-data/rounds 目录> \
 *     --truth   <仓库外 real-ground-truth 目录> \
 *     --audit   <仓库外 independence-audit.json> \
 *     [--out    incident/runs/real-target-rounds.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  if (!v || v.startsWith('--')) throw new Error(`${flag} 后面缺参数`);
  return v;
}

const ROUNDS = resolve(arg('--rounds', ''));
const TRUTH = resolve(arg('--truth', ''));
const AUDIT = resolve(arg('--audit', ''));
const OUT = resolve(
  arg('--out', join(process.cwd(), 'incident/runs/real-target-rounds.json')),
);
if (!ROUNDS || !TRUTH || !AUDIT) {
  console.error(
    '用法：build-real-target-summary.mjs --rounds <目录> --truth <目录> --audit <file>',
  );
  process.exit(2);
}

/** 两类故障臂：R1 = 运行时环境里的阈值，R2 = 随发布进制品的阈值。 */
const ARMS = {
  R1: { fault: 'R1', truth: 'R1.v4.json' },
  R2: { fault: 'R2', truth: 'R2.v7.json' },
};

const audit = JSON.parse(readFileSync(AUDIT, 'utf8'));
const independent = new Set(audit.independent ?? []);

const rounds = [];
for (const [arm, cfg] of Object.entries(ARMS)) {
  const truth = JSON.parse(readFileSync(join(TRUTH, cfg.truth), 'utf8'));
  for (const stamp of [...independent].sort()) {
    const scorePath = join(ROUNDS, `score-${stamp}.json`);
    const manifestPath = join(ROUNDS, `round-manifest-${stamp}.json`);
    let score;
    let manifest;
    try {
      score = JSON.parse(readFileSync(scorePath, 'utf8'));
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      // 该轮不在这个臂的产物里（另一个臂的轮次），跳过。
      continue;
    }
    if (score.fault_id !== cfg.fault) continue;
    const ca = manifest.channel_audit ?? {};
    const agent = manifest.agent ?? {};
    const started = Date.parse(agent.started_at ?? '');
    const finished = Date.parse(agent.finished_at ?? '');
    rounds.push({
      round: stamp,
      arm,
      fault_id: cfg.fault,
      independent: true,
      root_cause: score.accuracy_tier,
      root_cause_correct: score.accuracy_tier === 'hit',
      deployment_attribution: score.deployment_attribution,
      deployment_attribution_correct:
        score.deployment_attribution_correct === 'correct',
      channel_audit: {
        contaminating: ca.contaminating ?? null,
        out_of_surface: ca.out_of_surface ?? null,
      },
      quality: Object.fromEntries(
        (score.quality ?? []).map((q) => [q.id, q.result]),
      ),
      agent_duration_s:
        Number.isFinite(started) && Number.isFinite(finished)
          ? Math.round((finished - started) / 1000)
          : null,
      truth_version: score.ground_truth
        ? (score.ground_truth.split('/').pop() ?? null)
        : null,
    });
  }
}

if (rounds.length !== independent.size) {
  console.error(
    `独立样本 ${independent.size} 个，但只汇出 ${rounds.length} 条产物——` +
      '产物缺失或轮次对不上，不要写出总表。',
  );
  process.exit(1);
}

const byArm = {};
for (const arm of Object.keys(ARMS)) {
  const rs = rounds.filter((r) => r.arm === arm);
  byArm[arm] = {
    rounds: rs.length,
    root_cause_hit: rs.filter((r) => r.root_cause_correct).length,
    deployment_attribution_correct: rs.filter(
      (r) => r.deployment_attribution_correct,
    ).length,
  };
}

const q = (id) => rounds.filter((r) => r.quality?.[id] === 'PASS').length;
const durations = rounds
  .map((r) => r.agent_duration_s)
  .filter((n) => Number.isFinite(n))
  .sort((a, b) => a - b);
const median =
  durations.length % 2
    ? durations[(durations.length - 1) / 2]
    : (durations[durations.length / 2 - 1] + durations[durations.length / 2]) /
      2;

const totals = {
  rounds: rounds.length,
  independent_samples: rounds.length,
  root_cause_hit: rounds.filter((r) => r.root_cause_correct).length,
  deployment_attribution_correct: rounds.filter(
    (r) => r.deployment_attribution_correct,
  ).length,
  channel_audit_clean: rounds.filter(
    (r) => (r.channel_audit.out_of_surface ?? 0) === 0,
  ).length,
  quality_pass: { Q1: q('Q1'), Q2: q('Q2'), Q3: q('Q3'), Q4: q('Q4') },
};

const ratios = {
  root_cause: {
    [ARMS.R1.fault]: `${byArm.R1.root_cause_hit}/${byArm.R1.rounds}`,
    [ARMS.R2.fault]: `${byArm.R2.root_cause_hit}/${byArm.R2.rounds}`,
    all: `${totals.root_cause_hit}/${totals.rounds}`,
  },
  deployment_attribution: {
    [ARMS.R1.fault]:
      `${byArm.R1.deployment_attribution_correct}/${byArm.R1.rounds}`,
    [ARMS.R2.fault]:
      `${byArm.R2.deployment_attribution_correct}/${byArm.R2.rounds}`,
    all: `${totals.deployment_attribution_correct}/${totals.rounds}`,
  },
  q2_layered_attribution: `${totals.quality_pass.Q2}/${totals.rounds}`,
};

const doc = {
  $comment:
    '真实靶子轮次的机器可读总表：只放计数与判定，不放报告正文、不放靶子标识。' +
    '分母只算独立性审计判为 independent 的轮次（contaminated 与 unknown 都不算数）。' +
    '由 `incident/runs/build-real-target-summary.mjs` 从仓库外的产物生成，' +
    '简历包里的数字由 `validate-resume-package.mjs` 的 C6 与本表对账。',
  generated_at: new Date().toISOString(),
  source: {
    rounds: '仓库外 lab-data/rounds 的 score-*.json 与 round-manifest-*.json',
    truth: '仓库外 real-ground-truth 下的当前真值版本',
    audit: '仓库外 independence-audit.json（独立/污染/未知的判定来源）',
  },
  fault_arms: {
    R1: '运行时环境里的阈值旋钮（制品未变）',
    R2: '随新发布进入制品的阈值配置（运行期环境干净）',
  },
  totals,
  ratios,
  per_arm: byArm,
  agent_duration_s: {
    min: durations[0] ?? null,
    median: median ?? null,
    max: durations[durations.length - 1] ?? null,
    mean: durations.length
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : null,
  },
  rounds,
};

writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n');
console.log(
  `已写出 ${OUT}\n` +
    `独立样本 ${totals.independent_samples}｜根因命中 ${ratios.root_cause.all}` +
    `｜发布归因 ${ratios.deployment_attribution.all}` +
    `｜通道干净 ${totals.channel_audit_clean}/${totals.rounds}` +
    `｜Q1 ${totals.quality_pass.Q1} Q2 ${totals.quality_pass.Q2} Q3 ${totals.quality_pass.Q3} Q4 ${totals.quality_pass.Q4}`,
);
