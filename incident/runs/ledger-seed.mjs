#!/usr/bin/env node
/**
 * 从当前台账生成**基线种子**：每一轮开跑前用它把台账轮转回「起点状态」。
 *
 *   node incident/runs/ledger-seed.mjs --spec <启动规格> --out <种子路径>
 *
 * 为什么需要它（跨轮泄漏的第三条通道）：
 *   部署台账是 append-only 的，实验室自己每一轮造出来的发布（rel-* 制品）
 *   都留在里面。Agent 一次 `deploy list` 就能看到「上一轮也发了个新版本、
 *   然后就 503 了」——方向上的答案直接摆在证据面上。真实项目的发布史
 *   （registry 里那几条 645–651）不是泄漏：那是这一轮**该看见**的证据，
 *   发布归因就靠它。
 *
 * 保留规则（每条都要有理由，不靠「看起来像」）：
 *   · registry 引用（host:port/path:tag）→ 真实项目的发布史，全部保留；
 *   · 本地基线制品目录（启动规格里 phases.baseline.artifactDir）→
 *     保留**一条**身份记录（最早的一条，commit 来源最硬的那条），
 *     其余的「上次跑起来了」是上一轮的观测，丢掉；
 *   · 其它本地路径（上一轮实验室自己造出来的发布目录）→ 全部丢掉。
 *
 * 种子文件放在仓库外（它是真实项目的历史，不进公开仓库）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i === -1 ? dflt : args[i + 1];
};

const SPEC = opt('--spec');
const OUT = opt('--out');
if (!SPEC || !OUT) {
  console.error(
    'usage: ledger-seed.mjs --spec <启动规格> --out <种子路径> [--ledger <台账路径>]',
  );
  process.exit(2);
}

const spec = JSON.parse(readFileSync(SPEC, 'utf8'));
const baselineDir = spec.phases?.baseline?.artifactDir;
if (!baselineDir) {
  console.error('启动规格里没有 phases.baseline.artifactDir，生成不了种子。');
  process.exit(1);
}

// 台账路径：从启动规格自己推不出来（规格里没有），所以由 lab-paths.json 给。
const LAB_PATHS = JSON.parse(
  readFileSync(new URL('../lab-paths.json', import.meta.url), 'utf8'),
);
const LEDGER = opt('--ledger', LAB_PATHS.realLedger);

/**
 * registry 引用：host:port/path:tag。
 *
 * 端口是必须的：合成夹具的本地镜像引用形如 `incident/target-service:baseline`
 * （没有端口），它也长得像「host/path:tag」，放它进来就等于把夹具的部署
 * 混进真实项目的发布史。真实项目的 registry 带端口（host:port/...），
 * 这条规则把两类分开。
 */
const isRegistryRef = (ref) =>
  /^[A-Za-z0-9._\-]+:\d+\/[^\s]+:[^\s]+$/.test(ref);

const rows = readFileSync(LEDGER, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const kept = [];
const dropped = [];
const baselineRows = [];

for (const row of rows) {
  const ref = row.image_ref ?? '';
  if (isRegistryRef(ref)) {
    kept.push({ row, why: 'registry：真实项目的发布史' });
    continue;
  }
  if (ref === baselineDir) {
    baselineRows.push(row);
    continue;
  }
  dropped.push({
    image_ref: ref,
    digest: row.digest,
    why: '实验室上一轮自己造出来的发布（不是真实项目的历史）',
  });
}

// 基线制品只留一条身份记录：commit 来源最硬的那条，同源时取最早的一条。
const authority = {
  'oci-label': 3,
  annotation: 3,
  'jenkins-build': 3,
  'git-window': 2,
  'git-head-fallback': 2,
  'jenkins-parameter': 1,
  manual: 1,
};
baselineRows.sort((a, b) => {
  const aa = authority[a.commit_source] ?? 0;
  const ba = authority[b.commit_source] ?? 0;
  if (aa !== ba) return ba - aa;
  const at = Date.parse(a.pod_started_at ?? a.observed_at ?? '') || 0;
  const bt = Date.parse(b.pod_started_at ?? b.observed_at ?? '') || 0;
  return at - bt;
});
if (baselineRows.length > 0) {
  const pick = baselineRows[0];
  kept.push({ row: pick, why: '基线制品的身份记录（只留一条）' });
  for (const row of baselineRows.slice(1)) {
    dropped.push({
      image_ref: row.image_ref,
      digest: row.digest,
      why: '上一轮「基线制品跑起来了」的观测',
    });
  }
}

if (kept.length === 0) {
  console.error('种子是空的——这样每一轮开跑前都会丢掉全部发布史，不许写。');
  process.exit(1);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  kept.map((k) => JSON.stringify(k.row)).join('\n') + '\n',
  'utf8',
);

console.log(`种子已写入：${OUT}`);
console.log(`  保留 ${kept.length} 条，丢弃 ${dropped.length} 条`);
for (const k of kept) {
  console.log(
    `  + ${k.row.digest?.slice(0, 12) ?? '(无 digest)'} ${k.why}：${k.row.image_ref}`,
  );
}
const byWhy = new Map();
for (const d of dropped) {
  byWhy.set(d.why, (byWhy.get(d.why) ?? 0) + 1);
}
for (const [why, n] of byWhy) console.log(`  - ${n} 条：${why}`);
