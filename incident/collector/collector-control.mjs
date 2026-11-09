#!/usr/bin/env node
// Control for the deploy ledger collector (registry segment).
//
// The collector is the only thing that touches the network, so it is also the
// thing most able to write a confident lie into the ledger. This control
// drives it against a local fake registry and checks the failure modes that
// would otherwise show up as *plausible* entries:
//
//   - a tag whose manifest cannot be read must not produce an entry
//   - a manifest with no digest must not produce an entry
//   - a config with no build time must not produce an entry
//   - several candidate commits must produce NO commit, not one of them
//   - collecting twice must not duplicate a line (the ledger is append-only)
//   - the same digest with different content must be reported, not resolved
//
// Every negative control is paired with a near-identical positive one: a
// collector that refuses everything would pass all of them.
//
// Run from the repository root:
//     node incident/collector/collector-control.mjs

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  writeSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const collector = join(here, 'collect-registry.mjs');
const deployCollector = join(here, 'collect-deploy.mjs');

// The fake cluster's scenarios. The pod's imageID is what has to agree with
// the registry digest: `c-test` agrees, `c-mismatch` does not, and
// `c-forbidden` is refused by the server before any data is returned.
const CLUSTER_SCENARIOS = {
  'c-test': [
    {
      pod_name: 'app-1',
      node: 'node-a',
      image: `127.0.0.1:5000/ok:10`,
      imageID: `docker-pullable://127.0.0.1:5000/ok@sha256:${'a'.repeat(64)}`,
      started_at: '2026-03-01T10:05:00Z',
      pod_scheduled_at: '2026-03-01T10:04:00Z',
    },
  ],
  'c-mismatch': [
    {
      pod_name: 'app-2',
      image: `127.0.0.1:5000/ok:10`,
      imageID: `docker-pullable://127.0.0.1:5000/ok@sha256:${'e'.repeat(64)}`,
      started_at: '2026-03-01T10:05:00Z',
    },
  ],
  'c-empty': [],
};

// Declared up front so the exit handler can close them even if the control
// dies before they exist.
let ciServer = null;
let clusterServer = null;

const cases = [];
let failed = 0;
function check(name, ok, detail) {
  cases.push({ name, ok, detail });
  if (!ok) failed++;
}

// ---------------------------------------------------------------------------
// Fake registry
// ---------------------------------------------------------------------------

const DIGEST_A = 'sha256:' + 'a'.repeat(64);
const DIGEST_B = 'sha256:' + 'b'.repeat(64);
const DIGEST_C = 'sha256:' + 'c'.repeat(64);
const DIGEST_D = 'sha256:' + 'd'.repeat(64);
const CONFIG_A = 'sha256:' + '1'.repeat(64);
const CONFIG_B = 'sha256:' + '2'.repeat(64);
const CONFIG_C = 'sha256:' + '3'.repeat(64);
const CONFIG_D = 'sha256:' + '4'.repeat(64);

// Each repository name is a scenario. The collector only ever addresses
// /v2/<repo>/..., so the repo name is the switch.
const SCENARIOS = {
  ok: {
    // Both builds sit shortly after the one commit in the fixture repository,
    // so both are expected to associate as a window match.
    tags: ['10', '11'],
    manifests: {
      10: {
        digest: DIGEST_A,
        config: CONFIG_A,
        created: '2026-03-01T10:00:00Z',
      },
      11: {
        digest: DIGEST_B,
        config: CONFIG_B,
        created: '2026-03-01T11:00:00Z',
      },
    },
  },
  'before-history': {
    // A build older than every commit in the repository: there is nothing to
    // associate it with, and a later commit would be a confident wrong answer.
    tags: ['13'],
    manifests: {
      13: {
        digest: DIGEST_D,
        config: CONFIG_D,
        created: '2025-01-01T10:00:00Z',
      },
    },
  },
  quiet: {
    // A build in a quiet stretch: no commit near it, so the association can
    // only be a fallback to whatever was lying around.
    tags: ['12'],
    manifests: {
      12: {
        digest: DIGEST_C,
        config: CONFIG_C,
        created: '2026-04-01T10:00:00Z',
      },
    },
  },
  'missing-manifest': {
    tags: ['10'],
    manifests: {},
  },
  'no-digest': {
    tags: ['10'],
    manifests: { 10: { config: CONFIG_A, created: '2026-03-01T10:00:00Z' } },
  },
  'no-config': {
    tags: ['10'],
    manifests: { 10: { digest: DIGEST_A, created: '2026-03-01T10:00:00Z' } },
  },
  'bad-json': {
    tags: ['10'],
    rawManifest: { 10: 'this is not json' },
  },
  'no-created': {
    tags: ['10'],
    manifests: { 10: { digest: DIGEST_A, config: CONFIG_A } },
  },
  'no-tags': { tags: [] },
  unauthorized: { tags: ['10'], requireAuth: true, tokenDenied: true },
};

