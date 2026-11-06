#!/usr/bin/env node
// Deploy ledger collector -- registry segment.
//
// This is the *writer* side of the ledger. The read side (`incident-readonly`'s
// `deploy` channel) is deliberately dumb: it reads an append-only JSONL file
// and nothing else. This file is the only thing that talks to the network,
// and it lives outside the agent's reach -- the agent never runs it, never sees
// its credentials, and cannot make it fetch anything.
//
// The three-layer split (see incident/DEPLOY-LEDGER.md section 3):
//
//   collector (this file, network + credentials)
//     -> append-only ledger file (outside the repository)
//       -> `deploy` channel (read-only, offline, reproducible)
//
// Three rules this file exists to enforce:
//
//  1. A miss is a miss. If a tag has no manifest, or the manifest has no
//     digest, or the config blob cannot be read, the collection fails loudly.
//     It never writes a partial entry, because a partial entry is a lie the
//     read side will happily repeat back as fact.
//
//  2. A missing value stays missing. The registry does not know when a pod
//     started, so `pod_started_at` is left empty here -- it is filled by the
//     cluster segment (collect-deploy.mjs), or it stays empty forever. It is
//     never guessed.
//
//  3. A derived value carries its own confidence. The registry has no commit
//     (the images carry no OCI label), so the commit is *associated* from git
//     history by build time. That association is strong in one case and a
//     guess in another, so `commit_source` says which one it was:
//       git-window         -- the last commit before the build is close by: solid
//       git-head-fallback  -- the build sits in a quiet stretch: a guess
//       ambiguous          -- two commits share the closest timestamp
//       null               -- no git repo given, or no commit before the build
//
// The shared pieces -- the registry client, the commit association and the
// ledger semantics -- live in registry.mjs and ledger.mjs, so the CI and
// cluster segments cannot drift away from this one.
//
// Usage:
//   node incident/collector/collect-registry.mjs \
//     --registry <host:port> --repo <repository> --ledger <path> \
//     [--git <repo path>] [--tags a,b,c] [--limit N] [--since <iso>] \
//     [--near-hours N] [--token <jwt>] [--dry-run] \
//     [--running-now] [--running-source human|k8s]
//
// `--running-now` records "this image is the one running now", with the source
// of that statement (a human confirmed it, or a cluster query saw it). It is a
// separate fact from `pod_started_at` and does not stand in for it.

import { writeSync } from 'node:fs';

import {
  CollectorError,
  createRegistryClient,
  loadGitCommits,
  associateCommit,
} from './registry.mjs';
import { writeEntries } from './ledger.mjs';

