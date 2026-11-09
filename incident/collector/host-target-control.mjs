#!/usr/bin/env node
// Control for the host-process segment of the deploy ledger.
//
// A host target (`java -jar`) has no image and therefore no image digest. The
// ledger still needs a key for it, and the key it gets is the artifact's own
// sha256. That is only trustworthy if three things hold:
//
//   - the hash is the real sha256 of the real file (checked against the
//     system's own sha256sum, and against a published known value);
//   - the identity follows the artifact and not the process (a restart with a
//     new pid is the same deployment; a rebuild under the same path is not);
//   - nothing is invented: no start time means null, not a plausible number.
//
// Every negative control is paired with a near-identical positive: a module
// that refuses everything would pass all of them.
//
// Run from the repository root:
//     node incident/collector/host-target-control.mjs

import { spawn, execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  cpSync,
  renameSync,
  writeSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HostTargetError,
  fileSha256,
  artifactStat,
  artifactIdentity,
  treeSha256,
  treeIdentity,
  listTreeFiles,
  parseProcStatStarttime,
  parseBtimeSeconds,
  processStartMs,
  hostObservation,
} from './host-target.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, 'host-target.mjs');

const cases = [];
let failed = 0;
function check(name, ok, detail) {
  cases.push({ name, ok, detail });
  if (!ok) failed++;
}

const dir = mkdtempSync(join(tmpdir(), 'host-target-control-'));
let child = null;
process.on('exit', () => {
  try {
    if (child && child.pid) child.kill('SIGKILL');
  } catch {
    /* the child is disposable; failing to kill it is not a control failure */
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the temp dir is disposable */
  }
});

// ---------------------------------------------------------------------------
// Fixture artifacts
// ---------------------------------------------------------------------------

const artifactPath = join(dir, 'app.jar');
writeFileSync(artifactPath, 'artifact content v1\n');

const artifactPath2 = join(dir, 'other.jar');
writeFileSync(artifactPath2, 'artifact content v1\n');

const changedPath = join(dir, 'changed.jar');
writeFileSync(changedPath, 'artifact content v2\n');

const emptyPath = join(dir, 'empty.jar');
writeFileSync(emptyPath, '');

const missingPath = join(dir, 'does-not-exist.jar');
const dirPath = join(dir, 'a-directory');
mkdirSync(dirPath, { recursive: true });

// ---------------------------------------------------------------------------
// The hash is the real hash
// ---------------------------------------------------------------------------

{
  // A published value: sha256("abc"). If the implementation changes the
  // algorithm or the encoding, this fails before anything else does.
  const abcPath = join(dir, 'abc.bin');
  writeFileSync(abcPath, 'abc');
  const got = fileSha256(abcPath);
  const want =
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  check(
    'the artifact hash matches a published sha256 value',
    got === want,
    `got=${got.slice(0, 12)} want=${want.slice(0, 12)}`,
  );
}

{
  // The system's own tool is the reference: if our hash disagrees with
  // sha256sum, one of us is wrong and it must not be us.
  const sys = execFileSync('sha256sum', [artifactPath], { encoding: 'utf8' });
  const sysHash = sys.trim().split(/\s+/)[0];
  check(
    'the artifact hash agrees with the system sha256sum',
    fileSha256(artifactPath) === sysHash,
    `ours=${fileSha256(artifactPath).slice(0, 12)} system=${sysHash.slice(0, 12)}`,
  );
}

{
  const a = fileSha256(artifactPath);
  const b = fileSha256(artifactPath);
  check(
    'the same file hashes the same way twice',
    a === b,
    `a=${a.slice(0, 12)} b=${b.slice(0, 12)}`,
  );
}

{
  // Different content must be a different artifact, even under the same name.
  const before = fileSha256(artifactPath);
  const after = fileSha256(changedPath);
  check(
    'a changed artifact hashes differently',
    before !== after,
    `before=${before.slice(0, 12)} after=${after.slice(0, 12)}`,
  );
}

{
  // The near-identical positive: same content in two different files is the
  // same artifact. Identity follows the bytes, not the path.
  const a = fileSha256(artifactPath);
  const b = fileSha256(artifactPath2);
  check(
    'the same content under two paths is the same artifact',
    a === b,
    `a=${a.slice(0, 12)} b=${b.slice(0, 12)}`,
  );
}

{
  // Real artifacts are bigger than one hash chunk, and the chunk loop is
  // where a file larger than a chunk could silently lose its tail. The
  // system tool is the reference again, on a file that crosses the
  // boundary.
  const bigPath = join(dir, 'big.jar');
  writeFileSync(bigPath, Buffer.alloc(2_500_000, 0x61));
  const sys = execFileSync('sha256sum', [bigPath], { encoding: 'utf8' });
  const sysHash = sys.trim().split(/\s+/)[0];
  const ours = fileSha256(bigPath);
  check(
    'a file larger than one hash chunk still hashes correctly',
    ours === sysHash,
    `ours=${ours.slice(0, 12)} system=${sysHash.slice(0, 12)}`,
  );
}