function scenarioFor(repo) {
  return SCENARIOS[repo] ?? null;
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (path === '/v2/token') {
    // A registry can refuse to mint an anonymous token for a repository. The
    // collector must then fail rather than proceed with no credentials.
    const scope = url.searchParams.get('scope') ?? '';
    const repo = scope.replace(/^repository:/, '').split(':')[0];
    if (scenarioFor(repo)?.tokenDenied) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ errors: [{ code: 'UNAUTHORIZED' }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ token: 'fake-anon-token' }));
    return;
  }

  const m = /^\/v2\/([^/]+)\/(tags\/list|manifests\/(.+)|blobs\/(.+))$/.exec(
    path,
  );
  if (!m) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  const repo = m[1];
  const kind = m[2];
  const scenario = scenarioFor(repo);

  const authed = req.headers.authorization === 'Bearer fake-anon-token';
  if (scenario?.requireAuth && !authed) {
    res.writeHead(401, {
      'www-authenticate': 'Bearer realm="http://localhost/v2/token"',
    });
    res.end('unauthorized');
    return;
  }
  if (!scenario) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('no such repository');
    return;
  }

  if (kind === 'tags/list') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ name: repo, tags: scenario.tags }));
    return;
  }

  if (kind.startsWith('manifests/')) {
    const tag = kind.slice('manifests/'.length);
    if (scenario.rawManifest) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(scenario.rawManifest[tag] ?? 'not json');
      return;
    }
    const manifest = scenario.manifests?.[tag];
    if (!manifest) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('no such manifest');
      return;
    }
    const headers = {
      'content-type': 'application/vnd.docker.distribution.manifest.v2+json',
    };
    if (manifest.digest) headers['docker-content-digest'] = manifest.digest;
    res.writeHead(200, headers);
    res.end(
      JSON.stringify({
        schemaVersion: 2,
        config: manifest.config ? { digest: manifest.config } : undefined,
      }),
    );
    return;
  }

  // blobs
  const blob = kind.slice('blobs/'.length);
  const entry = Object.values(scenario.manifests ?? {}).find(
    (x) => x.config === blob,
  );
  if (!entry) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('no such blob');
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ created: entry.created }));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const registry = `127.0.0.1:${port}`;

const dir = mkdtempSync(join(tmpdir(), 'collector-control-'));
process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* disposable */
  }
  // close() only stops new connections; the collector's keep-alive sockets
  // would keep the event loop alive and the process would never exit.
  server.closeAllConnections?.();
  server.close();
  ciServer?.closeAllConnections?.();
  ciServer?.close();
  clusterServer?.closeAllConnections?.();
  clusterServer?.close();
});

// ---------------------------------------------------------------------------
// Fixture git repositories
// ---------------------------------------------------------------------------

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeGitRepo(name, commits) {
  const repo = join(dir, name);
  mkdirSync(repo, { recursive: true });
  git(['init', '-q'], repo);
  git(['config', 'user.email', 'control@example.invalid'], repo);
  git(['config', 'user.name', 'control'], repo);
  for (const c of commits) {
    writeFileSync(join(repo, 'file.txt'), c.content);
    git(['add', '-A'], repo);
    // The committer date is what the association is defined by, so it is set
    // explicitly -- "when the control happened to run" would make the test
    // meaningless.
    const env = c.date
      ? {
          ...process.env,
          GIT_AUTHOR_DATE: `${c.date} +0000`,
          GIT_COMMITTER_DATE: `${c.date} +0000`,
        }
      : process.env;
    execFileSync('git', ['commit', '-q', '-m', c.message], {
      cwd: repo,
      encoding: 'utf8',
      env,
    });
  }
  return repo;
}

const BUILD_ISO = '2026-03-01T10:00:00Z';

// One commit shortly before the build -> the association is solid.
const gitSolid = makeGitRepo('git-solid', [
  { content: 'a', message: 'one', date: '2026-03-01T09:00:00' },
]);

// Two commits carrying the same timestamp -> there is genuinely no way to
// tell which one was built, so the collector must refuse to pick one.
const gitAmbiguous = makeGitRepo('git-ambiguous', [
  { content: 'a', message: 'one', date: '2026-03-01T09:00:00' },
  { content: 'b', message: 'two', date: '2026-03-01T09:00:00' },
]);

// A quiet stretch: the nearest commit is days old -> the answer is a guess.
const gitStale = makeGitRepo('git-stale', [
  { content: 'a', message: 'one', date: '2026-01-01T09:00:00' },
]);

/**
 * 两个克隆夹具：提交内容、时间戳完全一样，唯一的差别是**本地克隆落后于
 * 远端没有**。
 *
 * 少这一对夹具，「构建之前最后一个提交就是被构建的那个提交」这条规则就会
 * 在陈旧克隆上给出**看起来有值、其实过期**的答案：所有更新的构建都被推断
 * 成同一个 HEAD（实测踩过：clone 不动了，之后几轮采集的 commit 全是那一个）。
 *
 *   - gitCloneBehind：clone 停在 commit A，远端 HEAD 已经是 commit B。
 *     候选（A）落在构建之前 → 本地可能缺了中间的提交 → 不能报 git-window。
 *   - gitCloneCurrent：clone 已经包含 commit B → 候选（B）是连续的 → 照常。
 */
