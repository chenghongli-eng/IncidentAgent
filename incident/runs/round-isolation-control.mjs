#!/usr/bin/env node
/**
 * 证据面隔离（台账轮转 + Prometheus 清零）的对照实验。
 *
 *   node incident/runs/round-isolation-control.mjs
 *
 * 判据量的不是「隔离跑了没」，而是**隔离之后证据面里还剩不剩上一轮的东西**。
 * 每条负对照都要配一条**近似正对照**：只证明「坏东西被清掉了」，
 * 不能排除「所有东西都被清掉了」——那是把量具做成一把永远说干净的刷子。
 *
 * 对照表：
 *   A 负：台账里有上一轮实验室自己的发布记录 → 轮转后它不在场（外来记录 = 0）
 *   B 正（近似）：同一份台账去掉那条记录 → 轮转后**真实发布史与基线身份记录仍在**
 *   C 负：Prometheus 里有历史序列 → 重建后序列数归零
 *   D 正（近似）：重建之后靶子被抓到 → 序列数重新大于 0（面是真的，不是被掐死）
 *   E 负：基线种子不存在 → 轮转**报错**（不是「悄悄通过」）
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  rotateLedger,
  countForeignLabEntries,
  resetPrometheus,
  countSeries,
  countAppSeries,
} from './round-isolation.mjs';
import {
  loadSpec,
  startTarget,
  stopTarget,
  waitReady,
} from './real-target.mjs';

const LAB_PATHS = JSON.parse(
  readFileSync(new URL('../lab-paths.json', import.meta.url), 'utf8'),
);

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}：${detail}`);
};

const tmp = mkdtempSync(join(tmpdir(), 'isolation-control-'));

/** 一份台账：真实发布史 + 基线身份记录 + 可选的上一轮实验室发布记录。 */
function makeLedger(path, { withForeign } = {}) {
  const lines = [
    JSON.stringify({
      digest: 'sha256:aaa',
      image_ref: 'registry.example:5000/team/app:645',
      commit: 'c1',
      commit_source: 'jenkins-build',
    }),
    JSON.stringify({
      digest: 'sha256:bbb',
      image_ref: '/lab/artifacts/651',
      commit: 'c2',
      commit_source: 'jenkins-build',
      pod_started_at: '2026-11-10T00:00:00Z',
    }),
  ];
  if (withForeign) {
    lines.push(
      JSON.stringify({
        digest: 'sha256:ccc',
        image_ref: '/lab/artifacts/rel-2026-11-11T0719Z',
        commit: 'c3',
        commit_source: 'jenkins-build',
      }),
    );
  }
  writeFileSync(path, `${lines.join('\n')}\n`);
}

// ── A / B：台账轮转 ────────────────────────────────────────────────
const seedPath = join(tmp, 'seed.jsonl');
writeFileSync(
  seedPath,
  `${[
    JSON.stringify({
      digest: 'sha256:aaa',
      image_ref: 'registry.example:5000/team/app:645',
      commit: 'c1',
      commit_source: 'jenkins-build',
    }),
    JSON.stringify({
      digest: 'sha256:bbb',
      image_ref: '/lab/artifacts/651',
      commit: 'c2',
      commit_source: 'jenkins-build',
      pod_started_at: '2026-11-10T00:00:00Z',
    }),
  ].join('\n')}\n`,
);

const ledgerA = join(tmp, 'ledger-a.jsonl');
makeLedger(ledgerA, { withForeign: true });
rotateLedger({
  ledgerPath: ledgerA,
  seedPath,
  archiveDir: join(tmp, 'archive'),
  stamp: 'control',
});
const foreign = countForeignLabEntries(ledgerA, {
  baselineArtifactDir: '/lab/artifacts/651',
});
check(
  'A 负对照：上一轮实验室自己的发布记录轮转后不在场',
  foreign === 0,
  `外来记录 ${foreign} 条（期望 0）`,
);
check(
  'B 正对照（近似）：真实发布史与基线身份记录仍在',
  readFileSync(ledgerA, 'utf8').includes(
    'registry.example:5000/team/app:645',
  ) && readFileSync(ledgerA, 'utf8').includes('/lab/artifacts/651'),
  '轮转后台账里真实发布史与基线身份记录都还在',
);
check(
  'B 正对照（近似）：旧台账被归档而不是被删',
  readFileSync(join(tmp, 'archive', 'ledger-control.jsonl'), 'utf8').includes(
    'rel-2026-11-11T0719Z',
  ),
  '归档件里读得到上一轮那条记录',
);

// ── E：种子不存在必须报错 ─────────────────────────────────────────
let threw = false;
try {
  rotateLedger({
    ledgerPath: join(tmp, 'ledger-e.jsonl'),
    seedPath: join(tmp, 'no-such-seed.jsonl'),
    archiveDir: join(tmp, 'archive'),
    stamp: 'control',
  });
} catch {
  threw = true;
}
check(
  'E 负对照：基线种子不存在时报错而不是悄悄通过',
  threw,
  threw ? '抛错' : '没抛错',
);

