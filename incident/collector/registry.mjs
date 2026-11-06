// Registry client and commit association, shared by the ledger collectors.
//
// Split out of collect-registry.mjs so the deploy collector can reuse the
// exact same client -- one implementation of "how do we ask the registry what
// this tag is" means the two collectors cannot drift apart and disagree about
// a digest.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export const MANIFEST_ACCEPT = [
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.index.v1+json',
].join(',');

export class CollectorError extends Error {}

export function createRegistryClient({ registry, token = null }) {
  let anonToken = null;

  const base = String(registry)
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
  const url = (path) => `http://${base}${path}`;

  async function request(path, { accept } = {}) {
    const headers = {};
    if (accept) headers.Accept = accept;
    if (token) headers.Authorization = `Bearer ${token}`;
    else if (anonToken) headers.Authorization = `Bearer ${anonToken}`;

    let res;
    try {
      res = await fetch(url(path), { headers });
    } catch (err) {
      throw new CollectorError(
        `registry unreachable at ${registry}: ${err.message}`,
      );
    }
    if (res.status === 401 && !token && !anonToken) {
      // The registry root asks for auth even when the repositories themselves do
      // not. Asking the token endpoint is what turns "root says 401" into
      // "this repository is readable".
      anonToken = await fetchAnonToken();
      if (anonToken) return request(path, { accept });
    }
    return res;
  }

  async function fetchAnonToken() {
    const scope = `repository:${repo}:pull`;
    try {
      const res = await fetch(
        url(`/v2/token?service=registry&scope=${encodeURIComponent(scope)}`),
      );
      if (!res.ok) return null;
      const body = await res.json();
      return body.token ?? body.access_token ?? null;
    } catch {
      return null;
    }
  }

  let repo = null;

  async function getJson(path, { accept, what } = {}) {
    const res = await request(path, { accept });
    if (!res.ok) {
      throw new CollectorError(
        `registry returned ${res.status} for ${what ?? path}`,
      );
    }
    const text = await res.text();
    try {
      return { data: JSON.parse(text), headers: res.headers };
    } catch (err) {
      throw new CollectorError(
        `registry returned invalid JSON for ${what ?? path}: ${err.message}`,
      );
    }
  }

  return {
    setRepo(r) {
      repo = r;
    },
    async listTags() {
      const { data } = await getJson(`/v2/${repo}/tags/list`, {
        what: 'the tag list',
      });
      if (!Array.isArray(data?.tags)) {
        throw new CollectorError(
          `registry tag list for ${repo} has no tags array`,
        );
      }
      return data.tags;
    },
    async manifestFor(tag) {
      const { data, headers } = await getJson(`/v2/${repo}/manifests/${tag}`, {
        accept: MANIFEST_ACCEPT,
        what: `manifest for tag ${tag}`,
      });
      const digest = headers.get('docker-content-digest');
      if (!digest) {
        throw new CollectorError(
          `registry gave no Docker-Content-Digest for tag ${tag}`,
        );
      }
      const configDigest = data?.config?.digest;
      if (!configDigest) {
        throw new CollectorError(
          `manifest for tag ${tag} has no config digest`,
        );
      }
      return { digest, configDigest };
    },
    async configFor(configDigest, tag) {
      const { data } = await getJson(`/v2/${repo}/blobs/${configDigest}`, {
        what: `image config for tag ${tag}`,
      });
      const raw = data?.created ?? null;
      if (!raw) {
        throw new CollectorError(
          `image config for tag ${tag} has no created timestamp`,
        );
      }
      const ms = Date.parse(raw);
      if (Number.isNaN(ms)) {
        throw new CollectorError(
          `image config for tag ${tag} has an unparseable created timestamp: ${raw}`,
        );
      }
      // The registry writes nanosecond precision; JavaScript keeps
      // milliseconds. The ledger stores the millisecond form, always: the same
      // instant written two ways would look like two different build times,
      // and the ledger would call that a contradiction.
      return { builtAt: new Date(ms).toISOString(), builtAtMs: ms };
    },
  };
}

export function loadGitCommits(gitPath) {
  if (!gitPath) return [];
  if (!existsSync(gitPath)) {
    throw new CollectorError(`--git path does not exist: ${gitPath}`);
  }
  let raw;
  try {
    raw = execFileSync('git', ['log', '--all', '--format=%H|%cI'], {
      cwd: gitPath,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    throw new CollectorError(
      `cannot read git history from ${gitPath}: ${err.message}`,
    );
  }
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, iso] = line.split('|');
      return { hash, iso, ms: Date.parse(iso) };
    })
    .filter((c) => !Number.isNaN(c.ms))
    .sort((a, b) => b.ms - a.ms);
}

// The commit that was most likely built, and how sure we are.
//
// The rule is: the build used the state of the repository as of the build
// time, so the commit it used is the last commit *before* the build. That
// candidate is always unique -- except when two commits carry the same
// timestamp, which is a real ambiguity and gets reported as one.
//
// What separates a solid answer from a guess is not the presence of a
// candidate but the *distance* to it: a build that starts minutes after a
// commit is that commit; a build that starts in a quiet stretch is whatever
// was lying around, and the entry has to say so.
//
// A build older than every commit in the repository gets no commit at all:
// associating it with a *later* commit would be exactly the confident wrong
// answer this whole exercise is trying to avoid.
export function associateCommit(builtAtMs, commits, nearHours) {
  if (commits.length === 0) {
    return {
      commit: null,
      commit_source: 'null',
      candidates: [],
      reason: 'no git history',
    };
  }

  const before = commits.filter((c) => c.ms <= builtAtMs);
  if (before.length === 0) {
    return {
      commit: null,
      commit_source: 'null',
      candidates: [],
      reason: 'the build predates every commit in the repository',
    };
  }
  const nearest = before[0];
  const tied = before.filter((c) => c.ms === nearest.ms).map((c) => c.hash);
  if (tied.length > 1) {
    return {
      commit: null,
      commit_source: 'ambiguous',
      candidates: tied,
      reason: `${tied.length} commits share the timestamp closest to the build`,
    };
  }

  const hours = (builtAtMs - nearest.ms) / 3600000;
  if (hours <= nearHours) {
    return {
      commit: nearest.hash,
      commit_source: 'git-window',
      candidates: [nearest.hash],
      reason: `the last commit before the build is ${hours.toFixed(1)}h earlier`,
    };
  }
  return {
    commit: nearest.hash,
    commit_source: 'git-head-fallback',
    candidates: [nearest.hash],
    reason: `the last commit before the build is ${hours.toFixed(1)}h earlier -- a quiet stretch, so this is a fallback`,
  };
}