function makeClonePair(name) {
  const work = join(dir, `${name}-work`);
  mkdirSync(work, { recursive: true });
  git(['init', '-q'], work);
  git(['config', 'user.email', 'control@example.invalid'], work);
  git(['config', 'user.name', 'control'], work);

  const commit = (content, message, date) => {
    writeFileSync(join(work, 'file.txt'), content);
    git(['add', '-A'], work);
    const env = {
      ...process.env,
      GIT_AUTHOR_DATE: `${date} +0000`,
      GIT_COMMITTER_DATE: `${date} +0000`,
    };
    execFileSync('git', ['commit', '-q', '-m', message], {
      cwd: work,
      encoding: 'utf8',
      env,
    });
  };

  commit('a', 'one', '2026-03-01T09:00:00');
  // 这个 clone 拍下来的时候，远端还只有 commit A。
  const behind = join(dir, `${name}-clone-behind`);
  git(['clone', '-q', work, behind], dir);

  commit('b', 'two', '2026-03-01T09:30:00');
  // 这个 clone 拍下来的时候，远端已经有 commit B 了。
  const current = join(dir, `${name}-clone-current`);
  git(['clone', '-q', work, current], dir);

  return { behind, current };
}

const { behind: gitCloneBehind, current: gitCloneCurrent } =
  makeClonePair('git-clone');

/**
 * 把克隆「最后一次从远端取东西的时刻」往前挪。
 *
 * 这个夹具造的是「克隆在构建之前就停止更新了」这个形状：克隆的知识截止
 * 时刻早于构建时刻，构建用的提交就可能根本不在本地——而远端现在能不能
 * 连上，跟这个判断毫无关系（那条路一旦断掉就查不出任何东西）。
 *
 * 真实克隆没法回拨时钟，所以直接改远端跟踪分支的 reflog 时间戳。那个文件
 * 记的本来就是「这个克隆什么时候知道远端的」，夹具改的是它记录的时刻，
 * 不是 git 的行为。
 */
function backdateRemoteReflog(repo, iso) {
  const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
    cwd: repo,
    encoding: 'utf8',
  }).trim();
  const stamp = Math.floor(Date.parse(iso) / 1000);
  const files = [];
  const walk = (dir) => {
    let names = [];
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of names) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(join(gitDir, 'logs', 'refs', 'remotes'));
  let touched = 0;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const out = text.replace(
      /(\d{10}) ([+-]\d{4})(\t)/g,
      (m, ts, tz, tab) => `${stamp} +0000${tab}`,
    );
    if (out !== text) {
      writeFileSync(file, out);
      touched += 1;
    }
  }
  return touched;
}

/**
 * 又一对近邻夹具：提交内容、时间戳、构建时刻全都一样，唯一的差别是
 * **克隆最后一次从远端取东西的时刻**在构建之前还是之后。
 *
 *   - gitStaleAtBuild：克隆的知识截止在 2026-02-01，构建在 03-01 →
 *     构建用的提交可能不在本地 → 不能报 window。
 *   - gitFreshAtBuild：同样的提交，克隆是刚 clone 的（知识截止在构建之后）
 *     → 候选是连续的 → 照常报 window。
 */
function makeStaleAtBuildPair(name) {
  const work = join(dir, `${name}-work`);
  mkdirSync(work, { recursive: true });
  git(['init', '-q'], work);
  git(['config', 'user.email', 'control@example.invalid'], work);
  git(['config', 'user.name', 'control'], work);
  writeFileSync(join(work, 'file.txt'), 'a');
  git(['add', '-A'], work);
  execFileSync('git', ['commit', '-q', '-m', 'one'], {
    cwd: work,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2026-03-01T09:00:00 +0000',
      GIT_COMMITTER_DATE: '2026-03-01T09:00:00 +0000',
    },
  });

  const fresh = join(dir, `${name}-fresh`);
  git(['clone', '-q', work, fresh], dir);
  const stale = join(dir, `${name}-stale`);
  git(['clone', '-q', work, stale], dir);
  const touched = backdateRemoteReflog(stale, '2026-02-01T00:00:00Z');
  return { fresh, stale, touched };
}

const {
  fresh: gitFreshAtBuild,
  stale: gitStaleAtBuild,
  touched: gitStaleReflogTouched,
} = makeStaleAtBuildPair('git-stale-at-build');

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

// The collector talks to the fake registry over HTTP, and the fake registry
// lives in *this* process. So the child must be spawned asynchronously --
// spawnSync would block the event loop that the registry needs to answer on,
// and the whole thing would deadlock.
function collect(repo, args = [], env = {}) {
  const ledger = args.includes('--ledger')
    ? args[args.indexOf('--ledger') + 1]
    : join(dir, `ledger-${Math.random().toString(36).slice(2)}.jsonl`);
  const argv = [
    collector,
    '--registry',
    registry,
    '--repo',
    repo,
    '--ledger',
    ledger,
    ...args,
  ];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, {
      env: { ...process.env, ...env },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      let parsed = null;
      try {
        parsed = JSON.parse(out);
      } catch {
        /* not all cases print JSON */
      }
      resolve({ code, out, err, parsed, ledger });
    });
  });
}

