#!/usr/bin/env node
// Control for the lab fixture's own deploy-ledger segment.
//
// The fixture is never pushed to a registry, so `collect-registry.mjs` cannot
// see it -- and a round of the lab *is* a deployment. This segment writes the
// row that says so, and it is the only place that knows what a "deployment"
// means for a locally built image.
//
// The row carries the facts that decide whether a diagnosis can be trusted:
//
//   digest        the image id -- docker's content hash
//   commit        the image's own statement of which commit went into it
//   built_at      when this image was actually built
//   pod_started_at  when the container running it started
//
// Three of those are easy to get wrong in a way that still *looks* right:
//
//   - a missing revision label must leave the commit **unknown**, not filled
//     in from the current HEAD (a build on an uncommitted tree then claims a
//     commit it does not contain);
//   - a container that is not running must not be recorded as running;
//   - the build time must come from this build, not from the oldest cached
//     layer (BuildKit keeps the old timestamp in the image config, so a
//     rebuild that changed only a label reports a build time days in the past).
//
// Every negative is paired with a near-identical positive, so a segment that
// refuses everything would not pass.
//
// Run from the repository root:
//     node incident/collector/local-control.mjs

import { mkdtempSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildLocalEntry } from './collect-local.mjs';
import { readRunningImage, LocalImageError } from './local-image.mjs';

const cases = [];
let failed = 0;
function check(name, ok, detail) {
  cases.push({ name, ok, detail });
  if (!ok) failed++;
}

const dir = mkdtempSync(join(tmpdir(), 'local-control-'));
process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the temp dir is disposable */
  }
});

// ---------------------------------------------------------------------------
// Fixtures: the facts a docker daemon would have handed us
// ---------------------------------------------------------------------------

const CONTAINER = {
  container: 'target-service',
  started_at: '2026-11-06T08:54:13.72795817Z',
  running: true,
};

function image(overrides = {}) {
  return {
    image_ref: 'incident/target-service:baseline',
    image_id: 'sha256:aaaa',
    created_at: '2026-11-04T03:25:30.058Z',
    labels: {},
    revision: null,
    built_at: null,
    ...overrides,
  };
}

const OBSERVED_AT = '2026-11-06T08:55:05.360Z';

// ---------------------------------------------------------------------------
// The commit is the image's own statement, or nothing
// ---------------------------------------------------------------------------

{
  const entry = buildLocalEntry({
    image: image({ revision: '41ef6f2' }),
    container: CONTAINER,
    observedAt: OBSERVED_AT,
  });
  check(
    'an image that names its commit gets that commit, from the image itself',
    entry.commit === '41ef6f2' && entry.commit_source === 'oci-label',
    `commit=${entry.commit} source=${entry.commit_source}`,
  );
}

{
  // The near-identical negative: no revision label means the commit is
  // unknown. It must NOT be filled in from the current HEAD -- a build on an
  // uncommitted working tree would then report a commit the image does not
  // contain, and that mistake was observed on a real project.
  const entry = buildLocalEntry({
    image: image(),
    container: CONTAINER,
    observedAt: OBSERVED_AT,
  });
  check(
    'an image with no revision label carries no commit',
    entry.commit === null && entry.commit_source === null,
    `commit=${entry.commit} source=${entry.commit_source}`,
  );
}

{
  // The reader is where "unknown" is filtered out: `readLocalImage` turns a
  // revision of "unknown" into `null`, so `buildLocalEntry` never sees the
  // word. What matters is the outcome on the path that actually runs, so
  // this case goes through the real docker daemon: a row built from the
  // running image must never carry "unknown" as its commit.
  let running = null;
  let err = null;
  try {
    running = readRunningImage('target-service');
  } catch (e) {
    err = e;
  }
  const entry = buildLocalEntry({
    image: running ?? image(),
    container: {
      container: 'target-service',
      started_at: running?.container_started_at ?? null,
      running: running?.running ?? false,
    },
    observedAt: OBSERVED_AT,
  });
  const commit = entry.commit;
  check(
    'a row built from the running image never carries "unknown" as its commit',
    err === null &&
      commit !== 'unknown' &&
      (commit === null || /^[0-9a-f]{7,40}$/.test(commit)),
    err ? String(err.message).slice(0, 80) : `commit=${commit}`,
  );
}

