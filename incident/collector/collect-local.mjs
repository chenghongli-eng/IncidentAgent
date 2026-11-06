#!/usr/bin/env node
// The lab fixture's own deploy-ledger segment.
//
// The registry segment answers "what is this image" for images that were
// *pushed* somewhere. The lab fixture is never pushed anywhere: it is built
// locally by `incident/lab.sh build` and run as a local container. So the
// registry segment sees nothing, and the ledger stays empty -- while every
// single round of the lab *is* a deployment (a rebuild plus a container
// start). An empty ledger and a "no deploy happened" finding are opposite
// conclusions, so the fixture needs a writer of its own.
//
// This segment writes one row per deployment observation, from the local
// docker daemon:
//
//   digest        the local image id -- docker's content hash, the same kind
//                 of identity a registry digest is
//   built_at      when the image was built
//   commit        the image's own statement of which commit it was built
//                 from, read out of org.opencontainers.image.revision
//   pod_started_at  when the container running it started
//
// Nothing here is networked and nothing here holds a credential, so it stays
// out of the "collector" boundary the real-target collectors live behind. The
// agent's read side never sees a docker socket either -- it only ever reads
// the ledger file.
//
// Usage:
//   node collect-local.mjs --ledger <path> [--container target-service]
//                          [--cluster lab-local] [--namespace <ns>]
//                          [--workload <name>] [--deployed-by <who>]
//                          [--dry-run]

import { readRunningImage } from './local-image.mjs';
import { writeEntries } from './ledger.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function die(msg) {
  console.error(msg);
  process.exit(1);
}

/**
 * Build one ledger row from local docker facts.
 *
 * Pure on purpose: the row is the part with the semantics in it (which
 * commit source, what counts as a running observation), and it has to be
 * checkable without a docker daemon. The docker reads live in
 * `local-image.mjs`.
 *
 * `image.revision` is the image's own statement. When it is missing the
 * commit stays null -- the row must not fall back to "the current HEAD",
 * because a build run on an uncommitted working tree would then produce a
 * row that looks like a fact and is not one. That mistake was observed on a
 * real image; see incident/DEPLOY-LEDGER.md.
 */
export function buildLocalEntry({
  image,
  container,
  observedAt,
  cluster = 'lab-local',
  namespace = null,
  workload = null,
  deployedBy = 'incident-lab',
}) {
  const evidence = ['docker-image-inspect', 'docker-container-inspect'];

  // 'unknown' 不是 commit，是「构建时没拿到」。它在 readLocalImage 里已经被
  // 过滤过一次，这里再挡一道：写台账的这一层不能假设上游一定干净——
  // 一条写着 commit='unknown' 的行看起来像「这个 commit 的代码」，
  // 而它其实什么都没说。
  const revision =
    image.revision && image.revision !== 'unknown' ? image.revision : null;
  const buildTime =
    image.built_at && image.built_at !== 'unknown' ? image.built_at : null;

  if (revision) evidence.push('oci-label');
  if (buildTime) evidence.push('build-time-label');

  // The build's own clock is the only usable build time. The image config's
  // `created` field is **not** one: measured on this machine, rebuilding with
  // different content changed the image digest but left `created` at the
  // nanosecond-identical value of the very first build (2026-11-04T11:25:30
  // +08:00) -- a cache artifact that predates the commit the image names.
  // `built_at` is a property of the digest -- two rows of one digest must
  // agree on it -- so it has to come from a fact that travels with the image.
  // No build-time label means the build time is unknown, and unknown is
  // recorded as null rather than filled in with a plausible-looking value.

  return {
    cluster,
    namespace,
    workload: workload ?? container.container,
    pod_name: container.container,
    node: null,
    image_ref: image.image_ref,
    digest: image.image_id,
    built_at: buildTime,
    commit: revision,
    commit_source: revision ? 'oci-label' : null,
    deployed_at: container.started_at,
    deployed_by: deployedBy,
    pod_started_at: container.started_at,
    running_observed_at: container.running ? observedAt : null,
    running_source: container.running ? 'docker' : null,
    collected_at: observedAt,
    evidence,
  };
}

function parseArgs(argv) {
  const opts = {
    ledger: null,
    container: 'target-service',
    cluster: 'lab-local',
    namespace: null,
    workload: null,
    deployedBy: 'incident-lab',
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--ledger') opts.ledger = argv[++i] ?? null;
    else if (a === '--container') opts.container = argv[++i] ?? null;
    else if (a === '--cluster') opts.cluster = argv[++i] ?? null;
    else if (a === '--namespace') opts.namespace = argv[++i] ?? null;
    else if (a === '--workload') opts.workload = argv[++i] ?? null;
    else if (a === '--deployed-by') opts.deployedBy = argv[++i] ?? null;
    else die(`unknown argument: ${a}`);
  }
  if (!opts.ledger) die('--ledger is required');
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const observedAt = new Date().toISOString();

  let image;
  let container;
  try {
    const running = readRunningImage(opts.container);
    image = running;
    container = {
      container: opts.container,
      started_at: running.container_started_at,
      running: running.running,
    };
  } catch (err) {
    die(
      `读不到本地容器 ${opts.container} 的事实：${err.message}\n` +
        '  没有这一条就没法写发布记录——不能因为采集失败就当成本轮没有发布。',
    );
  }

  const entry = buildLocalEntry({
    image,
    container,
    observedAt,
    cluster: opts.cluster,
    namespace: opts.namespace,
    workload: opts.workload,
    deployedBy: opts.deployedBy,
  });

  const result = writeEntries(opts.ledger, [entry], { dryRun: opts.dryRun });
  console.log(
    JSON.stringify(
      {
        ledger: opts.ledger,
        entry,
        appended: result.appended.length,
        skipped: result.skipped.length,
        conflicts: result.conflicts,
        superseded: result.superseded,
      },
      null,
      2,
    ),
  );
  if (result.conflicts.length > 0) process.exit(2);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