// ---------------------------------------------------------------------------
// Positive controls
// ---------------------------------------------------------------------------

{
  const r = await collect('ok', ['--git', gitSolid]);
  const ok =
    r.code === 0 &&
    r.parsed?.appended === 2 &&
    r.parsed?.entries?.every((e) => e.commit_source === 'git-window') &&
    r.parsed?.entries?.every((e) => e.pod_started_at === null);
  check(
    'a readable registry produces one entry per tag, with the commit source stated',
    ok,
    `exit=${r.code} appended=${r.parsed?.appended} sources=${r.parsed?.entries?.map((e) => e.commit_source).join(',')}`,
  );
  check(
    'the pod start time stays empty: the registry does not know it',
    r.parsed?.entries?.every((e) => e.pod_started_at === null),
    `pod_started_at=${r.parsed?.entries?.map((e) => e.pod_started_at).join(',')}`,
  );
}

{
  const r = await collect('ok', []);
  const ok =
    r.code === 0 && r.parsed?.entries?.every((e) => e.commit_source === 'null');
  check(
    'without a git repository no commit is invented',
    ok,
    `exit=${r.code} sources=${r.parsed?.entries?.map((e) => e.commit_source).join(',')}`,
  );
}

{
  const r = await collect('quiet', ['--git', gitStale]);
  const ok =
    r.code === 0 &&
    r.parsed?.entries?.every((e) => e.commit_source === 'git-head-fallback');
  check(
    'a build in a quiet stretch is labelled as a fallback, not as a window match',
    ok,
    `exit=${r.code} sources=${r.parsed?.entries?.map((e) => e.commit_source).join(',')}`,
  );
}

// ---------------------------------------------------------------------------
// 陈旧克隆：本地落后于远端时，不能把本地 HEAD 当成被构建的那个提交
// ---------------------------------------------------------------------------

{
  const r = await collect('ok', ['--git', gitCloneBehind]);
  const sources = r.parsed?.entries?.map((e) => e.commit_source) ?? [];
  const associations = r.parsed?.entries?.map((e) => e.association) ?? [];
  check(
    '本地克隆落后于远端 → 降级成 fallback，不报 window（同一个 HEAD 不能当成构建的提交）',
    r.code === 0 &&
      sources.length > 0 &&
      sources.every((s) => s === 'git-head-fallback') &&
      associations.some((a) => /behind/i.test(String(a))),
    `exit=${r.code} sources=${sources.join(',')} reason=${associations[0] ?? '无'}`,
  );
}

{
  const r = await collect('ok', ['--git', gitCloneCurrent]);
  const sources = r.parsed?.entries?.map((e) => e.commit_source) ?? [];
  check(
    '近邻正对照：克隆是最新的 → 照常报 window（降级不能过度）',
    r.code === 0 &&
      sources.length > 0 &&
      sources.every((s) => s === 'git-window'),
    `exit=${r.code} sources=${sources.join(',')}`,
  );
}

{
  const r = await collect('ok', ['--git', gitStaleAtBuild]);
  const sources = r.parsed?.entries?.map((e) => e.commit_source) ?? [];
  const associations = r.parsed?.entries?.map((e) => e.association) ?? [];
  check(
    '构建发生在克隆最后一次取东西之后 → 降级成 fallback（本地可能缺了构建的提交）',
    gitStaleReflogTouched > 0 &&
      r.code === 0 &&
      sources.length > 0 &&
      sources.every((s) => s === 'git-head-fallback') &&
      associations.some((a) =>
        /stopped learning about the remote/i.test(String(a)),
      ),
    `改了 ${gitStaleReflogTouched} 个 reflog；exit=${r.code} sources=${sources.join(',')} reason=${associations[0] ?? '无'}`,
  );
}

{
  const r = await collect('ok', ['--git', gitFreshAtBuild]);
  const sources = r.parsed?.entries?.map((e) => e.commit_source) ?? [];
  check(
    '近邻正对照：同样的提交，克隆是新的 → 照常报 window（降级不能过度）',
    r.code === 0 &&
      sources.length > 0 &&
      sources.every((s) => s === 'git-window'),
    `exit=${r.code} sources=${sources.join(',')}`,
  );
}

{
  const r = await collect('ok', ['--git', gitAmbiguous]);
  const ok =
    r.code === 0 &&
    r.parsed?.entries?.every((e) => e.commit_source === 'ambiguous') &&
    r.parsed?.entries?.every((e) => e.commit === null);
  check(
    'several candidate commits produce no commit at all',
    ok,
    `exit=${r.code} sources=${r.parsed?.entries?.map((e) => e.commit_source).join(',')} commits=${r.parsed?.entries?.map((e) => e.commit).join(',')}`,
  );
}

// ---------------------------------------------------------------------------
// Idempotence: the ledger is append-only
// ---------------------------------------------------------------------------