// ---------------------------------------------------------------------------
// The identity follows the artifact, not the process
// ---------------------------------------------------------------------------

{
  const id1 = artifactIdentity({
    sha256: fileSha256(artifactPath),
    size: artifactStat(artifactPath).size,
    mtimeMs: artifactStat(artifactPath).mtimeMs,
    path: artifactPath,
  });
  const id2 = artifactIdentity({
    sha256: fileSha256(artifactPath2),
    size: artifactStat(artifactPath2).size,
    mtimeMs: artifactStat(artifactPath2).mtimeMs,
    path: artifactPath2,
  });
  check(
    'two copies of one artifact share one ledger key',
    id1.digest === id2.digest && id1.digest.startsWith('sha256:'),
    `digest=${id1.digest.slice(0, 20)}`,
  );
}

{
  // A restart gives a new pid and the same artifact: the deployment did not
  // change, so the key must not change either.
  const nowMs = Date.now();
  const a = hostObservation({ artifactPath, pid: null, nowMs });
  const b = hostObservation({ artifactPath, pid: null, nowMs });
  check(
    'the ledger key does not depend on the process',
    a.digest === b.digest && a.image_ref === artifactPath,
    `digest=${a.digest.slice(0, 20)}`,
  );
}

// ---------------------------------------------------------------------------
// The build time follows the file
// ---------------------------------------------------------------------------

{
  const before = artifactStat(artifactPath).mtimeMs;
  const later = new Date(before + 3600_000);
  utimesSync(artifactPath, later, later);
  const after = artifactStat(artifactPath).mtimeMs;
  const idBefore = artifactIdentity({
    sha256: fileSha256(artifactPath),
    size: 1,
    mtimeMs: before,
    path: artifactPath,
  });
  const idAfter = artifactIdentity({
    sha256: fileSha256(artifactPath),
    size: 1,
    mtimeMs: after,
    path: artifactPath,
  });
  check(
    'a changed build time shows up as a changed build time',
    idBefore.built_at !== idAfter.built_at &&
      idBefore.digest === idAfter.digest,
    `before=${idBefore.built_at} after=${idAfter.built_at}`,
  );
}

// ---------------------------------------------------------------------------
// The start time is measured or absent
// ---------------------------------------------------------------------------

{
  // A live process: the start time must exist, be a real instant, and not be
  // in the future.
  child = spawn('sleep', ['30'], { stdio: 'ignore' });
  const pid = child.pid;
  const startedMs = processStartMs(pid);
  const ok =
    startedMs !== null &&
    startedMs <= Date.now() &&
    startedMs > Date.now() - 60_000;
  check(
    'a live process has a measurable start time',
    ok,
    `started=${startedMs === null ? 'null' : new Date(startedMs).toISOString()}`,
  );
}

{
  // The near-identical negative: a process that is not there. The start time
  // is unknown, and unknown has to look like unknown.
  const startedMs = processStartMs(999_999);
  const obs = hostObservation({ artifactPath, pid: 999_999 });
  check(
    'a process that is not there leaves the start time unknown, not invented',
    startedMs === null && obs.pod_started_at === null,
    `started=${startedMs} pod_started_at=${obs.pod_started_at}`,
  );
}

