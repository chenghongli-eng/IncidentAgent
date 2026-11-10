#!/usr/bin/env node
// Control for the deploy ledger read side (`deploy` channel).
//
// What this guards, and why it is the whole point of the channel:
//
//   "the ledger has no entry for this digest"   ->  we could not look
//   "no code changed inside the window"          ->  we looked, and ruled out a deploy
//
// Those are opposite findings, and only the second one exonerates a deploy. A
// read side that turns a miss into an empty result silently converts "I am
// blind here" into "nothing happened here" -- a false exoneration, delivered
// with the same confidence as a real answer. So the miss path must be a hard
// error, and it must not borrow the vocabulary of the negative finding.
//
// The controls below therefore assert four things about every miss:
//   1. non-zero exit
//   2. stderr says 台账缺条目 (the ledger has no entry)
//   3. stderr never says 无代码变更 (no code change) -- not even to deny it
//   4. stdout is empty, so no caller can parse a "result" out of a miss
//
// (3) is only a meaningful assertion because the tool's error path is written
// to avoid that phrase entirely. If someone later adds a fallback message that
// uses it, this control fails -- which is the intent.
//
// The positive controls exist to keep the negative ones honest: a channel that
// refuses everything would pass every refusal test above. Each negative control
// is paired with the near-identical input that must succeed.
//
// Run from the repository root:
//     node incident/runs/deploy-ledger-control.mjs

import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const cli = JSON.parse(
  readFileSync(new URL('../lab-paths.json', import.meta.url), 'utf8'),
).readonlyCli;