{
  const ledger = join(dir, 'idempotent.jsonl');
  const first = await collect('ok', ['--ledger', ledger]);
  const second = await collect('ok', ['--ledger', ledger]);
  const lines = existsSync(ledger)
    ? readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean)
    : [];
  const ok =
    first.code === 0 &&
    second.code === 0 &&
    first.parsed?.appended === 2 &&
    second.parsed?.appended === 0 &&
    second.parsed?.skipped_already_present === 2 &&
    lines.length === 2;
  check(
    'collecting the same tags twice appends nothing the second time',
    ok,
    `first=${first.parsed?.appended} second=${second.parsed?.appended} skipped=${second.parsed?.skipped_already_present} lines=${lines.length}`,
  );
}

// ---------------------------------------------------------------------------
// A row is an observation of a rollout, not a row per image
//
// The same image deployed again later is a *new* fact: it has its own start
// time, and losing it loses "how long has this been running". Keying on digest
// alone would swallow it as a duplicate.
// ---------------------------------------------------------------------------

{
  const ledger = join(dir, 're-observe.jsonl');
  const first = await collect('ok', ['--ledger', ledger, '--tags', '10']);
  const second = await collect('ok', [
    '--ledger',
    ledger,
    '--tags',
    '10',
    '--running-now',
  ]);
  const lines = readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean);
  const rows = lines.map((l) => JSON.parse(l));
  const ok =
    first.code === 0 &&
    second.code === 0 &&
    first.parsed?.appended === 1 &&
    second.parsed?.appended === 1 &&
    second.parsed?.conflicts === 0 &&
    rows.length === 2 &&
    rows[0].running_observed_at == null &&
    typeof rows[1].running_observed_at === 'string';
  check(
    'a second observation of the same digest is appended, not swallowed as a duplicate',
    ok,
    `first=${first.parsed?.appended} second=${second.parsed?.appended} conflicts=${second.parsed?.conflicts} lines=${rows.length}`,
  );
}

{
  const ledger = join(dir, 'running.jsonl');
  const r = await collect('ok', [
    '--ledger',
    ledger,
    '--tags',
    '10',
    '--running-now',
  ]);
  const row = JSON.parse(readFileSync(ledger, 'utf8').trim());
  const ok =
    r.code === 0 &&
    row.running_source === 'human' &&
    typeof row.running_observed_at === 'string' &&
    // "which image is running" is not "when did it start": the start time
    // stays empty unless something that actually knows it fills it in.
    row.pod_started_at === null &&
    row.evidence.includes('running-observation');
  check(
    '--running-now records the running image and names who said so, without inventing a start time',
    ok,
    `exit=${r.code} source=${row.running_source} observed=${row.running_observed_at} pod_started_at=${row.pod_started_at}`,
  );
}

{
  const r = await collect('ok', ['--running-source', 'k8s']);
  check(
    '--running-source without --running-now is refused, not silently ignored',
    r.code !== 0 && /running-now/.test(r.err),
    `exit=${r.code} err=${r.err.trim().slice(0, 80)}`,
  );
}

// ---------------------------------------------------------------------------
// Conflicts: one digest cannot have two answers
// ---------------------------------------------------------------------------

{
  const ledger = join(dir, 'conflict.jsonl');
  writeFileSync(
    ledger,
    `${JSON.stringify({ digest: DIGEST_A, image_ref: 'x:10', commit: 'deadbeef', built_at: '2026-01-01T00:00:00Z', commit_source: 'manual', collected_at: '2026-01-01T00:00:00Z' })}\n`,
  );
  const r = await collect('ok', ['--ledger', ledger]);
  const kept = readFileSync(ledger, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const conflicting = kept.find((e) => e.digest === DIGEST_A);
  const ok =
    r.code !== 0 &&
    r.parsed?.conflicts === 1 &&
    // The conflicting digest keeps its old content; only the other tag lands.
    conflicting?.commit === 'deadbeef' &&
    kept.filter((e) => e.digest === DIGEST_A).length === 1;
  check(
    'the same digest with different content is reported, not silently resolved',
    ok,
    `exit=${r.code} conflicts=${r.parsed?.conflicts} kept=${conflicting?.commit}`,
  );
}

// A digest fixes the image's build time. Two build times for one digest is not
// a second rollout -- it is a contradiction, and the ledger must say so rather
// than keep both and let the reader pick.
{
  const ledger = join(dir, 'conflict-built-at.jsonl');
  writeFileSync(
    ledger,
    `${JSON.stringify({ digest: DIGEST_A, image_ref: 'x:10', commit: null, commit_source: 'null', built_at: '2020-01-01T00:00:00Z', collected_at: '2026-01-01T00:00:00Z' })}\n`,
  );
  const r = await collect('ok', ['--ledger', ledger, '--tags', '10']);
  const ok =
    r.code !== 0 &&
    r.parsed?.conflicts === 1 &&
    /build time/.test(r.err) &&
    readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).length ===
      1;
  check(
    'one digest with two build times is a conflict, not a second rollout',
    ok,
    `exit=${r.code} conflicts=${r.parsed?.conflicts} said-build-time=${/build time/.test(r.err)}`,
  );
}

// ---------------------------------------------------------------------------
// Negative controls: a miss must not become a partial entry
// ---------------------------------------------------------------------------

