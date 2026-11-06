// Shared ledger semantics for the deploy ledger collectors.
//
// The ledger is a JSONL file outside the repository. Every collector that
// writes to it -- the registry segment, the CI segment, the cluster segment --
// has to agree on what a row means, what makes two rows the same observation,
// and what makes two rows a contradiction. That agreement lives here, in one
// place, because a second copy of these rules is a second opinion that will
// eventually disagree.
//
// Three ideas:
//
// 1. A row is an *observation*, not an asset. The same image deployed again
//    later is a different observation (different pod, different start time),
//    and keeping only the first would lose "how long has this been running" --
//    which is the number the ledger exists to produce.
//
// 2. Observations are not all equal. A commit read out of the CI system's own
//    build record is a fact about that build; a commit picked by looking at
//    git timestamps is an inference; a commit somebody typed in is a claim.
//    When two rows disagree, the stronger evidence wins and the weaker one
//    stays visible as `superseded_commit` -- we do not erase the wrong
//    inference, because "the inference was wrong, and here is what was right"
//    is worth more than a clean file.
//
// 3. A contradiction is not a second rollout. One digest has one build time.
//    Two build times for one digest is the ledger holding two incompatible
//    answers to one question, and that is reported, never resolved.

import { existsSync, readFileSync, appendFileSync } from 'node:fs';

// What makes two rows "the same observation".
//
// `collected_at` is excluded on purpose: a collector that runs twice on an
// unchanged tag must not append a row just because it looked again. A
// *running* observation is different -- "this was running when I looked at
// 12:00" is a new statement every time it is made, so `running_observed_at`
// takes part in the identity. That is also what makes the ledger a heartbeat:
// a poll that finds the same pod still running still records that it looked.
export const OBSERVATION_FIELDS = [
  'cluster',
  'namespace',
  'workload',
  'pod_name',
  'image_ref',
  'digest',
  'built_at',
  'commit',
  'commit_source',
  'deployed_at',
  'deployed_by',
  'pod_started_at',
  'running_observed_at',
  'running_source',
];

// How much a commit source is worth.
//
// 3 -- the image or the build says so itself
// 2 -- inferred from a local signal (timestamps)
// 1 -- a human said so
// 0 -- no commit at all
export const COMMIT_AUTHORITY = {
  'oci-label': 3,
  annotation: 3,
  'jenkins-build': 3,
  'git-window': 2,
  'git-head-fallback': 2,
  'jenkins-parameter': 1,
  manual: 1,
};

export function commitAuthority(source) {
  return COMMIT_AUTHORITY[source] ?? 0;
}

export function readLedger(path) {
  if (!existsSync(path)) return [];
  const entries = [];
  const lines = readFileSync(path, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i].trim();
    if (!text) continue;
    try {
      entries.push({ ...JSON.parse(text), __line: i + 1 });
    } catch (err) {
      throw new Error(
        `existing ledger ${path} line ${i + 1} is not valid JSON: ${err.message}`,
      );
    }
  }
  return entries;
}

// Two timestamps can spell the same instant differently -- a registry reports
// nanoseconds, JavaScript keeps milliseconds, a human typed an offset. They
// are the same fact, so they are compared as instants. Comparing the strings
// would turn one build time into two and call it a contradiction.
export function sameInstant(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false;
  return ta === tb;
}

export function sameObservation(a, b) {
  return OBSERVATION_FIELDS.every((f) => {
    if (f === 'built_at' || f === 'running_observed_at') {
      return sameInstant(a[f] ?? null, b[f] ?? null);
    }
    return (a[f] ?? null) === (b[f] ?? null);
  });
}

// A contradiction is not "a second rollout" -- it is the ledger holding two
// incompatible answers to one question. The image build time is a property of
// the digest, so two values cannot both be true.
//
// A commit is different: two rows can disagree about the commit because one
// of them *inferred* it and the other one *read it*. That is not a
// contradiction to be refused -- it is the inference being corrected. It is
// reported as a supersession, and the ledger keeps both.
export function contradiction(a, b) {
  if (!sameInstant(a.built_at ?? null, b.built_at ?? null)) {
    return {
      kind: 'conflict',
      why: 'the same digest with two different build times',
    };
  }
  if (a.commit && b.commit && a.commit !== b.commit) {
    const aa = commitAuthority(a.commit_source);
    const ba = commitAuthority(b.commit_source);
    if (aa === ba) {
      return {
        kind: 'conflict',
        why: 'the same digest with two different commits of equal authority',
      };
    }
    if (ba > aa) {
      return {
        kind: 'supersede',
        why: 'a stronger source names a different commit',
      };
    }
    return {
      kind: 'conflict',
      why: 'a weaker source disagrees with a stronger one',
    };
  }
  return null;
}

// The ledger is append-only. An observation already in the file is never
// rewritten; a genuine contradiction is reported rather than resolved; a new
// observation of the same image is appended, because it is a new fact.
export function writeEntries(path, entries, { dryRun = false } = {}) {
  if (dryRun)
    return { appended: [], skipped: [], conflicts: [], superseded: [] };
  const existing = readLedger(path);
  const byDigest = new Map();
  for (const e of existing) {
    const list = byDigest.get(e.digest) ?? [];
    list.push(e);
    byDigest.set(e.digest, list);
  }

  const appended = [];
  const skipped = [];
  const conflicts = [];
  const superseded = [];
  for (const entry of entries) {
    const prior = byDigest.get(entry.digest) ?? [];
    const same = prior.find((p) => sameObservation(p, entry));
    if (same) {
      skipped.push({ digest: entry.digest, line: same.__line });
      continue;
    }
    let clash = null;
    for (const p of prior) {
      const why = contradiction(p, entry);
      if (why) {
        clash = { p, why };
        break;
      }
    }
    if (clash && clash.why.kind === 'conflict') {
      conflicts.push({
        digest: entry.digest,
        why: clash.why.why,
        existing: prior.map((p) => ({
          line: p.__line,
          commit: p.commit,
          built_at: p.built_at,
          pod_started_at: p.pod_started_at ?? null,
        })),
        incoming: {
          commit: entry.commit,
          built_at: entry.built_at,
          pod_started_at: entry.pod_started_at ?? null,
        },
      });
      continue;
    }
    const { _association, ...record } = entry;
    if (clash && clash.why.kind === 'supersede') {
      record.superseded_commit = {
        commit: clash.p.commit,
        commit_source: clash.p.commit_source,
        line: clash.p.__line,
      };
      superseded.push({
        digest: entry.digest,
        from: clash.p.commit,
        to: entry.commit,
      });
    }
    appended.push(record);
    byDigest.set(entry.digest, [...prior, record]);
  }

  if (appended.length > 0) {
    appendFileSync(
      path,
      appended.map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf8',
    );
  }
  return { appended, skipped, conflicts, superseded };
}