function die(msg) {
  // Synchronous write: process.exit() truncates a piped stdout/stderr, and a
  // truncated error message is exactly the kind of thing this file must not
  // produce.
  writeSync(2, `${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {
    registry: null,
    repo: null,
    ledger: null,
    git: null,
    tags: null,
    limit: 20,
    since: null,
    nearHours: 2,
    token: null,
    dryRun: false,
    runningNow: false,
    runningSource: 'human',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) die(`option ${a} needs a value`);
      i += 1;
      return v;
    };
    switch (a) {
      case '--registry':
        opts.registry = next();
        break;
      case '--repo':
        opts.repo = next();
        break;
      case '--ledger':
        opts.ledger = next();
        break;
      case '--git':
        opts.git = next();
        break;
      case '--tags':
        opts.tags = next()
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case '--limit':
        opts.limit = Number(next());
        break;
      case '--since':
        opts.since = next();
        break;
      case '--near-hours':
        opts.nearHours = Number(next());
        break;
      case '--token':
        opts.token = next();
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--running-now':
        opts.runningNow = true;
        break;
      case '--running-source':
        opts.runningSource = next();
        break;
      default:
        die(`unknown option: ${a}`);
    }
  }
  if (!opts.registry) die('--registry is required');
  if (!opts.repo) die('--repo is required');
  if (!opts.ledger) die('--ledger is required');
  if (!Number.isFinite(opts.nearHours) || opts.nearHours <= 0) {
    die('--near-hours must be a positive number');
  }
  if (!['human', 'k8s'].includes(opts.runningSource)) {
    die('--running-source must be human or k8s');
  }
  if (opts.runningSource === 'k8s' && !opts.runningNow) {
    die('--running-source only applies together with --running-now');
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

// One timestamp for the whole run: a running observation made by this run is
// one observation, not one per tag.
const runObservedAt = new Date().toISOString();

const registry = createRegistryClient({
  registry: opts.registry,
  token: opts.token,
});
registry.setRepo(opts.repo);

let gitCommits = null;
function commits() {
  if (gitCommits === null) gitCommits = loadGitCommits(opts.git);
  return gitCommits;
}

// Build numbers sort numerically when they are numbers; "latest" then means
// "highest build number", not "last in the list".
function byTagOrder(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return nb - na;
  return String(b).localeCompare(String(a));
}

async function collectTag(tag) {
  const { digest, configDigest } = await registry.manifestFor(tag);
  const { builtAt, builtAtMs } = await registry.configFor(configDigest, tag);
  const assoc = associateCommit(builtAtMs, commits(), opts.nearHours);

  return {
    digest,
    image_ref: `${opts.registry}/${opts.repo}:${tag}`,
    commit: assoc.commit,
    commit_source: assoc.commit_source,
    built_at: new Date(builtAtMs).toISOString(),
    // The registry does not know when the pod started. Leaving this empty is
    // the point: the cluster segment fills it, or nobody does.
    pod_started_at: null,
    // "Which image is running" and "when did it start" are different facts
    // from different places. `--running-now` records the first one, with its
    // source, and deliberately says nothing about the second.
    ...(opts.runningNow
      ? {
          running_observed_at: runObservedAt,
          running_source: opts.runningSource,
        }
      : {}),
    collected_at: new Date().toISOString(),
    evidence: [
      'registry-manifest',
      'registry-config',
      ...(opts.git ? ['git-history'] : []),
      ...(opts.runningNow ? ['running-observation'] : []),
    ],
    // Not part of the ledger schema -- kept out of the file, reported to the
    // caller so a human can judge the association.
    _association: assoc,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let wanted = [];
let collected = [];
let appended = [];
let skipped = [];
let conflicts = [];

try {
  const tags = await registry.listTags();
  if (tags.length === 0) {
    die(`registry repository ${opts.repo} has no tags at all`);
  }

  wanted = opts.tags ?? tags.slice().sort(byTagOrder).slice(0, opts.limit);

  if (opts.since) {
    const sinceMs = Date.parse(opts.since);
    if (Number.isNaN(sinceMs)) {
      die(`--since is not a valid timestamp: ${opts.since}`);
    }
    const kept = [];
    for (const tag of wanted) {
      const { configDigest } = await registry.manifestFor(tag);
      const { builtAtMs } = await registry.configFor(configDigest, tag);
      if (builtAtMs >= sinceMs) kept.push(tag);
    }
    wanted = kept;
  }

  if (wanted.length === 0) die('no tags selected for collection');

  for (const tag of wanted) {
    collected.push(await collectTag(tag));
  }

  ({ appended, skipped, conflicts } = writeEntries(opts.ledger, collected, {
    dryRun: opts.dryRun,
  }));
} catch (err) {
  if (err instanceof CollectorError) die(err.message);
  throw err;
}

if (conflicts.length > 0) {
  writeSync(
    2,
    'ledger conflicts (same digest, incompatible facts) -- not written:\n',
  );
  for (const c of conflicts) {
    writeSync(
      2,
      `  ${c.digest}: ${c.why}; existing ${JSON.stringify(c.existing)} vs incoming ${JSON.stringify(c.incoming)}\n`,
    );
  }
}

writeSync(
  1,
  `${JSON.stringify(
    {
      registry: opts.registry,
      repo: opts.repo,
      ledger: opts.ledger,
      dry_run: opts.dryRun,
      tags_considered: wanted.length,
      appended: appended.length,
      skipped_already_present: skipped.length,
      conflicts: conflicts.length,
      entries: collected.map((e) => ({
        digest: e.digest,
        image_ref: e.image_ref,
        built_at: e.built_at,
        commit: e.commit,
        commit_source: e.commit_source,
        association: e._association.reason,
        pod_started_at: e.pod_started_at,
        running_observed_at: e.running_observed_at ?? null,
        running_source: e.running_source ?? null,
      })),
    },
    null,
    2,
  )}\n`,
);

if (conflicts.length > 0) process.exit(1);

// Node's fetch keeps its connection pool alive, so the process would sit
// there after the work is done. Everything has been written synchronously by
// now, so leaving explicitly is safe.
process.exit(0);