for (const [name, repo, needle] of [
  [
    'a missing manifest fails instead of writing an entry',
    'missing-manifest',
    '404',
  ],
  ['a manifest without a digest fails', 'no-digest', 'Docker-Content-Digest'],
  ['a manifest without a config digest fails', 'no-config', 'config digest'],
  ['a non-JSON manifest fails', 'bad-json', 'invalid JSON'],
  ['a config without a build time fails', 'no-created', 'created'],
  ['an empty tag list fails', 'no-tags', 'no tags'],
]) {
  const r = await collect(repo);
  const ok = r.code !== 0 && r.err.includes(needle) && !existsSync(r.ledger);
  check(
    name,
    ok,
    `exit=${r.code} needle=${r.err.includes(needle)} ledger=${existsSync(r.ledger)} err=${r.err.trim().slice(0, 90)}`,
  );
}

{
  const r = await collect('before-history', ['--git', gitSolid]);
  const ok =
    r.code === 0 &&
    r.parsed?.entries?.every((e) => e.commit_source === 'null') &&
    r.parsed?.entries?.every((e) => e.commit === null);
  check(
    'a build older than every commit gets no commit, not a later one',
    ok,
    `exit=${r.code} sources=${r.parsed?.entries?.map((e) => e.commit_source).join(',')} commits=${r.parsed?.entries?.map((e) => e.commit).join(',')}`,
  );
}

{
  const r = await collect('unauthorized');
  const ok = r.code !== 0 && !existsSync(r.ledger);
  check(
    'a registry that refuses the read fails without writing anything',
    ok,
    `exit=${r.code} ledger=${existsSync(r.ledger)} err=${r.err.trim().slice(0, 90)}`,
  );
}

// A near-identical positive: the very same fake registry answers for `ok`.
// It is above, but the pairing is what makes the refusal cases meaningful.
{
  const r = await collect('ok');
  check(
    'the same registry and the same collector succeed on the readable repository',
    r.code === 0 && existsSync(r.ledger),
    `exit=${r.code} ledger=${existsSync(r.ledger)}`,
  );
}

// ---------------------------------------------------------------------------
// CI segment and cluster segment (collect-deploy.mjs)
// ---------------------------------------------------------------------------

// A fake CI server. The job name is the scenario switch, and so is the build
// number inside the "ok" job, because the two failure modes live in different
// places: a build that does not exist, and a build that exists but does not
// say what it checked out.
const CI_BUILD_SHA = 'f'.repeat(40);

ciServer = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const m = /^\/job\/([^/]+)\/(\d+)\/api\/json$/.exec(url.pathname);
  if (!m) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  const [, job, build] = m;
  if (
    req.headers.authorization !==
    `Basic ${Buffer.from('control-user:control-token').toString('base64')}`
  ) {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('unauthorized');
    return;
  }
  if (job === 'no-such-build') {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('no such build');
    return;
  }
  const sha = job === 'no-revision' ? null : CI_BUILD_SHA;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      number: Number(build),
      result: 'SUCCESS',
      timestamp: Date.parse('2026-03-01T09:30:00Z'),
      actions: sha
        ? [
            {
              lastBuiltRevision: {
                SHA1: sha,
                branch: [{ SHA1: sha, name: 'refs/remotes/origin/main' }],
              },
            },
          ]
        : [{}],
    }),
  );
});

await new Promise((resolve) => ciServer.listen(0, '127.0.0.1', resolve));
const ciUrl = `http://127.0.0.1:${ciServer.address().port}`;

// A fake cluster. The pod's imageID has to agree with the registry digest,
// otherwise the collector must refuse the row -- that check is the whole point
// of reading the cluster.
clusterServer = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const m =
    /^\/k8s\/clusters\/([^/]+)\/api\/v1\/namespaces\/([^/]+)\/pods$/.exec(
      url.pathname,
    );
  if (!m) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  if (req.headers.authorization !== 'Bearer control-cluster-token') {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        kind: 'Status',
        message: 'namespaces is forbidden: control token may not list pods',
      }),
    );
    return;
  }
  const [, cluster, namespace] = m;
  if (cluster === 'c-forbidden') {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        kind: 'Status',
        message: 'pods is forbidden: control token may not list pods',
      }),
    );
    return;
  }
  const pods = (CLUSTER_SCENARIOS[cluster] ?? []).map((p) => ({
    metadata: { name: p.pod_name, namespace },
    spec: { nodeName: p.node ?? null },
    status: {
      startTime: p.pod_scheduled_at ?? null,
      containerStatuses: [
        {
          name: 'app',
          image: p.image,
          imageID: p.imageID,
          restartCount: 0,
          ready: true,
          state: { running: { startedAt: p.started_at } },
        },
      ],
    },
  }));
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ kind: 'PodList', items: pods }));
});

await new Promise((resolve) => clusterServer.listen(0, '127.0.0.1', resolve));
const clusterUrl = `http://127.0.0.1:${clusterServer.address().port}`;

