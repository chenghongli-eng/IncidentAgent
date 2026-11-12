#!/usr/bin/env node
/**
 * 独立性审计的负对照：审计说「污染」的时候，它**必须**是因为真有污染。
 *
 * 为什么要有这个脚本：审计是「判据」的一种——它会给轮次盖章（独立 / 污染 /
 * 未知）。盖章的东西自己也得能被人验：一个只会说「污染」的审计，等于没有审计
 * （闸门一旦只会喊狼来了，真出事时没人再信它）。
 *
 * 夹具里每份都是**两轮**：第一轮是被验的那一轮，第二轮是干净的收尾轮。
 * 第二轮存在有两个用处：
 *   · 审计有个自检（最后一轮自己的痕迹必须晚于它的注入时刻）——自检得有机会跑；
 *   · 第二轮是「近似的正对照」：同样的日志面、同样的注入提交、同样干净，
 *     结论必须是独立。两轮只差那一点，结论就得相反。
 *
 * 四条对照：
 *   A 源码面多一个「带着同样答案签名」的外来提交 → 应判污染，且外来提交数 = 1
 *   B 去掉那一个外来提交（其余完全相同）          → 应判独立
 *   C 不给原始仓库（源码面量不了）                → 应判未知，不得当成干净
 *   D 日志面里有一条早于注入时刻的痕迹行           → 应判污染，且那条要被数出来
 *   G 台账面留着上一轮实验室自己的发布记录（2 条）   → 应判污染，且条数要被数出来
 *   H 指标历史面重建后还剩 3 条序列                  → 应判污染
 *   I 这两张面没有实测值（老轮次）                   → 应判未知，不得当成干净
 *
 * 用法：node incident/runs/independence-audit-control.mjs
 * 退出码：0 = 全部对照与预期一致；1 = 有一条对不上（审计不能用了）。
 */
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const AUDIT = join(HERE, 'independence-audit.mjs');
const NODE = process.execPath;

/** 故障痕迹行（本地时区，靶子 TZ=Asia/Shanghai）。 */
function traceLine(localStamp) {
  return `${localStamp} [http-nio-123-exec-1] WARN  o.s.boot.actuate.health.Diskspace - DiskSpaceHealthIndicator - Free disk space below threshold.`;
}

/** 两轮的注入时刻（UTC）。 */
const INJECT_AT_1 = '2026-01-01T00:10:00.000Z';
const INJECT_AT_2 = '2026-01-01T00:20:00.000Z';
/** 早于第一轮注入的痕迹（本地 08:05 = UTC 00:05）。 */
const STALE_LOCAL = '2026-01-01 08:05:00.000';
/** 晚于第一轮注入的痕迹（本地 08:12 = UTC 00:12）。 */
const FRESH_LOCAL = '2026-01-01 08:12:00.000';
/** 晚于第二轮注入的痕迹（本地 08:30 = UTC 00:30）。 */
const FRESH_LOCAL_2 = '2026-01-01 08:30:00.000';

function git(cwd, args, date) {
  const stamp = date ?? '2026-01-01T00:00:00+00:00';
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'lab',
      GIT_AUTHOR_EMAIL: 'lab@example.invalid',
      GIT_COMMITTER_NAME: 'lab',
      GIT_COMMITTER_EMAIL: 'lab@example.invalid',
      GIT_AUTHOR_DATE: stamp,
      GIT_COMMITTER_DATE: stamp,
    },
  });
}

/** 在基线之上落一次注入提交（签名 = 改的那几行）。 */
function commitInjection(repo, baseCommit, marker, date) {
  git(repo, ['checkout', '-q', '--detach', baseCommit]);
  writeFileSync(
    join(repo, 'app.yaml'),
    `server:\n  port: 12306\nhealth:\n  diskspace:\n    threshold: 77GB\n${marker}\n`,
  );
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'chore(config): 调整阈值'], date);
  return git(repo, ['rev-parse', 'HEAD']).trim();
}

/**
 * 造一份夹具：
 *   pristine —— 原始仓库（项目本来就有的东西，审计的尺子）
 *   repo     —— 实验室的源码快照（pristine 的克隆 + 实验留下的提交）
 *   rounds   —— 两轮 round-manifest + 两份日志面
 */