// ── F：基线制品目录的两种写法都要认（发布类 vs 运行时类规格）─────────
//
// 判据只认一种写法时，另一类故障的基线身份记录会被当成「实验室自己造的
// 发布」→ 闸门误中止。R1 批次就是这么秒退的：R2 规格把基线写在
// phases.baseline.artifactDir，R1 规格只有顶层 artifactDir。
//
// 三条对照用同一份台账，只换传给判据的那个目录。
const ledgerF = join(tmp, 'ledger-f.jsonl');
makeLedger(ledgerF, { withForeign: false });
rotateLedger({
  ledgerPath: ledgerF,
  seedPath,
  archiveDir: join(tmp, 'archive'),
  stamp: 'control',
});
const foreignR1Form = countForeignLabEntries(ledgerF, {
  baselineArtifactDir: '/lab/artifacts/651',
});
const foreignWrongDir = countForeignLabEntries(ledgerF, {
  baselineArtifactDir: '/lab/artifacts/999',
});
check(
  'F 正对照（近似）：基线目录按运行时类规格的写法给出 → 不算外来',
  foreignR1Form === 0,
  `外来记录 ${foreignR1Form} 条（期望 0）`,
);
check(
  'F 负对照：基线目录给错 → 基线身份记录被认成外来（判据确实在起作用）',
  foreignWrongDir > 0,
  `外来记录 ${foreignWrongDir} 条（期望 >0）`,
);

// ── C / D：Prometheus 清零 ─────────────────────────────────────────
// 靶子必须先停：靶子跑着的话，重建后的 Prometheus 会立刻抓到它，
// 序列数就不可能是 0——那时候判负的是「靶子还活着」，不是「没清干净」。
// 停靶子用实验室自己的 stopTarget（按端口找监听进程，只停那一个）。
const specPath = LAB_PATHS.realLaunchSpec.replace(
  /launch-spec\.json$/,
  'launch-spec-release.json',
);
const spec = loadSpec(specPath);
const stopped = await stopTarget(spec);
console.log(
  `（对照前先停靶子：${stopped.stopped ? `已停 pid ${stopped.pid ?? '?'}` : stopped.why}）`,
);

const promUrl = 'http://127.0.0.1:9094';
// 靶子的应用标签从仓库外的描述文件取（真实项目的名字不进公开仓库）。
const DESCRIPTOR =
  process.env.INCIDENT_TARGET_FILE ??
  join(
    process.env.HOME ?? '/root',
    'incident-lab-archive/targets/p2-real.json',
  );
const APP = JSON.parse(readFileSync(DESCRIPTOR, 'utf8')).application;
const before = await countAppSeries(promUrl, APP).catch(() => null);
let prom = null;
let promError = null;
try {
  prom = await resetPrometheus({
    promUrl,
    composeFile: new URL('../docker-compose.yml', import.meta.url).pathname,
    envFile: join(process.env.HOME ?? '/root', '.config/miniclaw-lab/lab.env'),
    service: 'prometheus-real',
    appLabel: APP,
  });
} catch (err) {
  promError = err.message;
}
check(
  'C 负对照：重建后 Prometheus 里靶子自己的序列归零',
  prom !== null && prom.series_after === 0,
  prom
    ? `重建前靶子序列 ${before ?? '(查不到)'} → 重建后 ${prom.series_after}；` +
        `容器换新=${prom.recreated}、时序库卷换新=${prom.volume_renewed}`
    : `重建失败：${promError}`,
);

// D 正对照：把靶子拉起来（基线态），确认序列数重新大于 0。
// 这一步证明「面是真的」——清零不是把 Prometheus 掐死了。
let seriesAfterTarget = null;
try {
  startTarget(spec, { env: {} });
  const ready = await waitReady(spec, {
    expectedStatus: 200,
    timeoutMs: 180000,
  });
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    seriesAfterTarget = await countAppSeries(promUrl, APP);
    if (seriesAfterTarget > 0) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  await stopTarget(spec);
} catch (err) {
  seriesAfterTarget = null;
  promError = `${promError ?? ''} | 正对照拉靶子失败：${err.message}`;
}
check(
  'D 正对照（近似）：靶子起来后它的序列重新大于 0（面是真的）',
  typeof seriesAfterTarget === 'number' && seriesAfterTarget > 0,
  `序列数 ${seriesAfterTarget ?? '(没量到)'}${promError ? `（${promError}）` : ''}`,
);

const failed = results.filter((r) => !r.ok);
console.log(`\n对照通过 ${results.length - failed.length}/${results.length}`);
process.exit(failed.length === 0 ? 0 : 1);