{
  const withRevision = buildLocalEntry({
    image: image({ revision: '41ef6f2' }),
    container: CONTAINER,
    observedAt: OBSERVED_AT,
  });
  const without = buildLocalEntry({
    image: image(),
    container: CONTAINER,
    observedAt: OBSERVED_AT,
  });
  check(
    'the evidence list says where the commit came from, and only then',
    withRevision.evidence.includes('oci-label') &&
      !without.evidence.includes('oci-label'),
    `with=${withRevision.evidence.join(',')} without=${without.evidence.join(',')}`,
  );
}

// ---------------------------------------------------------------------------
// The build time is this build, not the oldest cached layer
// ---------------------------------------------------------------------------

{
  const entry = buildLocalEntry({
    image: image({ built_at: '2026-11-06T08:53:40Z' }),
    container: CONTAINER,
    observedAt: OBSERVED_AT,
  });
  check(
    "the build's own clock beats the image config's created field",
    entry.built_at === '2026-11-06T08:53:40Z',
    `built_at=${entry.built_at}`,
  );
}

{
  // The near-identical negative: an image this lab did not build carries no
  // build-time label. The config's `created` field is **not** a build time --
  // BuildKit keeps the oldest cached layer's timestamp there, so it can be
  // days older than the build that produced the image. So the row must say
  // "unknown", not borrow a number that reads like a fact.
  const entry = buildLocalEntry({
    image: image(),
    container: CONTAINER,
    observedAt: OBSERVED_AT,
  });
  check(
    'without a build-time label the build time is null, not the config timestamp',
    entry.built_at === null,
    `built_at=${entry.built_at}`,
  );
}

{
  // The same thing stated as a negative assertion: the config timestamp must
  // never reach the row. If a future change reintroduces the fallback, this
  // is the case that catches it -- and it is paired with the case above,
  // which proves the row is still filled in when the label *is* there.
  const withCreated = buildLocalEntry({
    image: image({ created_at: '2026-11-04T03:25:30.058Z' }),
    container: CONTAINER,
    observedAt: OBSERVED_AT,
  });
  const withLabel = buildLocalEntry({
    image: image({
      created_at: '2026-11-04T03:25:30.058Z',
      built_at: '2026-11-06T08:53:40Z',
    }),
    container: CONTAINER,
    observedAt: OBSERVED_AT,
  });
  check(
    'the config timestamp never reaches the row, and the label does',
    withCreated.built_at === null &&
      withLabel.built_at === '2026-11-06T08:53:40Z',
    `without=${withCreated.built_at} with=${withLabel.built_at}`,
  );
}

{
  const entry = buildLocalEntry({
    image: image({ created_at: null }),
    container: CONTAINER,
    observedAt: OBSERVED_AT,
  });
  check(
    'with no timestamp at all the build time is null, not now',
    entry.built_at === null,
    `built_at=${entry.built_at}`,
  );
}

// ---------------------------------------------------------------------------
// Running is observed, not assumed
// ---------------------------------------------------------------------------

{
  const entry = buildLocalEntry({
    image: image(),
    container: CONTAINER,
    observedAt: OBSERVED_AT,
  });
  check(
    'a running container is recorded as running, with who observed it',
    entry.running_observed_at === OBSERVED_AT &&
      entry.running_source === 'docker',
    `at=${entry.running_observed_at} source=${entry.running_source}`,
  );
}

{
  // The near-identical negative: a stopped container is not a running
  // service.
  const entry = buildLocalEntry({
    image: image(),
    container: { ...CONTAINER, running: false },
    observedAt: OBSERVED_AT,
  });
  check(
    'a stopped container is not recorded as running',
    entry.running_observed_at === null && entry.running_source === null,
    `at=${entry.running_observed_at} source=${entry.running_source}`,
  );
}