function makeFixture(
  root,
  {
    withForeignCommit,
    withStaleTrace,
    withSecondRound = false,
    withRecordedForeign = false,
    // 2026-11-12 起审计多看两张面（部署台账、指标历史）。
    // 夹具默认给出**干净**的实测值，好让前面几条对照的结论不变；
    // withLedgerForeign / withPromSeries 用来造这两张面被污染的那一档；
    // withoutIsolation 造「这一轮没有这两个实测值」（老轮次的情形）。
    withLedgerForeign = 0,
    withPromSeries = 0,
    withoutIsolation = false,
  },
) {
  const pristine = join(root, 'pristine');
  const repo = join(root, 'repo');
  const rounds = join(root, 'rounds');
  const logs1 = join(root, 'logs-1');
  const logs2 = join(root, 'logs-2');
  mkdirSync(pristine, { recursive: true });
  mkdirSync(rounds, { recursive: true });
  mkdirSync(logs1, { recursive: true });
  mkdirSync(logs2, { recursive: true });

  // 原始仓库：项目本来就有的一个文件与提交。
  git(pristine, ['init', '-q', '-b', 'develop']);
  writeFileSync(join(pristine, 'app.yaml'), 'server:\n  port: 12306\n');
  git(pristine, ['add', '.']);
  git(
    pristine,
    ['commit', '-q', '-m', '项目基线'],
    '2025-12-01T00:00:00+00:00',
  );

  // 实验室快照：克隆原始仓库。
  execFileSync('git', ['clone', '-q', pristine, repo], { encoding: 'utf8' });
  const baseCommit = git(repo, ['rev-parse', 'HEAD']).trim();

  // 外来提交：**同样**的签名，早于本轮注入时刻 —— 它就是「上一轮留下的答案」。
  // 两者的差别只有一行注释（每轮注入都会写一行 `# build <标记>`），
  // 审计的签名判据把注释行去掉之后，两者就该被认成同一处注入。
  if (withForeignCommit) {
    git(repo, ['checkout', '-q', '--detach', baseCommit]);
    writeFileSync(
      join(repo, 'app.yaml'),
      'server:\n  port: 12306\nhealth:\n  diskspace:\n    threshold: 77GB\n# build 更早的一轮\n',
    );
    git(repo, ['add', '.']);
    git(
      repo,
      ['commit', '-q', '-m', '更早一轮的同款注入'],
      '2025-12-31T00:00:00+00:00',
    );
  }

  // 每一轮各自的注入提交：**都**建在基线上（真实靶子每轮都回到基线再注入），
  // 签名一样，只是标记行与时刻不同。
  const ownCommit1 = commitInjection(
    repo,
    baseCommit,
    '# build 第一轮',
    '2026-01-01T00:09:00+00:00',
  );
  // 第二轮（如果要的话）用**另一份干净的快照**：只含它自己那一次注入。
  // 这正是修好之后的靶子该有的样子——每轮的源码面里只有本轮自己的注入，
  // 前一轮的提交已经被清掉了。它同时也是「判据没有把所有人一律判污染」的对照。
  let repo2 = null;
  let ownCommit2 = null;
  if (withSecondRound) {
    repo2 = join(root, 'repo-2');
    execFileSync('git', ['clone', '-q', pristine, repo2], { encoding: 'utf8' });
    const base2 = git(repo2, ['rev-parse', 'HEAD']).trim();
    ownCommit2 = commitInjection(
      repo2,
      base2,
      '# build 第二轮',
      '2026-01-01T00:19:00+00:00',
    );
  }

  // 日志面：第一轮（含可选的陈旧痕迹）；第二轮（有的话）是干净的收尾轮。
  const lines1 = withStaleTrace
    ? [traceLine(STALE_LOCAL), traceLine(FRESH_LOCAL)]
    : [traceLine(FRESH_LOCAL)];
  writeFileSync(join(logs1, 'all.log'), lines1.join('\n') + '\n');
  writeFileSync(join(logs2, 'all.log'), traceLine(FRESH_LOCAL_2) + '\n');

  const manifest = (
    stamp,
    injectedAt,
    logs,
    ownCommit,
    sourceRepo,
    recordedForeign,
  ) => ({
    stamp,
    injection: {
      fault: 'CTRL',
      at: injectedAt,
      release_commit: ownCommit,
      source_repo: sourceRepo ?? repo,
      evidence_surface: { dir: logs, pid: 1, source: '夹具' },
      ...(recordedForeign
        ? {
            // 源码面的**开跑时实测**：这一轮量到源码面里有一个外来的提交。
            // 仓库本身在这份夹具里是干净的——事后重测会读到 0，
            // 但那一轮开跑时源码面确实不干净。
            source_surface: {
              measured_at: injectedAt,
              head: ownCommit,
              foreign_count: 1,
              answering_count: 1,
              foreign_shas: ['0123456789abcdef0123456789abcdef01234567'],
              pristine_repo: pristine,
              source: 'measured-at-injection',
            },
          }
        : {}),
    },
    target: {
      facts: { measured_logs_dir: logs },
      ...(withoutIsolation
        ? {}
        : {
            isolation: {
              ledger: { foreign_entries: withLedgerForeign },
              prometheus: { series_after: withPromSeries },
            },
          }),
    },
  });
  writeFileSync(
    join(rounds, 'round-manifest-2026-01-01T0000Z.json'),
    JSON.stringify(
      manifest(
        '2026-01-01T0000Z',
        INJECT_AT_1,
        logs1,
        ownCommit1,
        repo,
        withRecordedForeign,
      ),
      null,
      2,
    ),
  );
  const map = { '2026-01-01T0000Z': logs1 };
  if (withSecondRound) {
    writeFileSync(
      join(rounds, 'round-manifest-2026-01-01T0001Z.json'),
      JSON.stringify(
        manifest('2026-01-01T0001Z', INJECT_AT_2, logs2, ownCommit2, repo2),
        null,
        2,
      ),
    );
    map['2026-01-01T0001Z'] = logs2;
  }
  writeFileSync(join(rounds, 'surface-map.json'), JSON.stringify(map));

  return { pristine, repo, rounds, logs1, logs2, ownCommit1, ownCommit2 };
}

