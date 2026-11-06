// CI client: read a build record.
//
// This is the segment that turns "image tag 651" into "the commit this build
// checked out", which is a *fact about the build* rather than an inference
// from timestamps. It matters because the timestamp inference was measured to
// be wrong on the real project, and a wrong commit that reads like a fact is
// worse than no commit at all.
//
// Credentials never come from argv (argv shows up in shell history and in the
// process list). They come from a file outside the repository, or from the
// environment.

import { readFileSync } from 'node:fs';

export class CollectorError extends Error {}

// Read a KEY=VALUE credentials file. Values may be quoted.
export function readCredentialsFile(path) {
  const out = {};
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new CollectorError(
      `cannot read credentials file ${path}: ${err.message}`,
    );
  }
  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;
    const eq = text.indexOf('=');
    if (eq === -1) continue;
    const key = text.slice(0, eq).trim();
    let value = text.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function resolveCredentials({
  file = null,
  env = process.env,
  prefix = '',
  required = [],
} = {}) {
  const raw = {};
  if (file) Object.assign(raw, readCredentialsFile(file));
  const creds = {};
  for (const key of ['USER', 'TOKEN', 'JOB', 'CLUSTER', 'NAMESPACE', 'CA']) {
    // A prefixed name wins over the bare one, so a file can hold the
    // credentials of several systems side by side.
    const names = prefix ? [`${prefix}_${key}`, key] : [key];
    for (const name of names) {
      if (raw[name] !== undefined) {
        creds[key] = raw[name];
        break;
      }
      if (env[name] !== undefined) {
        creds[key] = env[name];
        break;
      }
    }
  }
  const missing = required.filter((k) => !creds[k]);
  if (missing.length > 0) {
    throw new CollectorError(
      `missing credentials: ${missing.join(', ')} (provide a credentials file or environment variables)`,
    );
  }
  return creds;
}

function basicAuth(user, token) {
  return `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;
}

export function createJenkinsClient({ url, user, token, job }) {
  const base = String(url).replace(/\/$/, '');
  // A job name may contain slashes; each one is a path segment in Jenkins'
  // URL scheme.
  const jobPath = String(job)
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/job/');

  async function getJson(path) {
    let res;
    try {
      res = await fetch(`${base}${path}`, {
        headers: {
          authorization: basicAuth(user, token),
          accept: 'application/json',
        },
      });
    } catch (err) {
      throw new CollectorError(
        `CI server unreachable at ${base}: ${err.message}`,
      );
    }
    if (res.status === 404) {
      throw new CollectorError(`CI has no such build: ${path}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new CollectorError(`CI rejected the credentials (${res.status})`);
    }
    if (!res.ok) {
      throw new CollectorError(`CI returned ${res.status} for ${path}`);
    }
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new CollectorError(
        `CI returned invalid JSON for ${path}: ${err.message}`,
      );
    }
  }

  return {
    async build(number) {
      const tree = [
        'number',
        'result',
        'timestamp',
        'actions[lastBuiltRevision[SHA1,branch[name]]]',
      ].join(',');
      const body = await getJson(
        `/job/${jobPath}/${number}/api/json?tree=${encodeURIComponent(tree)}`,
      );
      let sha1 = null;
      let branch = null;
      for (const action of body.actions ?? []) {
        const rev = action?.lastBuiltRevision;
        if (!rev?.SHA1) continue;
        sha1 = rev.SHA1;
        branch = rev.branch?.[0]?.name ?? null;
        break;
      }
      const timestamp = body.timestamp ?? null;
      return {
        number: body.number ?? number,
        result: body.result ?? null,
        started_at: timestamp ? new Date(timestamp).toISOString() : null,
        sha1,
        branch,
      };
    },
  };
}