// The CI credentials and the cluster token are given to the collector through
// a file, exactly the way the real ones are: never through argv.
const credsDir = join(dir, 'creds');
mkdirSync(credsDir, { recursive: true });
const ciCreds = join(credsDir, 'ci.env');
writeFileSync(
  ciCreds,
  'JENKINS_USER=control-user\nJENKINS_TOKEN=control-token\n',
);
const clusterCreds = join(credsDir, 'cluster.env');
writeFileSync(clusterCreds, 'RANCHER_TOKEN=control-cluster-token\n');

function collectDeploy(repo, args = [], env = {}) {
  const ledgerIndex = args.indexOf('--ledger');
  const ledger =
    ledgerIndex >= 0
      ? args[ledgerIndex + 1]
      : join(dir, `deploy-${Math.random().toString(36).slice(2)}.jsonl`);
  const argv = [
    deployCollector,
    '--registry',
    registry,
    '--repo',
    repo,
    '--ledger',
    ledger,
    ...args,
  ];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, {
      env: { ...process.env, ...env },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      let parsed = null;
      try {
        parsed = JSON.parse(out);
      } catch {
        /* not all cases print JSON */
      }
      resolve({ code, out, err, parsed, ledger });
    });
  });
}

const CI_ARGS = [
  '--jenkins-url',
  ciUrl,
  '--jenkins-job',
  'ok',
  '--jenkins-credentials-file',
  ciCreds,
];
const CLUSTER_ARGS = [
  '--rancher-url',
  clusterUrl,
  '--rancher-cluster',
  'c-test',
  '--rancher-namespace',
  'ns-test',
  '--rancher-credentials-file',
  clusterCreds,
];

{
  const r = await collectDeploy('ok', [
    '--tags',
    '10',
    '--git',
    gitSolid,
    ...CI_ARGS,
    ...CLUSTER_ARGS,
  ]);
  const row = existsSync(r.ledger)
    ? JSON.parse(readFileSync(r.ledger, 'utf8').trim())
    : null;
  const ok =
    r.code === 0 &&
    row?.commit === CI_BUILD_SHA &&
    row?.commit_source === 'jenkins-build' &&
    // The timestamp inference is kept next to the fact, so "the guess was
    // wrong" stays visible in the ledger instead of being quietly dropped.
    row?.commit_inferred != null &&
    row?.commit_inferred_source === 'git-window' &&
    row?.pod_started_at === '2026-03-01T10:05:00Z' &&
    row?.running_source === 'k8s' &&
    row?.evidence.includes('ci-build-record') &&
    row?.evidence.includes('cluster-pod');
  check(
    'the CI record and the cluster fill the row, and the inference is kept beside them',
    ok,
    `exit=${r.code} commit=${row?.commit?.slice(0, 8)} source=${row?.commit_source} inferred=${row?.commit_inferred?.slice(0, 8)}/${row?.commit_inferred_source} pod_started=${row?.pod_started_at} running=${row?.running_source}`,
  );
}

{
  const r = await collectDeploy('ok', [
    '--tags',
    '10',
    '--jenkins-url',
    ciUrl,
    '--jenkins-job',
    'no-such-build',
    '--jenkins-credentials-file',
    ciCreds,
  ]);
  check(
    'a CI build that does not exist fails instead of writing a commitless row',
    r.code !== 0 && /no such build/i.test(r.err) && !existsSync(r.ledger),
    `exit=${r.code} ledger=${existsSync(r.ledger)} err=${r.err.trim().slice(0, 90)}`,
  );
}

{
  const r = await collectDeploy('ok', [
    '--tags',
    '10',
    '--jenkins-url',
    ciUrl,
    '--jenkins-job',
    'no-revision',
    '--jenkins-credentials-file',
    ciCreds,
  ]);
  check(
    'a CI build with no revision is refused, not filled in from git',
    r.code !== 0 && /revision/i.test(r.err) && !existsSync(r.ledger),
    `exit=${r.code} ledger=${existsSync(r.ledger)} err=${r.err.trim().slice(0, 90)}`,
  );
}

{
  const r = await collectDeploy('ok', [
    '--tags',
    '10',
    ...CI_ARGS,
    '--rancher-url',
    clusterUrl,
    '--rancher-cluster',
    'c-mismatch',
    '--rancher-namespace',
    'ns-test',
    '--rancher-credentials-file',
    clusterCreds,
  ]);
  check(
    'a pod running a different digest than its tag is reported, not written',
    r.code !== 0 && /does not match/i.test(r.err) && !existsSync(r.ledger),
    `exit=${r.code} ledger=${existsSync(r.ledger)} err=${r.err.trim().slice(0, 90)}`,
  );
}

{
  const r = await collectDeploy('ok', [
    '--tags',
    '10',
    '--rancher-url',
    clusterUrl,
    '--rancher-cluster',
    'c-empty',
    '--rancher-namespace',
    'ns-test',
    '--rancher-credentials-file',
    clusterCreds,
  ]);
  const row = existsSync(r.ledger)
    ? JSON.parse(readFileSync(r.ledger, 'utf8').trim())
    : null;
  const ok =
    r.code === 0 &&
    row?.pod_started_at === null &&
    row?.running_source === null &&
    row?.running_observed_at === null;
  check(
    'a namespace with no running pod leaves the start time empty',
    ok,
    `exit=${r.code} pod_started=${row?.pod_started_at} running_source=${row?.running_source}`,
  );
}