// ---------------------------------------------------------------------------
// The identity is the image, not the tag
// ---------------------------------------------------------------------------

{
  const entry = buildLocalEntry({
    image: image(),
    container: CONTAINER,
    observedAt: OBSERVED_AT,
  });
  check(
    'the ledger key is the image id, not the tag',
    entry.digest === 'sha256:aaaa' &&
      entry.image_ref === 'incident/target-service:baseline',
    `digest=${entry.digest} ref=${entry.image_ref}`,
  );
}

{
  const entry = buildLocalEntry({
    image: image(),
    container: CONTAINER,
    observedAt: OBSERVED_AT,
  });
  check(
    'the deployment anchor is the container start time',
    entry.pod_started_at === CONTAINER.started_at &&
      entry.deployed_at === CONTAINER.started_at,
    `pod_started_at=${entry.pod_started_at}`,
  );
}

// ---------------------------------------------------------------------------
// Against the real docker daemon
// ---------------------------------------------------------------------------
//
// These two cases need a daemon on purpose: the argument form of
// `docker inspect` is exactly the kind of thing that is wrong in a way that
// still reads fine in the source (`docker inspect container <name>` treats
// "container" as a name and fails with "no such object"). It was wrong here,
// and the failure looked like "the container is not there".

{
  let running = null;
  let err = null;
  try {
    running = readRunningImage('target-service');
  } catch (e) {
    err = e;
  }
  check(
    'the running fixture image can be read from the docker daemon',
    err === null &&
      running !== null &&
      typeof running.image_id === 'string' &&
      running.image_id.startsWith('sha256:'),
    err
      ? String(err.message).slice(0, 80)
      : `image_id=${running?.image_id?.slice(0, 20)}`,
  );
}

{
  // The near-identical negative: a container that is not there must be an
  // error, not an empty result that reads as "nothing to record".
  let threw = null;
  try {
    readRunningImage('no-such-container-9f3a2b');
  } catch (e) {
    threw = e;
  }
  check(
    'a container that is not there is an error, not an empty answer',
    threw instanceof LocalImageError,
    threw ? String(threw.message).slice(0, 80) : 'no error thrown',
  );
}

{
  // The staleness regression, against the real image: the build-time label
  // has to be there, and it can never be older than the image's own oldest
  // layer. A build that happened before its own base layer is impossible, so
  // this fails if the timestamp came from the wrong place.
  let running = null;
  let err = null;
  try {
    running = readRunningImage('target-service');
  } catch (e) {
    err = e;
  }
  const label = running?.labels?.['io.incident-lab.build-time'] ?? null;
  const labelMs = label ? Date.parse(label) : NaN;
  const createdMs = running ? Date.parse(running.created_at) : NaN;
  check(
    'the running image carries a build-time label, and it is not older than the image',
    err === null &&
      label !== null &&
      Number.isFinite(labelMs) &&
      Number.isFinite(createdMs) &&
      labelMs >= createdMs,
    err
      ? String(err.message).slice(0, 80)
      : `label=${label} created=${running?.created_at}`,
  );
}

{
  // And the row that comes out of it carries that label, not the config's
  // timestamp -- the two differ by days after a rebuild that changed only a
  // label, which is the whole point.
  let running = null;
  let err = null;
  try {
    running = readRunningImage('target-service');
  } catch (e) {
    err = e;
  }
  const entry = buildLocalEntry({
    image: running ?? image(),
    container: {
      container: 'target-service',
      started_at: running?.container_started_at ?? null,
      running: running?.running ?? false,
    },
    observedAt: OBSERVED_AT,
  });
  check(
    "the row's build time is the build's own clock",
    err === null && entry.built_at === running?.built_at,
    err ? String(err.message).slice(0, 80) : `built_at=${entry.built_at}`,
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