if (!existsSync(cli)) {
  console.error(`找不到被测工具：${cli}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

// The ambient environment must not leak into the cases: a stray DEPLOY_LEDGER
// or INCIDENT_TARGET_FILE in the caller's shell would let a "no ledger
// configured" case pass against a ledger that is in fact configured. Every
// case starts from a scrubbed environment and opts back in explicitly.
const SCRUBBED = [
  'INCIDENT_TARGET',
  'INCIDENT_TARGET_FILE',
  'INCIDENT_TARGET_DIR',
  'DEPLOY_LEDGER',
  'DEPLOY_LEDGER_STALE_HOURS',
  'DEPLOY_MATCH_TOLERANCE_SECONDS',
];

function scrubbedEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of SCRUBBED) delete env[key];
  return { ...env, ...extra };
}

function run(args, env = {}) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: scrubbedEnv(env),
  });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

const cases = [];
let failed = 0;

function record(name, ok, detail) {
  cases.push({ name, ok, detail });
  if (!ok) failed++;
}

function check(name, ok, detail) {
  record(name, ok, detail);
  return ok;
}

// Every miss must look like a miss: refuse, name the ledger gap, stay silent on
// stdout, and never speak in the language of the negative finding.
function expectMiss(name, args, env = {}) {
  const r = run(args, env);
  const saidMissing = r.err.includes('台账缺条目');
  const saidNoChange = r.err.includes('无代码变更');
  const stdoutEmpty = r.out.trim() === '';
  const ok = r.code !== 0 && saidMissing && !saidNoChange && stdoutEmpty;
  let detail = `exit=${r.code} missing=${saidMissing} no-change=${saidNoChange} stdout=${stdoutEmpty ? 'empty' : `"${r.out.trim().slice(0, 60)}"`}`;
  if (!ok) detail += ` stderr=${r.err.trim().slice(0, 200)}`;
  record(name, ok, detail);
  return r;
}

function parseOut(r) {
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fixture ledger
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'deploy-ledger-control-'));
process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the temp dir is disposable; failing to clean it is not a control failure */
  }
});

// A sha256 digest is 64 hex *characters*, and the repeating unit here is two
// characters wide -- so the count is of characters, not of repeats.
const hex = (byte, chars = 64) =>
  byte.repeat(Math.ceil(chars / byte.length)).slice(0, chars);
const DIGEST_OLD = `sha256:${hex('0f')}`;
const DIGEST_NEW = `sha256:${hex('7c')}`;
const DIGEST_ABSENT = `sha256:${hex('de')}`;
const COMMIT_OLD = '1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const COMMIT_NEW = '2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const REF_OLD = 'registry.example/orders:100';
const REF_NEW = 'registry.example/orders:101';

// The rollout that `deploy current` is supposed to match is anchored to the
// fixture container's real start time, read back through the CLI itself rather
// than through docker directly -- if `runtime started` cannot answer, that is
// the same blindness the deploy channel would have, and the case must say so
// instead of quietly passing.
function containerStartMs() {
  const r = run(['runtime', 'started']);
  const m = /^container_started_at:\s*(.+)$/m.exec(r.out);
  if (!m) return null;
  const value = m[1].trim();
  if (value === '(unavailable)') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

const startMs = containerStartMs();
const startIso = startMs === null ? null : new Date(startMs).toISOString();
const nowIso = new Date().toISOString();

const entryOld = {
  digest: DIGEST_OLD,
  image_ref: REF_OLD,
  commit: COMMIT_OLD,
  commit_source: 'oci_label',
  pod_started_at: '2026-01-01T00:00:00Z',
  collected_at: nowIso,
  evidence: { source: 'control fixture' },
};
const entryNew = {
  digest: DIGEST_NEW,
  image_ref: REF_NEW,
  commit: COMMIT_NEW,
  commit_source: 'oci_label',
  // Falls back to a fixed instant when the fixture is down; the `current`
  // cases are then reported as not-verified rather than as passing.
  pod_started_at: startIso ?? nowIso,
  collected_at: nowIso,
  evidence: { source: 'control fixture' },
};

const jsonl = (...entries) =>
  entries.map((e) => JSON.stringify(e)).join('\n') + '\n';

const freshPath = join(dir, 'ledger-fresh.jsonl');
writeFileSync(freshPath, jsonl(entryOld, entryNew));

// A ledger whose newest write is three days old. Every lookup against it still
// succeeds -- the point is that the answer must carry its own staleness.
const stalePath = join(dir, 'ledger-stale.jsonl');
const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
writeFileSync(
  stalePath,
  jsonl(
    { ...entryOld, collected_at: threeDaysAgo },
    // The anchor moves back with the collection time: a ledger that stopped
    // being written three days ago cannot also describe a rollout that started
    // a minute ago.
    { ...entryNew, pod_started_at: threeDaysAgo, collected_at: threeDaysAgo },
  ),
);

// A digest that appears twice with different commits: "which code was running"
// becomes ambiguous, and the read side must surface that rather than pick one.
const dupPath = join(dir, 'ledger-dup.jsonl');
writeFileSync(
  dupPath,
  jsonl(entryNew, { ...entryNew, commit: COMMIT_OLD, image_ref: REF_OLD }),
);

// A ledger with a corrupted line. Silently skipping it would report "no entry"
// for an entry that is sitting right there, so the parse must fail loudly.
const brokenPath = join(dir, 'ledger-broken.jsonl');
writeFileSync(
  brokenPath,
  `${JSON.stringify(entryOld)}\n{"digest": "sha256:truncated...\n${JSON.stringify(entryNew)}\n`,
);

const missingPath = join(dir, 'ledger-does-not-exist.jsonl');

// Two entries whose digests share a prefix. A prefix that matches more than
// one entry cannot be resolved to "the code that was running" -- the read side
// has to say so instead of picking one.
const AMBIGUOUS_PREFIX = 'abababa';
const ambiguousPath = join(dir, 'ledger-ambiguous-prefix.jsonl');
writeFileSync(
  ambiguousPath,
  jsonl(
    { ...entryOld, digest: `sha256:${AMBIGUOUS_PREFIX}${hex('11', 57)}` },
    {
      ...entryNew,
      digest: `sha256:${AMBIGUOUS_PREFIX}${hex('22', 57)}`,
      image_ref: 'registry.example/orders:102',
    },
  ),
);

// A descriptor whose start anchor is years away from anything in the ledger,
// and whose container does not exist locally -- so `deploy current` must fall
// back to the descriptor anchor and then still refuse to guess.
const farAnchorPath = join(dir, 'descriptor-far-anchor.json');
writeFileSync(
  farAnchorPath,
  JSON.stringify(
    {
      id: 'control-far-anchor',
      container: 'incident-no-such-container',
      startedAt: '2020-01-01T00:00:00Z',
      ledgerPath: freshPath,
    },
    null,
    2,
  ),
);

// Descriptor points at the stale ledger; DEPLOY_LEDGER points at the fresh one.
// Environment must win, otherwise a round harness cannot redirect a channel.
const staleDescriptorPath = join(dir, 'descriptor-stale.json');
writeFileSync(
  staleDescriptorPath,
  JSON.stringify(
    { id: 'control-env-precedence', ledgerPath: stalePath },
    null,
    2,
  ),
);

// ---------------------------------------------------------------------------
// Positive controls
// ---------------------------------------------------------------------------

{
  const r = run(['deploy', 'check'], { DEPLOY_LEDGER: freshPath });
  const parsed = parseOut(r);
  const ok =
    r.code === 0 &&
    parsed?.entries === 2 &&
    parsed?.distinct_digests === 2 &&
    Array.isArray(parsed?.duplicate_digests) &&
    parsed.duplicate_digests.length === 0 &&
    parsed?.ledger_freshness?.stale === false &&
    parsed?.with_start_anchor === 2;
  check(
    'a healthy ledger reports itself healthy',
    ok,
    `exit=${r.code} entries=${parsed?.entries} stale=${parsed?.ledger_freshness?.stale} anchors=${parsed?.with_start_anchor}`,
  );
}

for (const [name, key, matchedOn] of [
  ['full digest', DIGEST_NEW, 'digest'],
  ['bare hex digest (no sha256: prefix)', hex('7c'), 'digest'],
  ['image reference', REF_NEW, 'image_ref'],
  ['image tag', '101', 'image_ref tag'],
  ['commit prefix', COMMIT_NEW.slice(0, 7), 'commit prefix'],
  // Docker prints 12-character image IDs and people paste them. A short ID
  // that *is* in the ledger must resolve, not come back as "not in the ledger".
  ['short digest prefix', hex('7c', 12), 'digest prefix'],
  [
    'short digest prefix with the sha256: prefix',
    `sha256:${hex('7c', 12)}`,
    'digest prefix',
  ],
]) {
  const r = run(['deploy', 'lookup', key], { DEPLOY_LEDGER: freshPath });
  const parsed = parseOut(r);
  const ok =
    r.code === 0 &&
    parsed?.matched_on === matchedOn &&
    parsed?.entry?.commit === COMMIT_NEW;
  check(
    `lookup by ${name} resolves`,
    ok,
    `exit=${r.code} matched_on=${parsed?.matched_on} commit=${parsed?.entry?.commit?.slice(0, 7)}`,
  );
}

// ---------------------------------------------------------------------------
// Commit reliability: a commit the image did not write about itself is a lead
//
// A real image was found whose packaged config matched no local commit at all
// (see incident/DEPLOY-LEDGER.md 12.6). So an inferred commit must never be
// presented as "the code inside that image", however plausible it looks.
// ---------------------------------------------------------------------------

{
  const r = run(['deploy', 'lookup', DIGEST_NEW], { DEPLOY_LEDGER: freshPath });
  const parsed = parseOut(r);
  check(
    'an OCI label commit is reported as reliable',
    r.code === 0 && parsed?.entry?.commit_reliable === true,
    `exit=${r.code} reliable=${parsed?.entry?.commit_reliable} source=${parsed?.entry?.commit_source}`,
  );
}

{
  const ledger = join(dir, 'ledger-inferred.jsonl');
  writeFileSync(
    ledger,
    jsonl({ ...entryNew, commit_source: 'git-head-fallback' }),
  );
  const r = run(['deploy', 'lookup', DIGEST_NEW], { DEPLOY_LEDGER: ledger });
  const parsed = parseOut(r);
  const note = parsed?.entry?.commit_note ?? '';
  const ok =
    r.code === 0 &&
    parsed?.entry?.commit_reliable === false &&
    // It must say the commit is a lead AND why the lead can be wrong -- not
    // merely that it is "low confidence".
    /线索/.test(note) &&
    /未提交/.test(note);
  check(
    'an inferred commit is reported as a lead, with the reason it can be wrong',
    ok,
    `exit=${r.code} reliable=${parsed?.entry?.commit_reliable} note=${note.slice(0, 60)}`,
  );
}

{
  const r = run(['deploy', 'lookup', COMMIT_NEW.slice(0, 7)], {
    DEPLOY_LEDGER: freshPath,
  });
  const parsed = parseOut(r);
  check(
    'looking up by commit still answers, and still carries the reliability flag',
    r.code === 0 &&
      parsed?.matched_on === 'commit prefix' &&
      typeof parsed?.entry?.commit_reliable === 'boolean',
    `exit=${r.code} matched_on=${parsed?.matched_on} reliable=${parsed?.entry?.commit_reliable}`,
  );
}

// ---------------------------------------------------------------------------
// A commit that sits on several rows is still one commit
//
// The ledger takes a new row every time a deployment is observed again (a
// running poll, a heartbeat), and the same build can appear in more than one
// form -- the image it produced and the artifact unpacked from that image.
// Counting rows made all of those look like "several different commits", and
// the read side then answered "the ledger has no such commit" for a commit
// that was in the ledger. That is a false claim about absence, and it is the
// worst thing this channel can say.
//
// The near-identical negative keeps the rows but gives them two different
// commits: then a prefix really is ambiguous, and the read side must say so
// -- without claiming the commit is absent.
// ---------------------------------------------------------------------------

{
  // The same deployment, observed three times.
  const observed = join(dir, 'ledger-commit-observed.jsonl');
  writeFileSync(
    observed,
    jsonl(
      { ...entryNew, collected_at: nowIso },
      {
        ...entryNew,
        running_observed_at: nowIso,
        collected_at: nowIso,
      },
      { ...entryNew, collected_at: nowIso },
    ),
  );
  const r = run(['deploy', 'lookup', COMMIT_NEW], {
    DEPLOY_LEDGER: observed,
  });
  const parsed = parseOut(r);
  check(
    'a commit observed several times is still found',
    r.code === 0 &&
      parsed?.matched_on === 'commit' &&
      parsed?.entry?.commit === COMMIT_NEW,
    `exit=${r.code} matched_on=${parsed?.matched_on}`,
  );
}

{
  // One commit, two deployment forms (image and unpacked artifact).
  const twoForms = join(dir, 'ledger-commit-two-forms.jsonl');
  writeFileSync(
    twoForms,
    jsonl(entryNew, {
      ...entryNew,
      digest: `sha256:${hex('5a')}`,
      image_ref: '/srv/artifacts/9001',
      commit_source: 'jenkins-build',
    }),
  );
  const r = run(['deploy', 'lookup', COMMIT_NEW], {
    DEPLOY_LEDGER: twoForms,
  });
  const parsed = parseOut(r);
  check(
    'a commit deployed in two forms is found, and both forms are disclosed',
    r.code === 0 &&
      parsed?.entry?.commit === COMMIT_NEW &&
      Array.isArray(parsed?.matched_deployments) &&
      parsed.matched_deployments.length === 2,
    `exit=${r.code} deployments=${parsed?.matched_deployments?.length}`,
  );
}

{
  // The near-identical negative: one prefix, two different commits. This one
  // really is ambiguous -- and the message must not claim absence.
  const AMBIGUOUS_COMMIT = 'abababa';
  const ambiguousCommit = join(dir, 'ledger-ambiguous-commit.jsonl');
  writeFileSync(
    ambiguousCommit,
    jsonl(
      { ...entryNew, commit: `${AMBIGUOUS_COMMIT}${hex('11', 33)}` },
      {
        ...entryNew,
        commit: `${AMBIGUOUS_COMMIT}${hex('22', 33)}`,
        digest: `sha256:${hex('6b')}`,
        image_ref: 'registry.example/orders:103',
      },
    ),
  );
  const r = run(['deploy', 'lookup', AMBIGUOUS_COMMIT], {
    DEPLOY_LEDGER: ambiguousCommit,
  });
  const saidAmbiguous = r.err.includes('歧义');
  const saidMissing = r.err.includes('台账缺条目');
  check(
    'a commit prefix matching two commits is called ambiguous, not absent',
    r.code !== 0 && saidAmbiguous && !saidMissing && r.out.trim() === '',
    `exit=${r.code} ambiguous=${saidAmbiguous} missing=${saidMissing}`,
  );
}

// ---------------------------------------------------------------------------
// A commit read out of the CI build record is a fact, not an inference
//
// The image says nothing about its own commit, so the ledger takes it from the
// build that produced the image. That is a different kind of evidence from a
// timestamp inference, and the read side has to say so -- otherwise the agent
// treats a fact and a guess identically.
//
// The negative control is near-identical: the same entry shape, but the commit
// came from a CI parameter somebody typed in, which is a claim, not a fact.
// ---------------------------------------------------------------------------

{
  const ledger = join(dir, 'ledger-jenkins-build.jsonl');
  writeFileSync(ledger, jsonl({ ...entryNew, commit_source: 'jenkins-build' }));
  const r = run(['deploy', 'lookup', DIGEST_NEW], { DEPLOY_LEDGER: ledger });
  const parsed = parseOut(r);
  const note = parsed?.entry?.commit_note ?? '';
  const ok =
    r.code === 0 &&
    parsed?.entry?.commit_reliable === true &&
    /构建记录/.test(note) &&
    // The note must still carry the caveat: a build can run in a dirty
    // worktree. "Reliable" is not "identical".
    /未提交改动/.test(note);
  check(
    'a commit from the CI build record is reported as a fact, with its caveat',
    ok,
    `exit=${r.code} reliable=${parsed?.entry?.commit_reliable} source=${parsed?.entry?.commit_source}`,
  );
}

{
  const ledger = join(dir, 'ledger-jenkins-parameter.jsonl');
  writeFileSync(
    ledger,
    jsonl({ ...entryNew, commit_source: 'jenkins-parameter' }),
  );
  const r = run(['deploy', 'lookup', DIGEST_NEW], { DEPLOY_LEDGER: ledger });
  const parsed = parseOut(r);
  const ok =
    r.code === 0 &&
    parsed?.entry?.commit_reliable === false &&
    /线索/.test(parsed?.entry?.commit_note ?? '');
  check(
    'a commit from a CI parameter is a claim, and is not reported as a fact',
    ok,
    `exit=${r.code} reliable=${parsed?.entry?.commit_reliable} source=${parsed?.entry?.commit_source}`,
  );
}

// ---------------------------------------------------------------------------
// The inference is kept next to the fact, and the disagreement is visible
//
// On the real project the timestamp inference named a commit that was weeks
// old. If the ledger silently overwrote the inference, that evidence would be
// gone. So the wrong inference stays, and the reader is told the two differ.
// ---------------------------------------------------------------------------

{
  const ledger = join(dir, 'ledger-inference-conflict.jsonl');
  writeFileSync(
    ledger,
    jsonl({
      ...entryNew,
      commit_source: 'jenkins-build',
      commit: COMMIT_NEW,
      commit_inferred: COMMIT_OLD,
      commit_inferred_source: 'git-head-fallback',
    }),
  );
  const r = run(['deploy', 'lookup', DIGEST_NEW], { DEPLOY_LEDGER: ledger });
  const parsed = parseOut(r);
  const ok =
    r.code === 0 &&
    parsed?.entry?.commit_inference_conflict === true &&
    parsed?.entry?.commit_inferred === COMMIT_OLD &&
    parsed?.entry?.commit_inferred_source === 'git-head-fallback' &&
    typeof parsed?.entry?.commit_inference_note === 'string';
  check(
    'an inference that disagrees with the recorded commit is surfaced, not erased',
    ok,
    `exit=${r.code} conflict=${parsed?.entry?.commit_inference_conflict} inferred=${parsed?.entry?.commit_inferred?.slice(0, 7)}`,
  );
}

{
  // The near-identical positive: the inference agrees with the fact.
  const ledger = join(dir, 'ledger-inference-agrees.jsonl');
  writeFileSync(
    ledger,
    jsonl({
      ...entryNew,
      commit_source: 'jenkins-build',
      commit: COMMIT_NEW,
      commit_inferred: COMMIT_NEW,
      commit_inferred_source: 'git-window',
    }),
  );
  const r = run(['deploy', 'lookup', DIGEST_NEW], { DEPLOY_LEDGER: ledger });
  const parsed = parseOut(r);
  const ok =
    r.code === 0 &&
    parsed?.entry?.commit_inference_conflict === false &&
    parsed?.entry?.commit_inferred === COMMIT_NEW;
  check(
    'an inference that agrees with the recorded commit reports no conflict',
    ok,
    `exit=${r.code} conflict=${parsed?.entry?.commit_inference_conflict}`,
  );
}

// ---------------------------------------------------------------------------
// running: "which image is running now", with who said so
// ---------------------------------------------------------------------------

const runningPath = join(dir, 'ledger-running.jsonl');
writeFileSync(
  runningPath,
  jsonl(
    { ...entryOld, collected_at: nowIso },
    {
      ...entryNew,
      commit_source: 'git-head-fallback',
      // A human confirmed *which* image runs; nobody knows when it started.
      pod_started_at: null,
      running_observed_at: '2026-02-02T00:00:00Z',
      running_source: 'human',
    },
  ),
);

{
  const r = run(['deploy', 'running'], { DEPLOY_LEDGER: runningPath });
  const parsed = parseOut(r);
  const ok =
    r.code === 0 &&
    parsed?.source === 'human' &&
    parsed?.observed_at === '2026-02-02T00:00:00Z' &&
    parsed?.entry?.digest === DIGEST_NEW &&
    // A human said *which* image, never *when* it started. Leaving a blank
    // here would read like "it just started".
    parsed?.pod_started_at === null &&
    parsed?.running_for_seconds === null &&
    typeof parsed?.pod_started_note === 'string';
  check(
    'running answers with the observed image and its source, and admits the start time is unknown',
    ok,
    `exit=${r.code} source=${parsed?.source} pod_started_at=${parsed?.pod_started_at} note=${parsed?.pod_started_note ? 'present' : 'missing'}`,
  );
}

// The near-identical negative: a ledger that only knows what was built, never
// what is running. That is "we did not look", not "nothing is running".
expectMiss(
  'running with no running observation is a hard error, not an empty answer',
  ['deploy', 'running'],
  { DEPLOY_LEDGER: freshPath },
);

// ---------------------------------------------------------------------------
// Several observations of one digest
// ---------------------------------------------------------------------------

const multiPath = join(dir, 'ledger-multi-rollout.jsonl');
writeFileSync(
  multiPath,
  jsonl(
    {
      ...entryNew,
      pod_started_at: '2026-01-01T00:00:00Z',
      running_observed_at: '2026-01-02T00:00:00Z',
      commit: COMMIT_OLD,
    },
    {
      ...entryNew,
      pod_started_at: '2026-02-01T00:00:00Z',
      running_observed_at: '2026-02-02T00:00:00Z',
      commit: COMMIT_NEW,
    },
  ),
);

{
  const r = run(['deploy', 'lookup', DIGEST_NEW], { DEPLOY_LEDGER: multiPath });
  const parsed = parseOut(r);
  const ok =
    r.code === 0 &&
    parsed?.rollouts === 2 &&
    parsed?.entry?.commit === COMMIT_NEW &&
    parsed?.entry?.running_observed_at === '2026-02-02T00:00:00Z';
  check(
    'two observations of one digest resolve to the newest, and say how many there were',
    ok,
    `exit=${r.code} rollouts=${parsed?.rollouts} observed=${parsed?.entry?.running_observed_at}`,
  );
}

{
  // A poll that finds the same pod still running writes another line. That
  // line is a new *observation*, not a new *deployment*: counting lines as
  // rollouts would make a heartbeat look like a deployment history.
  const pollPath = join(dir, 'ledger-poll.jsonl');
  writeFileSync(
    pollPath,
    jsonl(
      ...[
        '2026-03-01T00:00:00Z',
        '2026-03-01T00:05:00Z',
        '2026-03-01T00:10:00Z',
      ].map((observedAt) => ({
        ...entryNew,
        pod_started_at: '2026-03-01T00:00:00Z',
        running_observed_at: observedAt,
      })),
    ),
  );
  const r = run(['deploy', 'lookup', DIGEST_NEW], { DEPLOY_LEDGER: pollPath });
  const parsed = parseOut(r);
  const ok =
    r.code === 0 &&
    parsed?.rollouts === 1 &&
    parsed?.observations === 3 &&
    parsed?.rollouts_without_start_time === 0 &&
    parsed?.entry?.running_observed_at === '2026-03-01T00:10:00Z';
  check(
    'repeated polls of one running pod count as one rollout, not three',
    ok,
    `exit=${r.code} rollouts=${parsed?.rollouts} observations=${parsed?.observations}`,
  );
}

{
  // An observation from before the cluster could be read has no start time,
  // so it cannot be pinned to a pod. It is still a separate thing from the
  // rollout we *can* pin -- and the answer has to say which is which, instead
  // of counting it as another deployment.
  const ledger = join(dir, 'ledger-unknown-start.jsonl');
  writeFileSync(
    ledger,
    jsonl(
      {
        ...entryNew,
        pod_started_at: null,
        running_observed_at: '2026-04-01T00:00:00Z',
      },
      {
        ...entryNew,
        pod_started_at: '2026-04-02T00:00:00Z',
        running_observed_at: '2026-04-02T01:00:00Z',
      },
    ),
  );
  const r = run(['deploy', 'lookup', DIGEST_NEW], { DEPLOY_LEDGER: ledger });
  const parsed = parseOut(r);
  const ok =
    r.code === 0 &&
    parsed?.rollouts === 2 &&
    parsed?.rollouts_without_start_time === 1 &&
    parsed?.observations === 2;
  check(
    'an observation with no known start time is counted and reported separately',
    ok,
    `exit=${r.code} rollouts=${parsed?.rollouts} without_start=${parsed?.rollouts_without_start_time}`,
  );
}

{
  const r = run(['deploy', 'running'], { DEPLOY_LEDGER: multiPath });
  const parsed = parseOut(r);
  const ok = r.code === 0 && parsed?.observed_at === '2026-02-02T00:00:00Z';
  check(
    'running uses the newest observation when there are several',
    ok,
    `exit=${r.code} observed_at=${parsed?.observed_at}`,
  );
}

{
  const r = run(['deploy', 'list'], { DEPLOY_LEDGER: freshPath });
  const parsed = parseOut(r);
  const ok =
    r.code === 0 &&
    parsed?.total === 2 &&
    parsed.entries.length === 2 &&
    parsed.entries[0].digest === DIGEST_NEW;
  check(
    'list returns the rollouts, newest first, and does not blanket-refuse',
    ok,
    `exit=${r.code} total=${parsed?.total} first=${parsed?.entries?.[0]?.digest?.slice(0, 14)}`,
  );
}

{
  const r = run(['deploy', 'lookup', DIGEST_OLD], { DEPLOY_LEDGER: stalePath });
  const parsed = parseOut(r);
  const ok = r.code === 0 && parsed?.entry?.ledger_freshness?.stale === true;
  check(
    'a stale ledger still answers, but the answer carries its own staleness',
    ok,
    `exit=${r.code} stale=${parsed?.entry?.ledger_freshness?.stale} age_hours=${parsed?.entry?.ledger_freshness?.age_hours}`,
  );
}

{
  const r = run(['deploy', 'lookup', DIGEST_NEW], {
    INCIDENT_TARGET_FILE: staleDescriptorPath,
    DEPLOY_LEDGER: freshPath,
  });
  const parsed = parseOut(r);
  const ok = r.code === 0 && parsed?.entry?.ledger_freshness?.stale === false;
  check(
    'DEPLOY_LEDGER wins over the descriptor ledgerPath',
    ok,
    `exit=${r.code} stale=${parsed?.entry?.ledger_freshness?.stale}`,
  );
}

{
  const r = run(['deploy', 'lookup', DIGEST_NEW], {
    INCIDENT_TARGET_FILE: staleDescriptorPath,
  });
  const parsed = parseOut(r);
  const ok = r.code === 0 && parsed?.entry?.ledger_freshness?.stale === true;
  check(
    'the descriptor ledgerPath is used when the environment is silent',
    ok,
    `exit=${r.code} stale=${parsed?.entry?.ledger_freshness?.stale}`,
  );
}

// ---------------------------------------------------------------------------
// `deploy current`: the rollout the target is running right now
// ---------------------------------------------------------------------------

if (startMs === null) {
  record(
    'current matches the running container against the ledger',
    false,
    'target-service 容器没在跑（runtime started 拿不到锚点）：这一项没有验成，不是通过',
  );
  record(
    'current refuses when no entry is near the anchor',
    false,
    '同上：没有锚点就没有可对照的负例，这一项没有验成，不是通过',
  );
} else {
  const r = run(['deploy', 'current'], { DEPLOY_LEDGER: freshPath });
  const parsed = parseOut(r);
  const ok =
    r.code === 0 &&
    parsed?.matched === true &&
    parsed?.entry?.digest === DIGEST_NEW &&
    Math.abs(parsed?.delta_seconds ?? 1e9) < 1;
  check(
    'current matches the running container against the ledger',
    ok,
    `exit=${r.code} matched=${parsed?.matched} delta=${parsed?.delta_seconds}s`,
  );

  expectMiss(
    'current refuses when no entry is near the anchor',
    ['deploy', 'current', '--tolerance', '60'],
    { INCIDENT_TARGET_FILE: farAnchorPath },
  );
}

// ---------------------------------------------------------------------------
// Negative controls: a miss must be loud, and must not sound like a negative
// finding
// ---------------------------------------------------------------------------

expectMiss(
  'lookup of an absent digest is a hard error',
  ['deploy', 'lookup', DIGEST_ABSENT],
  { DEPLOY_LEDGER: freshPath },
);

expectMiss(
  'lookup of an absent bare digest is a hard error',
  ['deploy', 'lookup', hex('de')],
  { DEPLOY_LEDGER: freshPath },
);

expectMiss(
  'lookup of an absent tag is a hard error',
  ['deploy', 'lookup', '999'],
  { DEPLOY_LEDGER: freshPath },
);

// `:101` must not be matched by the tag `10` -- loose matching here would
// attribute a fault to the wrong release, which is worse than a miss.
expectMiss(
  'lookup does not match a tag by prefix',
  ['deploy', 'lookup', '10'],
  { DEPLOY_LEDGER: freshPath },
);

expectMiss(
  'a missing ledger file is a hard error',
  ['deploy', 'lookup', DIGEST_NEW],
  { DEPLOY_LEDGER: missingPath },
);

// The near-identical positive is the short-prefix lookup above: same shape of
// input, one resolves and one must not.
expectMiss(
  'lookup of an absent short digest prefix is a hard error',
  ['deploy', 'lookup', hex('de', 12)],
  { DEPLOY_LEDGER: freshPath },
);

// A prefix that matches two entries is not a miss and not an answer. It has to
// be reported as ambiguous -- picking one of the two would attribute a fault
// to a release that may not be the one that was running.
{
  const r = run(['deploy', 'lookup', AMBIGUOUS_PREFIX], {
    DEPLOY_LEDGER: ambiguousPath,
  });
  const saidAmbiguous = r.err.includes('歧义');
  const saidNoChange = r.err.includes('无代码变更');
  const stdoutEmpty = r.out.trim() === '';
  const ok = r.code !== 0 && saidAmbiguous && !saidNoChange && stdoutEmpty;
  check(
    'a prefix matching two entries is reported as ambiguous, not resolved',
    ok,
    `exit=${r.code} ambiguous=${saidAmbiguous} no-change=${saidNoChange} stdout=${stdoutEmpty ? 'empty' : 'not empty'}`,
  );
}

// The near-identical positive: the same ledger, the same entry, the full
// digest. An ambiguous prefix must not make exact lookups unanswerable.
{
  const full = `sha256:${AMBIGUOUS_PREFIX}${hex('22', 57)}`;
  const r = run(['deploy', 'lookup', full], { DEPLOY_LEDGER: ambiguousPath });
  const parsed = parseOut(r);
  const ok = r.code === 0 && parsed?.entry?.digest === full;
  check(
    'an ambiguous prefix does not block the full-digest lookup in the same ledger',
    ok,
    `exit=${r.code} matched_on=${parsed?.matched_on}`,
  );
}

expectMiss('no ledger configured at all is a hard error, not an empty result', [
  'deploy',
  'lookup',
  DIGEST_NEW,
]);

expectMiss(
  'a corrupted ledger line is a hard error, not a silent skip',
  ['deploy', 'lookup', DIGEST_NEW],
  { DEPLOY_LEDGER: brokenPath },
);

{
  const r = run(['deploy', 'check'], { DEPLOY_LEDGER: brokenPath });
  const ok =
    r.code !== 0 && r.err.includes('台账缺条目') && r.err.includes('第 2 行');
  check(
    'the corrupted-line error names the offending line',
    ok,
    `exit=${r.code} names-line=${r.err.includes('第 2 行')}`,
  );
}

{
  const r = run(['deploy', 'check'], { DEPLOY_LEDGER: dupPath });
  const parsed = parseOut(r);
  const ok =
    r.code === 0 &&
    parsed?.duplicate_digests?.length === 1 &&
    parsed.duplicate_digests[0].digest === DIGEST_NEW &&
    parsed.duplicate_digests[0].lines.length === 2;
  check(
    'a digest that appears twice is reported, not silently resolved',
    ok,
    `exit=${r.code} duplicates=${parsed?.duplicate_digests?.length}`,
  );
}

// ---------------------------------------------------------------------------
// The anchor of a host-process target is measured, not declared
//
// A target that runs as a host process has no container to inspect. Its
// anchor used to be a field in the descriptor -- a value a human typed once.
// On the second restart that field is stale, and a stale anchor is worse
// than none: `deploy current` would report "no ledger entry matches this
// startup" for a deployment the ledger does have.
//
// The anchor is now measured from the live process (its start time out of
// /proc, found by the port the target's actuator listens on). The descriptor
// field is only the last resort.
// ---------------------------------------------------------------------------

{
  // The port this control listens on is the target's actuator port for the
  // duration of the case.
  const server = createServer((_req, res) => {
    res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  // An independent reading of this process's own start time, from the
  // system: elapsed seconds since it started.
  const elapsed = Number(
    spawnSync('ps', ['-o', 'etimes=', '-p', String(process.pid)], {
      encoding: 'utf8',
    }).stdout.trim(),
  );
  const selfStart = new Date(Date.now() - elapsed * 1000).toISOString();

  const descriptorPath = join(dir, 'host-target.json');
  const ledgerPath = join(dir, 'host-target-ledger.jsonl');
  // A deliberately wrong declared anchor: if the tool reports this one, it
  // is reading a stale human-typed value.
  writeFileSync(
    descriptorPath,
    JSON.stringify({
      id: 'host-form-control',
      actuatorBaseUrl: `http://127.0.0.1:${port}`,
      container: 'no-such-container-for-this-control',
      startedAt: '2020-01-01T00:00:00Z',
    }),
  );
  writeFileSync(
    ledgerPath,
    `${JSON.stringify({
      digest: DIGEST_NEW,
      image_ref: 'host-form-control',
      pod_started_at: selfStart,
      running_observed_at: selfStart,
      running_source: 'host',
      collected_at: selfStart,
    })}\n`,
  );

  const r = run(['deploy', 'current'], {
    INCIDENT_TARGET_FILE: descriptorPath,
    DEPLOY_LEDGER: ledgerPath,
  });
  const parsed = parseOut(r);
  const measured =
    r.code === 0 &&
    typeof parsed?.anchor_source === 'string' &&
    parsed.anchor_source.includes('host process') &&
    parsed.matched === true &&
    Math.abs(parsed.delta_seconds) < 5;
  check(
    'the anchor of a host-process target is measured from the live process',
    measured,
    `exit=${r.code} source=${parsed?.anchor_source} matched=${parsed?.matched} delta=${parsed?.delta_seconds}`,
  );

  // The near-identical negative: the same descriptor with a port nobody
  // listens on. There is no process to measure, so the declared value is
  // used -- and the tool says which one it used. A tool that always reported
  // "host process" would pass the case above and fail this one.
  const deadDescriptorPath = join(dir, 'host-target-dead.json');
  writeFileSync(
    deadDescriptorPath,
    JSON.stringify({
      id: 'host-form-control',
      actuatorBaseUrl: 'http://127.0.0.1:1',
      container: 'no-such-container-for-this-control',
      startedAt: '2020-01-01T00:00:00Z',
    }),
  );
  const dead = run(['deploy', 'current'], {
    INCIDENT_TARGET_FILE: deadDescriptorPath,
    DEPLOY_LEDGER: ledgerPath,
  });
  // With the declared anchor nothing in the ledger matches, so the tool
  // refuses -- and the refusal has to name the anchor it used and where it
  // came from, so a reader can tell a stale anchor from a real one.
  const fellBack =
    dead.code !== 0 &&
    dead.err.includes('2020-01-01T00:00:00.000Z') &&
    dead.err.includes('descriptor.startedAt');
  check(
    'with no live process the declared anchor is used and named as such',
    fellBack,
    `exit=${dead.code} names-anchor=${dead.err.includes('2020-01-01T00:00:00.000Z')} names-source=${dead.err.includes('descriptor.startedAt')}`,
  );

  server.close();
}

// ---------------------------------------------------------------------------

for (const c of cases) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  [${c.detail}]`);
}
console.log(`\n${cases.length - failed}/${cases.length} 通过`);

if (failed > 0) process.exit(1);