// The inference was wrong and the CI record says so: that is a supersession,
// not a contradiction. The ledger keeps both, and says which one won.
{
  const ledger = join(dir, 'supersede.jsonl');
  writeFileSync(
    ledger,
    `${JSON.stringify({
      digest: DIGEST_A,
      image_ref: 'x:10',
      commit: 'deadbeef',
      commit_source: 'git-head-fallback',
      built_at: '2026-03-01T10:00:00Z',
      pod_started_at: null,
      collected_at: '2026-03-01T10:00:00Z',
    })}\n`,
  );
  const r = await collectDeploy('ok', [
    '--ledger',
    ledger,
    '--tags',
    '10',
    ...CI_ARGS,
  ]);
  const rows = existsSync(ledger)
    ? readFileSync(ledger, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
  const added = rows.find((x) => x.commit === CI_BUILD_SHA);
  const ok =
    r.code === 0 &&
    r.parsed?.conflicts === 0 &&
    r.parsed?.superseded === 1 &&
    rows.length === 2 &&
    added?.superseded_commit?.commit === 'deadbeef' &&
    added?.superseded_commit?.commit_source === 'git-head-fallback';
  check(
    'the CI record supersedes a wrong inference, and the wrong one is kept',
    ok,
    `exit=${r.code} conflicts=${r.parsed?.conflicts} superseded=${r.parsed?.superseded} rows=${rows.length} kept=${added?.superseded_commit?.commit}`,
  );
}

// The same instant written with more digits is the same instant. A registry
// that reports nanoseconds and a ledger that stores milliseconds would
// otherwise produce two build times for one digest -- and the ledger would
// call that a contradiction.
{
  const ledger = join(dir, 'precision.jsonl');
  writeFileSync(
    ledger,
    `${JSON.stringify({
      digest: DIGEST_A,
      image_ref: 'x:10',
      commit: null,
      commit_source: 'null',
      built_at: '2026-03-01T10:00:00.000000000Z',
      pod_started_at: null,
      collected_at: '2026-03-01T10:00:00.000Z',
    })}\n`,
  );
  const r = await collectDeploy('ok', ['--ledger', ledger, '--tags', '10']);
  const rows = readFileSync(ledger, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const ok =
    r.code === 0 &&
    r.parsed?.conflicts === 0 &&
    rows.length === 2 &&
    rows[1].built_at === '2026-03-01T10:00:00.000Z';
  check(
    'the same instant written with more digits is not a contradiction',
    ok,
    `exit=${r.code} conflicts=${r.parsed?.conflicts} rows=${rows.length} built_at=${rows[1]?.built_at}`,
  );
}

// A second run of the same facts must not pile up rows for the tags that are
// not running -- but a poll of a running pod is a new observation and is
// recorded as one.
{
  const ledger = join(dir, 'deploy-idempotent.jsonl');
  const first = await collectDeploy('ok', [
    '--ledger',
    ledger,
    '--tags',
    '10,11',
    ...CI_ARGS,
    ...CLUSTER_ARGS,
  ]);
  const second = await collectDeploy('ok', [
    '--ledger',
    ledger,
    '--tags',
    '10,11',
    ...CI_ARGS,
    ...CLUSTER_ARGS,
  ]);
  const rows = existsSync(ledger)
    ? readFileSync(ledger, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
  const runningRows = rows.filter((x) => x.running_source === 'k8s');
  const ok =
    first.code === 0 &&
    second.code === 0 &&
    // tag 11 is not running -> its row is written once and then skipped
    rows.filter((x) => x.running_source === null).length === 1 &&
    // tag 10 is running -> each poll is one more observation
    runningRows.length === 2 &&
    runningRows[0].running_observed_at !== runningRows[1].running_observed_at;
  check(
    'collecting twice adds nothing for the idle tag and one new observation for the running one',
    ok,
    `first=${first.parsed?.appended} second=${second.parsed?.appended} rows=${rows.length} running=${runningRows.length} err=${(first.err || second.err || '').trim().slice(0, 120)}`,
  );
}

// A near-identical positive: the same collector, the same servers, the same
// ledger -- only the credentials are wrong.
{
  const r = await collectDeploy('ok', [
    '--tags',
    '10',
    '--rancher-url',
    clusterUrl,
    '--rancher-cluster',
    'c-forbidden',
    '--rancher-namespace',
    'ns-test',
    '--rancher-credentials-file',
    clusterCreds,
  ]);
  check(
    'a cluster that refuses the request fails without writing anything',
    r.code !== 0 && !existsSync(r.ledger),
    `exit=${r.code} ledger=${existsSync(r.ledger)} err=${r.err.trim().slice(0, 90)}`,
  );
}

// ---------------------------------------------------------------------------

const report =
  cases
    .map((c) => `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  [${c.detail}]`)
    .join('\n') + `\n\n${cases.length - failed}/${cases.length} 通过\n`;

// Synchronous write: process.exit() would truncate a piped stdout.
writeSync(1, report);
process.exit(failed > 0 ? 1 : 0);