function runAudit(fixture, { withPristine = true } = {}) {
  const out = join(fixture.rounds, 'audit.json');
  const args = [
    AUDIT,
    fixture.rounds,
    '--source-repo',
    fixture.repo,
    '--surface-map',
    join(fixture.rounds, 'surface-map.json'),
    '--out',
    out,
  ];
  if (withPristine) args.push('--pristine-repo', fixture.pristine);
  execFileSync(NODE, args, { encoding: 'utf8' });
  return JSON.parse(readFileSync(out, 'utf8'));
}

const results = [];
function expect(id, why, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push({ id, why, got, want, ok });
}

function withFixture(name, opts, fn) {
  const root = mkdtempSync(join(tmpdir(), `independence-ctl-${name}-`));
  try {
    fn(makeFixture(root, opts));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── 对照 A：真有外来提交 → 应判污染 ──────────────────────────────────────
withFixture('a', { withForeignCommit: true, withStaleTrace: false }, (fx) => {
  const audit = runAudit(fx);
  const row = audit.rounds[0];
  const src = row.surfaces.find((s) => s.surface === 'source_repo');
  expect(
    'A-foreign-commit',
    '源码面里有一个带同样答案签名的外来提交 → 判污染，且外来提交数 = 1',
    {
      verdict: row.verdict,
      foreign: src.foreign_count,
      answering: src.answering_count,
    },
    { verdict: 'contaminated', foreign: 1, answering: 1 },
  );
});

// ── 对照 B：只差那一个外来提交 → 应判独立 ───────────────────────────────
withFixture('b', { withForeignCommit: false, withStaleTrace: false }, (fx) => {
  const audit = runAudit(fx);
  const row = audit.rounds[0];
  const src = row.surfaces.find((s) => s.surface === 'source_repo');
  expect(
    'B-no-foreign-commit',
    '与 A 逐项相同，只是没有外来提交 → 判独立（判据量的确实是污染，不是别的）',
    { verdict: row.verdict, foreign: src.foreign_count },
    { verdict: 'independent', foreign: 0 },
  );
});

// ── 对照 C：量不到的面不许当成干净 ───────────────────────────────────────
withFixture('c', { withForeignCommit: true, withStaleTrace: false }, (fx) => {
  const audit = runAudit(fx, { withPristine: false });
  const row = audit.rounds[0];
  const src = row.surfaces.find((s) => s.surface === 'source_repo');
  expect(
    'C-unmeasurable-is-unknown',
    '没有原始仓库就量不了源码面 → 记 unknown（不得记成干净）',
    { status: src.status, verdict: row.verdict },
    { status: 'not_measured', verdict: 'unknown' },
  );
});

// ── 对照 D：日志面里的陈旧痕迹要被数出来 ──────────────────────────────────
withFixture(
  'd',
  { withForeignCommit: false, withStaleTrace: true, withSecondRound: true },
  (fx) => {
    const audit = runAudit(fx);
    const row = audit.rounds[0];
    const chan = row.surfaces.find((s) => s.surface === 'logs_channel');
    expect(
      'D-stale-log-trace',
      '日志面里早于注入时刻的痕迹行必须被数出来（时区换算没错）',
      {
        stale: chan.traces_before_injection,
        total: chan.traces_total,
        verdict: row.verdict,
      },
      { stale: 1, total: 2, verdict: 'contaminated' },
    );
    expect(
      'D-clean-second-round',
      '同一份夹具里的干净收尾轮 → 判独立（判据没有把所有人一律判污染）',
      { verdict: audit.rounds[1].verdict },
      { verdict: 'independent' },
    );
  },
);

// ── 对照 E：以**开跑时的实测**为准，不以事后重测为准 ──────────────────────
withFixture(
  'e',
  {
    withForeignCommit: false,
    withStaleTrace: false,
    withRecordedForeign: true,
  },
  (fx) => {
    const audit = runAudit(fx);
    const row = audit.rounds[0];
    const src = row.surfaces.find((s) => s.surface === 'source_repo');
    expect(
      'E-recorded-surface-wins',
      'manifest 记着开跑时源码面有 1 个外来提交（仓库现在已被下一轮清干净）→ 仍判污染：审计量的是「Agent 当时看到的那张面」',
      { verdict: row.verdict, foreign: src.foreign_count, from: src.from },
      {
        verdict: 'contaminated',
        foreign: 1,
        from: 'manifest 记录的本轮实测（开跑时量的）',
      },
    );
  },
);

// ── 对照 F：空目录不是干净目录 ────────────────────────────────────────────
withFixture('f', { withForeignCommit: false, withStaleTrace: false }, (fx) => {
  // 把日志面里的 .log 挪走，只留一个空目录：这就是「量不到」，不是「0 痕迹」。
  rmSync(join(fx.logs1, 'all.log'));
  const audit = runAudit(fx);
  const row = audit.rounds[0];
  const chan = row.surfaces.find((s) => s.surface === 'logs_channel');
  expect(
    'F-empty-dir-is-unknown',
    '日志面目录在、但一个 .log 都没有 → 记 unknown（空面不得当成干净面）',
    { status: chan.status, verdict: row.verdict },
    { status: 'not_measured', verdict: 'unknown' },
  );
});

// ── 对照 G：台账面被污染 → 判污染 ────────────────────────────────────────
withFixture(
  'g',
  { withForeignCommit: false, withStaleTrace: false, withLedgerForeign: 2 },
  (fx) => {
    const audit = runAudit(fx);
    const row = audit.rounds[0];
    const led = row.surfaces.find((s) => s.surface === 'deploy_ledger');
    expect(
      'G-foreign-ledger-entries',
      '台账里留着上一轮实验室自己造的发布记录（2 条）→ 判污染，且那两条要被数出来',
      {
        verdict: row.verdict,
        status: led.status,
        foreign: led.traces_before_injection,
      },
      { verdict: 'contaminated', status: 'measured', foreign: 2 },
    );
  },
);

// ── 对照 H：指标历史面被污染 → 判污染 ────────────────────────────────────
withFixture(
  'h',
  { withForeignCommit: false, withStaleTrace: false, withPromSeries: 3 },
  (fx) => {
    const audit = runAudit(fx);
    const row = audit.rounds[0];
    const met = row.surfaces.find((s) => s.surface === 'metrics_history');
    expect(
      'H-stale-metric-series',
      '重建后的 Prometheus 里还剩 3 条序列（上一轮的历史没清掉）→ 判污染',
      {
        verdict: row.verdict,
        status: met.status,
        series: met.traces_before_injection,
      },
      { verdict: 'contaminated', status: 'measured', series: 3 },
    );
  },
);

// ── 对照 I：这两张面量不到 → 判未知，不得当成干净 ────────────────────────
withFixture(
  'i',
  {
    withForeignCommit: false,
    withStaleTrace: false,
    withoutIsolation: true,
  },
  (fx) => {
    const audit = runAudit(fx);
    const row = audit.rounds[0];
    const led = row.surfaces.find((s) => s.surface === 'deploy_ledger');
    const met = row.surfaces.find((s) => s.surface === 'metrics_history');
    expect(
      'I-unmeasured-new-surfaces',
      '这一轮没有台账/指标面的实测值（老轮次）→ 两张面记 unknown、整轮判未知（不得当成干净）',
      {
        ledger: led.status,
        metrics: met.status,
        verdict: row.verdict,
      },
      { ledger: 'not_measured', metrics: 'not_measured', verdict: 'unknown' },
    );
  },
);

const allPass = results.every((r) => r.ok);
console.log('独立性审计负对照：\n');
for (const r of results) {
  console.log(
    `${r.ok ? '[PASS]' : '[FAIL]'} ${r.id} — ${r.why}\n` +
      `       预期 ${JSON.stringify(r.want)}\n` +
      `       实得 ${JSON.stringify(r.got)}`,
  );
}
console.log(
  `\n${results.filter((r) => r.ok).length}/${results.length} 条对照通过。` +
    (allPass ? '' : '\n有一条对不上——审计不能用了。'),
);
if (!allPass) process.exit(1);