{
  // The system's own answer, cross-checked. `ps -o etimes=` is elapsed
  // seconds and carries no timezone, so the start time we compute has to
  // agree with it to within a second or two. This is what catches a wrong
  // clock tick rate or a stale boot time -- an error that no self-consistent
  // check would notice.
  const pid = child ? child.pid : null;
  const elapsed = Number(
    execFileSync('ps', ['-o', 'etimes=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim(),
  );
  const startedMs = processStartMs(pid);
  const drift = Math.abs(startedMs - (Date.now() - elapsed * 1000));
  check(
    'the start time agrees with the system elapsed-time counter',
    Number.isFinite(elapsed) && elapsed >= 0 && drift < 2000,
    `elapsed=${elapsed}s drift=${drift}ms`,
  );
}

{
  // Same artifact, but now with a live pid: the start time appears and the
  // key does not move.
  const pid = child ? child.pid : null;
  const obs = hostObservation({ artifactPath, pid });
  const noPid = hostObservation({ artifactPath, pid: null });
  check(
    'a running process adds a start time without changing the key',
    obs.digest === noPid.digest && obs.pod_started_at !== null,
    `pod_started_at=${obs.pod_started_at}`,
  );
}

{
  // The parsers are pure: a stat line whose fields cannot be read must yield
  // null rather than a made-up number.
  const good = parseProcStatStarttime(
    '1234 (sleep) S 1 1234 1234 0 -1 4194304 100 0 0 0 1 2 3 4 20 0 1 0 987654 0 0',
  );
  const bad = parseProcStatStarttime('not a stat line');
  const none = parseProcStatStarttime(null);
  check(
    'an unreadable stat line yields no start time',
    good === 987654 && bad === null && none === null,
    `good=${good} bad=${bad} none=${none}`,
  );
}

// ---------------------------------------------------------------------------
// Running is observed, not assumed
// ---------------------------------------------------------------------------

{
  // A process we can see is a running observation, and the read side's
  // `deploy running` needs exactly these two fields to answer.
  const pid = child ? child.pid : null;
  const obs = hostObservation({ artifactPath, pid });
  check(
    'a live process is observed as running',
    obs.running_observed_at !== undefined &&
      obs.running_source === 'host' &&
      obs.pod_started_at !== null,
    `running_source=${obs.running_source} at=${obs.running_observed_at}`,
  );
}

{
  // The near-identical negative: a pid that is not there is not a running
  // service. It must not carry a running observation.
  const obs = hostObservation({ artifactPath, pid: 999_999 });
  check(
    'a process that is not there is not observed as running',
    obs.running_observed_at === undefined && obs.pod_started_at === null,
    `running_observed_at=${obs.running_observed_at}`,
  );
}

{
  // No pid at all is not an observation either: we did not look at a
  // process, so we cannot say one is running.
  const obs = hostObservation({ artifactPath });
  check(
    'no pid means no running observation',
    obs.running_observed_at === undefined && obs.pod_started_at === null,
    `running_observed_at=${obs.running_observed_at}`,
  );
}

{
  const btime = parseBtimeSeconds('cpu 1 2 3\nbtime 1700000000\nprocesses 42');
  const missing = parseBtimeSeconds('cpu 1 2 3');
  check(
    'the boot time is read out of /proc/stat or not at all',
    btime === 1700000000 && missing === null,
    `btime=${btime} missing=${missing}`,
  );
}

// ---------------------------------------------------------------------------
// The commit is not invented either
// ---------------------------------------------------------------------------

{
  const obs = hostObservation({ artifactPath, pid: null });
  check(
    'a host target with no CI record carries no commit',
    obs.commit === null && obs.commit_source === 'null',
    `commit=${obs.commit} source=${obs.commit_source}`,
  );
}

{
  const obs = hostObservation({
    artifactPath,
    pid: null,
    commit: 'abc123',
    commitSource: 'manual',
  });
  check(
    'a commit that is supplied comes with its source',
    obs.commit === 'abc123' && obs.commit_source === 'manual',
    `commit=${obs.commit} source=${obs.commit_source}`,
  );
}

// ---------------------------------------------------------------------------
// Failures are failures
// ---------------------------------------------------------------------------

function expectHardError(name, fn, mustMention) {
  let threw = null;
  try {
    fn();
  } catch (err) {
    threw = err;
  }
  // The message has to be the *right* failure, otherwise a module that
  // refused everything for the wrong reason would score a pass.
  const ok =
    threw instanceof HostTargetError &&
    (mustMention === undefined || threw.message.includes(mustMention));
  check(
    name,
    ok,
    ok
      ? threw.message.slice(0, 70)
      : `no HostTargetError for ${mustMention ?? 'any reason'}: ${threw}`,
  );
}

expectHardError(
  'a missing artifact is a hard error',
  () => fileSha256(missingPath),
  '读不到',
);
expectHardError(
  'an empty artifact is a hard error',
  () => artifactStat(emptyPath),
  '空的',
);
expectHardError(
  'a directory is not an artifact',
  () => artifactStat(dirPath),
  '目录',
);
expectHardError(
  'a missing artifact cannot become an observation',
  () => hostObservation({ artifactPath: missingPath }),
  '不存在',
);

// ---------------------------------------------------------------------------
// A deployment unit that is a directory
// ---------------------------------------------------------------------------

// The layout the real target's CI image runs: a thin jar plus the lib/
// directory it loads its dependencies from. The unit is the pair.
const unitDir = join(dir, 'unit');
mkdirSync(join(unitDir, 'lib'), { recursive: true });
writeFileSync(join(unitDir, 'app.jar'), 'thin jar v1\n');
writeFileSync(join(unitDir, 'lib', 'dep-a.jar'), 'dependency a v1\n');
writeFileSync(join(unitDir, 'lib', 'dep-b.jar'), 'dependency b v1\n');

{
  const id = treeIdentity(unitDir);
  check(
    'a deployment unit directory gets one sha256-shaped ledger key',
    id.digest.startsWith('sha256:') && id.digest.length === 71,
    `digest=${id.digest.slice(0, 24)}`,
  );
}

{
  // The same unit unpacked somewhere else is the same deployment. Identity
  // follows the content, not the path it happens to sit at.
  const copyDir = join(dir, 'unit-elsewhere');
  cpSync(unitDir, copyDir, { recursive: true });
  const a = treeSha256(unitDir);
  const b = treeSha256(copyDir);
  check(
    'the same unit under another path keeps its key',
    a === b,
    `a=${a.slice(0, 12)} b=${b.slice(0, 12)}`,
  );
}

{
  // A different dependency set is a different deployment, even though the
  // jar in it did not change. This is the case a single-file key would miss.
  const before = treeSha256(unitDir);
  writeFileSync(join(unitDir, 'lib', 'dep-b.jar'), 'dependency b v2\n');
  const after = treeSha256(unitDir);
  check(
    'a changed dependency changes the unit key even when the jar did not',
    before !== after,
    `before=${before.slice(0, 12)} after=${after.slice(0, 12)}`,
  );
  writeFileSync(join(unitDir, 'lib', 'dep-b.jar'), 'dependency b v1\n');
}

{
  // Inside the unit the path matters: the loader resolves it.
  const before = treeSha256(unitDir);
  renameSync(
    join(unitDir, 'lib', 'dep-a.jar'),
    join(unitDir, 'lib', 'renamed.jar'),
  );
  const after = treeSha256(unitDir);
  check(
    'a file moved inside the unit changes the key',
    before !== after,
    `before=${before.slice(0, 12)} after=${after.slice(0, 12)}`,
  );
  renameSync(
    join(unitDir, 'lib', 'renamed.jar'),
    join(unitDir, 'lib', 'dep-a.jar'),
  );
}

{
  // Content-addressed: touching the timestamps moves the build time, not
  // the key. The same rule the single-file form follows.
  const before = treeIdentity(unitDir);
  const files = listTreeFiles(unitDir);
  const target = files[0].abs;
  const later = new Date(Date.now() + 3600_000);
  utimesSync(target, later, later);
  const after = treeIdentity(unitDir);
  check(
    'a changed timestamp inside the unit changes the build time, not the key',
    before.digest === after.digest && before.built_at !== after.built_at,
    `before=${before.built_at} after=${after.built_at}`,
  );
}

{
  const obs = hostObservation({ artifactDir: unitDir, pid: null });
  check(
    'a directory deployment unit is observed as a unit, not as a file',
    obs.artifact_kind === 'deployment-unit-dir' &&
      obs.image_ref === unitDir &&
      obs.evidence === 'host-artifact-tree-sha256',
    `kind=${obs.artifact_kind} image_ref=${obs.image_ref}`,
  );
}

// ---------------------------------------------------------------------------
// The CLI behaves like the module
// ---------------------------------------------------------------------------

function runCli(args) {
  const r = execFileSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(r);
}

{
  const out = runCli(['--artifact', artifactPath]);
  check(
    'the CLI prints one observation for a real artifact',
    out.digest === `sha256:${fileSha256(artifactPath)}` &&
      out.pod_started_at === null &&
      out.commit === null,
    `digest=${out.digest?.slice(0, 20)} pod_started_at=${out.pod_started_at}`,
  );
}

{
  let failedHard = false;
  try {
    execFileSync(process.execPath, [cli, '--artifact', missingPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    failedHard = err.status === 1 && String(err.stderr).trim().length > 0;
  }
  check(
    'the CLI fails loudly on a missing artifact',
    failedHard,
    'exit=1 且 stderr 有说明',
  );
}

{
  let failedHard = false;
  try {
    execFileSync(process.execPath, [cli], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    failedHard = err.status === 1;
  }
  check('the CLI refuses to run without an artifact', failedHard, 'exit=1');
}

{
  const out = runCli(['--artifact-dir', unitDir]);
  check(
    'the CLI prints one observation for a deployment unit directory',
    out.digest === `sha256:${treeSha256(unitDir)}` &&
      out.artifact_kind === 'deployment-unit-dir' &&
      out.pod_started_at === null,
    `digest=${out.digest?.slice(0, 20)} kind=${out.artifact_kind}`,
  );
}

{
  // The near-identical negative: giving both forms is a refusal, and the
  // positive next to it is that each form on its own works. A CLI that
  // refused both would pass the refusal and fail the positive.
  let failedHard = false;
  try {
    execFileSync(
      process.execPath,
      [cli, '--artifact', artifactPath, '--artifact-dir', unitDir],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    failedHard = err.status === 1 && String(err.stderr).trim().length > 0;
  }
  check(
    'the CLI refuses both an artifact and a deployment unit at once',
    failedHard,
    'exit=1 且 stderr 有说明',
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
