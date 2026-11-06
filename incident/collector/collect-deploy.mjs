#!/usr/bin/env node
// Deploy ledger collector -- CI segment and cluster segment.
//
// This is the writer side of the ledger, and the only thing that talks to the
// network. The read side (`incident-readonly`'s `deploy` channel) reads an
// append-only JSONL file and nothing else; it never sees a credential.
//
// Three sources, three different kinds of knowledge:
//
//   registry  -- what the image is:      digest, build time
//   CI        -- what the build used:    the commit it checked out  (a fact)
//   cluster   -- what is running:        the pod, its imageID, when it started
//
// The registry segment alone exists in collect-registry.mjs. This file adds
// the other two and merges them into one row per observation, because the
// three describe the same rollout and splitting them would make the reader
// do the joining -- and a reader that joins on its own will get it wrong.
//
// Rules this file enforces:
//
//  1. A miss is a miss. No manifest, no build record, no pod -- the
//     collection fails loudly instead of writing a partial entry.
//  2. The CI record wins over a timestamp inference, and the losing
//     inference is kept (`commit_inferred`) rather than erased. "The guess
//     was wrong and here is what was right" is worth more than a clean file.
//  3. A running pod whose imageID differs from the registry digest for the
//     same tag is a contradiction, not a second rollout: the tag was
//     re-pushed. It is reported and not written.
//  4. Credentials never come from argv (argv is in the shell history and the
//     process list). They come from a file outside the repository.
//
// Usage:
//   node incident/collector/collect-deploy.mjs \
//     --registry <host:port> --repo <repository> --ledger <path> \
//     [--git <repo path>] [--tags a,b,c] [--limit N] [--near-hours N] \
//     [--dry-run] \
//     [--jenkins-url <url> --jenkins-job <job> --jenkins-credentials-file <f>] \
//     [--rancher-url <url> --rancher-cluster <id> --rancher-namespace <ns> \
//      --rancher-credentials-file <f> --rancher-ca <pem>]

import { writeSync } from 'node:fs';

import {
  CollectorError,
  createRegistryClient,
  loadGitCommits,
  associateCommit,
} from './registry.mjs';
import { createJenkinsClient, resolveCredentials } from './jenkins.mjs';
import { createClusterClient, splitImageRef } from './cluster.mjs';
import { writeEntries } from './ledger.mjs';

