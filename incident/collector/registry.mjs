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

/**
 * 这个克隆**最后一次从远端得到新东西**是什么时候。
 *
 * 读的是远端跟踪分支的 reflog（`refs/remotes/<remote>/*`）——每次 fetch 或
 * push 都会在那里留一条。所以它的最后一条时间戳就是「这个克隆的知识截止
 * 时间」：在那之后远端再有提交，这个克隆就看不见了。
 *
 * 这个信号的好处是**纯本地、不联网**：远端服务器挂了、内网断了、认证过期
 * 都照样能算。而 `git ls-remote` 那种「现在远端领先多少」的检查，一旦网络
 * 不通就整个失效——实测就是这个形状：远端不可达时，陈旧克隆的问题一个都
 * 查不出来。
 */
export function lastRemoteUpdateMs(gitPath, remoteName) {
  if (!gitPath || !remoteName) return null;
  let raw;
  try {
    raw = execFileSync(
      'git',
      ['reflog', 'show', '--all', '--date=unix', '--format=%gd'],
      { cwd: gitPath, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
  } catch {
    return null;
  }
  let newest = null;
  // 远端跟踪分支在 reflog 里长这样：`origin/develop-v2@{1758271800}`；
  // 远端的 HEAD（一个符号引用）长这样：`origin@{1758271800}`。
  const pattern = new RegExp(
    `^${remoteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:/[^@]*)?@\\{(\\d+)\\}$`,
  );
  for (const line of raw.split('\n')) {
    const m = line.trim().match(pattern);
    if (!m) continue;
    const ms = Number(m[1]) * 1000;
    if (Number.isFinite(ms) && (newest === null || ms > newest)) newest = ms;
  }
  return newest;
}

/**
 * 这个本地克隆的历史，覆盖到什么时候？
 *
 * 为什么要有这个判断：`associateCommit` 的规则是「构建时刻之前最后一个提交
 * 就是被构建的那个提交」。这条规则有个前提——**克隆里的历史是完整的**。
 * 克隆陈旧了（fetch 过一次就没再动）这个前提就不成立：本地最后一个提交可能
 * 落在构建之前很久，而真正被构建的那个提交根本不在本地。
 *
 * 陈旧克隆最典型的症状是：所有比它新的构建都被推断成**同一个 HEAD**——
 * 那不叫推断，是拿一个已知过期的答案当答案。实测踩过：clone 停在某个提交上
 * 不动了，之后几轮采集的 commit 全是那一个 HEAD，commit 字段看着有值，
 * 其实什么都没说。
 *
 * 这里只做**有证据的**判断，查不到证据就说「不知道」，绝不猜：
 *   - 浅克隆（`git rev-parse --is-shallow-repository` 为 true）：历史被截断。
 *   - 远端 HEAD 不在本地历史里：本地克隆落后于远端，历史只是一个前缀。
 *   - 构建发生在**这个克隆最后一次从远端取东西之后**：那一刻起克隆就
 *     不再知道远端有什么了，构建用的提交很可能根本不在本地。
 *
 * 查不到远端（没配 remote、网络不通、认证失败）→ 那一项说「不知道」，但
 * 上面第三条（最后一次取东西的时间）**是纯本地的**，照样算数。
 */
export function gitHistoryCoverage(
  gitPath,
  commits,
  { builtAtMs = null } = {},
) {
  if (!gitPath) {
    return {
      state: 'no-repo',
      truncated: false,
      reason: 'no git repository was given',
    };
  }

  try {
    const shallow = execFileSync(
      'git',
      ['rev-parse', '--is-shallow-repository'],
      { cwd: gitPath, encoding: 'utf8' },
    ).trim();
    if (shallow === 'true') {
      return {
        state: 'shallow',
        truncated: true,
        reason: 'the local clone is shallow: its history was cut off',
      };
    }
  } catch {
    /* 查不到就当不知道，不猜 */
  }

  let remote = null;
  try {
    const remotes = execFileSync('git', ['remote'], {
      cwd: gitPath,
      encoding: 'utf8',
    })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    remote = remotes.includes('origin') ? 'origin' : (remotes[0] ?? null);
  } catch {
    remote = null;
  }

  // 「这个克隆最后一次从远端取东西是什么时候」——纯本地，不联网。
  //
  // 构建发生在这一刻**之后**，就意味着构建用的提交很可能根本不在本地：
  // 克隆从那一刻起就再也不知道远端有什么了。这一条比「远端现在领先多少」
  // 更可靠，因为它在远端不可达时照样成立。
  const lastUpdateMs = lastRemoteUpdateMs(gitPath, remote);
  if (builtAtMs !== null && lastUpdateMs !== null && builtAtMs > lastUpdateMs) {
    return {
      state: 'stale-at-build-time',
      truncated: true,
      last_remote_update: new Date(lastUpdateMs).toISOString(),
      reason:
        `the local clone stopped learning about the remote at ${new Date(lastUpdateMs).toISOString()}, ` +
        `which is before the build; commits made since then are not in the local history`,
    };
  }

  if (!remote) {
    return {
      state: 'no-remote',
      truncated: false,
      reason: 'the local clone has no remote to compare against',
    };
  }

  let remoteHead = null;
  try {
    const out = execFileSync('git', ['ls-remote', remote, 'HEAD'], {
      cwd: gitPath,
      encoding: 'utf8',
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    remoteHead = (out.split('\n')[0] ?? '').split(/\s+/)[0] ?? null;
  } catch {
    return {
      state: 'remote-unreachable',
      truncated: false,
      reason: `the remote ${remote} could not be reached, so the local clone cannot be checked`,
    };
  }
  if (!remoteHead) {
    return {
      state: 'unknown',
      truncated: false,
      reason: 'the remote reported no HEAD',
    };
  }

  const local = new Set((commits ?? []).map((c) => c.hash));
  if (local.has(remoteHead)) {
    return {
      state: 'up-to-date',
      truncated: false,
      last_remote_update:
        lastUpdateMs === null ? null : new Date(lastUpdateMs).toISOString(),
      reason: 'the remote HEAD is present in the local history',
    };
  }
  return {
    state: 'behind-remote',
    truncated: true,
    last_remote_update:
      lastUpdateMs === null ? null : new Date(lastUpdateMs).toISOString(),
    reason: `the local clone is behind ${remote}: the remote HEAD is not in the local history`,
  };
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
export function associateCommit(
  builtAtMs,
  commits,
  nearHours,
  coverage = null,
) {
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

  // 历史可能被截断时的降级。
  //
  // 「构建之前最后一个提交就是被构建的那个提交」这条规则，成立的前提是
  // 本地历史在构建时刻之前是**连续**的。克隆落后于远端时这个前提不成立：
  // 本地最新提交落在构建之前，就说明本地根本不知道中间有没有别的提交——
  // 真正被构建的那个提交很可能根本不在本地。
  //
  // 所以这种时候不能报 `git-window`（那等于说「就是它」）：降级成
  // `git-head-fallback`，把理由写清楚。commit 字段还留着——它是本地手上
  // 最好的线索，但读者必须知道它可能比真正构建的那个更老。
  const tip = commits[0];
  const mayMissCommits =
    coverage?.truncated === true && Boolean(tip) && tip.ms <= builtAtMs;
  if (mayMissCommits) {
    return {
      commit: nearest.hash,
      commit_source: 'git-head-fallback',
      candidates: [nearest.hash],
      reason:
        `the local clone may be missing commits between the build and ${nearest.hash.slice(0, 12)} ` +
        `(${coverage.reason}); this is the newest commit the local clone has, not necessarily the one that was built`,
    };
  }

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