function die(msg) {
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
    nearHours: 2,
    dryRun: false,
    jenkinsUrl: null,
    jenkinsJob: null,
    jenkinsCredentialsFile: null,
    rancherUrl: null,
    rancherCluster: null,
    rancherNamespace: null,
    rancherCredentialsFile: null,
    rancherCa: null,
    clusterName: null,
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
      case '--near-hours':
        opts.nearHours = Number(next());
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--jenkins-url':
        opts.jenkinsUrl = next();
        break;
      case '--jenkins-job':
        opts.jenkinsJob = next();
        break;
      case '--jenkins-credentials-file':
        opts.jenkinsCredentialsFile = next();
        break;
      case '--rancher-url':
        opts.rancherUrl = next();
        break;
      case '--rancher-cluster':
        opts.rancherCluster = next();
        break;
      case '--rancher-namespace':
        opts.rancherNamespace = next();
        break;
      case '--rancher-credentials-file':
        opts.rancherCredentialsFile = next();
        break;
      case '--rancher-ca':
        opts.rancherCa = next();
        break;
      case '--cluster-name':
        opts.clusterName = next();
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
  const jenkinsAsked = opts.jenkinsUrl || opts.jenkinsJob;
  if (jenkinsAsked && (!opts.jenkinsUrl || !opts.jenkinsJob)) {
    die('--jenkins-url and --jenkins-job go together');
  }
  const rancherAsked =
    opts.rancherUrl || opts.rancherCluster || opts.rancherNamespace;
  if (
    rancherAsked &&
    (!opts.rancherUrl || !opts.rancherCluster || !opts.rancherNamespace)
  ) {
    die('--rancher-url, --rancher-cluster and --rancher-namespace go together');
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const runObservedAt = new Date().toISOString();

function byTagOrder(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return nb - na;
  return String(b).localeCompare(String(a));
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

const registry = createRegistryClient({ registry: opts.registry });
registry.setRepo(opts.repo);

let gitCommits = [];
if (opts.git) gitCommits = loadGitCommits(opts.git);

let jenkins = null;
if (opts.jenkinsUrl && opts.jenkinsJob) {
  const creds = resolveCredentials({
    file: opts.jenkinsCredentialsFile,
    prefix: 'JENKINS',
    required: ['USER', 'TOKEN'],
  });
  jenkins = createJenkinsClient({
    url: opts.jenkinsUrl,
    user: creds.USER,
    token: creds.TOKEN,
    job: creds.JOB ?? opts.jenkinsJob,
  });
}

let cluster = null;
if (opts.rancherUrl && opts.rancherCluster && opts.rancherNamespace) {
  const creds = resolveCredentials({
    file: opts.rancherCredentialsFile,
    prefix: 'RANCHER',
    required: ['TOKEN'],
  });
  cluster = createClusterClient({
    url: opts.rancherUrl,
    token: creds.TOKEN,
    ca: opts.rancherCa ?? creds.CA ?? null,
    cluster: creds.CLUSTER ?? opts.rancherCluster,
    namespace: creds.NAMESPACE ?? opts.rancherNamespace,
  });
}

// ---------------------------------------------------------------------------
// Registry facts
// ---------------------------------------------------------------------------

const allTags = await registry.listTags();
if (allTags.length === 0) {
  die(`registry repository ${opts.repo} has no tags at all`);
}
let wanted = opts.tags ?? allTags.slice().sort(byTagOrder).slice(0, opts.limit);
if (wanted.length === 0) die('no tags selected for collection');

const registryFacts = new Map();
for (const tag of wanted) {
  const { digest, configDigest } = await registry.manifestFor(tag);
  const { builtAt, builtAtMs } = await registry.configFor(configDigest, tag);
  registryFacts.set(tag, { digest, built_at: builtAt, built_at_ms: builtAtMs });
}

// ---------------------------------------------------------------------------
// CI facts
// ---------------------------------------------------------------------------

const ciFacts = new Map();
if (jenkins) {
  for (const tag of wanted) {
    const build = await jenkins.build(tag);
    if (!build.sha1) {
      throw new CollectorError(
        `CI build ${tag} carries no revision: the build did not record what it checked out`,
      );
    }
    ciFacts.set(tag, build);
  }
}

// ---------------------------------------------------------------------------
// Cluster facts
// ---------------------------------------------------------------------------

const clusterFacts = new Map();
if (cluster) {
  const pods = await cluster.listPods();
  for (const pod of pods) {
    for (const container of pod.containers) {
      if (!container.digest) continue;
      const { repo, tag } = splitImageRef(container.image_ref);
      if (!tag) continue;
      // The registry repository is the last path segment of the image ref.
      const imageRepo = repo.split('/').pop();
      if (imageRepo !== opts.repo) continue;
      clusterFacts.set(tag, {
        ...container,
        pod_name: pod.pod_name,
        node: pod.node,
        pod_scheduled_at: pod.pod_scheduled_at,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

const rows = [];
const mismatches = [];

for (const tag of wanted) {
  const reg = registryFacts.get(tag);
  const ci = ciFacts.get(tag) ?? null;
  const pod = clusterFacts.get(tag) ?? null;

  if (pod && pod.digest !== reg.digest) {
    // The pod runs a digest that the tag does not point at: the tag was
    // re-pushed after the pod started. That is a contradiction about one
    // tag, not a second rollout, and it must not be written.
    mismatches.push({
      tag,
      registry_digest: reg.digest,
      running_digest: pod.digest,
      pod_name: pod.pod_name,
    });
    continue;
  }

  const inferred = gitCommits.length
    ? associateCommit(reg.built_at_ms, gitCommits, opts.nearHours)
    : { commit: null, commit_source: 'null', reason: 'no git history' };

  const commit = ci ? ci.sha1 : inferred.commit;
  const commitSource = ci ? 'jenkins-build' : inferred.commit_source;

  const evidence = ['registry-manifest', 'registry-config'];
  if (opts.git) evidence.push('git-history');
  if (ci) evidence.push('ci-build-record');
  if (pod) evidence.push('cluster-pod', 'running-observation');

  rows.push({
    cluster: opts.clusterName ?? opts.rancherCluster ?? null,
    namespace: opts.rancherNamespace ?? null,
    workload: opts.repo,
    pod_name: pod?.pod_name ?? null,
    node: pod?.node ?? null,
    image_ref: `${opts.registry}/${opts.repo}:${tag}`,
    digest: reg.digest,
    built_at: new Date(reg.built_at_ms).toISOString(),
    commit,
    commit_source: commitSource,
    // The timestamp inference is kept even when the CI record agrees with it,
    // and kept especially when it does not: that difference is the evidence
    // that the inference is not to be trusted.
    commit_inferred: inferred.commit,
    commit_inferred_source: inferred.commit_source,
    build_number: ci ? ci.number : null,
    build_started_at: ci ? ci.started_at : null,
    build_result: ci ? ci.result : null,
    build_branch: ci ? ci.branch : null,
    pod_started_at: pod?.started_at ?? null,
    pod_scheduled_at: pod?.pod_scheduled_at ?? null,
    running_observed_at: pod ? runObservedAt : null,
    running_source: pod ? 'k8s' : null,
    collected_at: runObservedAt,
    evidence,
  });
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

const { appended, skipped, conflicts, superseded } = writeEntries(
  opts.ledger,
  rows,
  {
    dryRun: opts.dryRun,
  },
);

if (mismatches.length > 0) {
  writeSync(
    2,
    'the running image does not match the tag it claims to run -- not written:\n',
  );
  for (const m of mismatches) {
    writeSync(
      2,
      `  tag ${m.tag}: pod ${m.pod_name} runs ${m.running_digest} but the tag points at ${m.registry_digest}\n`,
    );
  }
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
      sources: {
        registry: true,
        ci: Boolean(jenkins),
        cluster: Boolean(cluster),
      },
      tags_considered: wanted.length,
      appended: appended.length,
      skipped_already_present: skipped.length,
      conflicts: conflicts.length,
      superseded: superseded.length,
      entries: rows.map((r) => ({
        tag: r.image_ref.split(':').pop(),
        digest: r.digest,
        built_at: r.built_at,
        commit: r.commit,
        commit_source: r.commit_source,
        commit_inferred: r.commit_inferred,
        commit_inferred_source: r.commit_inferred_source,
        build_started_at: r.build_started_at,
        pod_started_at: r.pod_started_at,
        running_observed_at: r.running_observed_at,
        running_source: r.running_source,
      })),
    },
    null,
    2,
  )}\n`,
);

if (conflicts.length > 0 || mismatches.length > 0) process.exit(1);
process.exit(0);
