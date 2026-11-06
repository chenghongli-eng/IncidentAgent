// Host-process targets: the artifact is the identity.
//
// The ledger's key is the digest of what is deployed. For a container that is
// the image digest; for a host process (`java -jar`) there is no image, so the
// identity is the **artifact's own sha256**. Both are written as `sha256:...`,
// which means the read side needs no second lookup path -- one query, one key.
//
// Two rules this module exists to enforce:
//
//  1. **The identity is the artifact, not the process.** A restarted process
//     gets a new pid but the same artifact, and a rebuilt artifact gets a new
//     sha but may keep the same path. Keying on the pid would make every
//     restart look like a new deployment; keying on the path would make every
//     rebuild look like the same one.
//  2. **Nothing here is guessed.** No process start time means `null`, not
//     "now" and not the file mtime. A ledger that invents a start time
//     answers "how long has this been running" with a number nobody measured.
//
// This module does not touch the network and holds no credentials.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readFileSync,
  statSync,
} from 'node:fs';

import { writeEntries } from './ledger.mjs';

export class HostTargetError extends Error {}

// A sha256 of an empty file is a perfectly good hash, but an empty artifact is
// not a deployable thing: it means the path is wrong or the build failed and
// left nothing behind. Both would otherwise become a ledger row about a
// "deployment" that never ran.
const MIN_ARTIFACT_BYTES = 1;

// Real artifacts are large -- a service jar is easily a few hundred megabytes
// -- so the file is hashed in chunks instead of being read into memory whole.
const HASH_CHUNK_BYTES = 1024 * 1024;

export function fileSha256(path) {
  const hash = createHash('sha256');
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch (err) {
    throw new HostTargetError(`读不到产物文件 ${path}：${err.message}`);
  }
  try {
    const buf = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let read = 0;
    do {
      read = readSync(fd, buf, 0, buf.length, null);
      if (read > 0) hash.update(buf.subarray(0, read));
    } while (read > 0);
  } catch (err) {
    throw new HostTargetError(`读不到产物文件 ${path}：${err.message}`);
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

export function artifactStat(path) {
  let st;
  try {
    st = statSync(path);
  } catch (err) {
    throw new HostTargetError(`读不到产物文件 ${path}：${err.message}`);
  }
  if (st.isDirectory()) {
    throw new HostTargetError(`产物路径 ${path} 是目录，不是产物文件。`);
  }
  if (!st.isFile()) {
    throw new HostTargetError(`产物路径 ${path} 不是普通文件。`);
  }
  if (st.size < MIN_ARTIFACT_BYTES) {
    throw new HostTargetError(`产物文件 ${path} 是空的，没有可部署的内容。`);
  }
  return { size: st.size, mtimeMs: st.mtimeMs };
}

// The ledger row fields a host target contributes. Kept pure so the control
// script can test the semantics without a real process.
export function artifactIdentity({ sha256, size, mtimeMs, path }) {
  return {
    digest: `sha256:${sha256}`,
    built_at: new Date(mtimeMs).toISOString(),
    artifact_path: path,
    artifact_size: size,
  };
}

// Field 22 of /proc/<pid>/stat is the process start time in clock ticks since
// boot. The stat line has the executable name in parentheses and it may
// contain spaces, so the fields after it are split from the last ')'.
export function parseProcStatStarttime(statText) {
  if (!statText) return null;
  const close = statText.lastIndexOf(')');
  if (close === -1) return null;
  const fields = statText
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  // After the comm field, index 19 is field 22 overall.
  const raw = fields[19];
  if (!raw) return null;
  const ticks = Number(raw);
  return Number.isFinite(ticks) ? ticks : null;
}

export function parseBtimeSeconds(statText) {
  if (!statText) return null;
  const m = /^btime\s+(\d+)/m.exec(statText);
  if (!m) return null;
  const secs = Number(m[1]);
  return Number.isFinite(secs) ? secs : null;
}

// CLK_TCK is almost always 100, but "almost" is not a number to build a
// timestamp on: it comes from the running system, and if it cannot be read we
// do not convert the tick count into a time at all.
export function clockTicksPerSecond() {
  try {
    const out = execFileSync('getconf', ['CLK_TCK'], {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    const n = Number(out);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function readBootTimeMs() {
  try {
    const secs = parseBtimeSeconds(readFileSync('/proc/stat', 'utf8'));
    return secs === null ? null : secs * 1000;
  } catch {
    return null;
  }
}

export function readProcStat(pid) {
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
}

// The start time of a process, or null when it cannot be established.
// Three things can go wrong and all three mean the same thing: "we do not
// know when it started" -- the process is gone, /proc is unavailable, or the
// clock tick rate could not be read.
export function processStartMs(
  pid,
  { nowMs = Date.now(), bootTimeMs = null, hz = null } = {},
) {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const statText = readProcStat(pid);
  if (!statText) return null;
  const ticks = parseProcStatStarttime(statText);
  if (ticks === null) return null;
  const rate = hz ?? clockTicksPerSecond();
  if (!rate) return null;
  const boot = bootTimeMs ?? readBootTimeMs();
  if (boot === null) return null;
  const ms = boot + (ticks / rate) * 1000;
  if (!Number.isFinite(ms) || ms > nowMs + 1000) return null;
  return ms;
}

// The whole observation, assembled. `commit` is only carried when the caller
// supplies it together with its source: a host target has no CI record to
// read, so an unsourced commit would be a claim wearing a fact's clothes.
export function hostObservation({
  artifactPath,
  pid = null,
  commit = null,
  commitSource = null,
  nowMs = Date.now(),
  hz = null,
  bootTimeMs = null,
} = {}) {
  if (!artifactPath) {
    throw new HostTargetError('必须给出产物路径。');
  }
  if (!existsSync(artifactPath)) {
    throw new HostTargetError(`产物文件不存在：${artifactPath}`);
  }
  const sha256 = fileSha256(artifactPath);
  const stat = artifactStat(artifactPath);
  const identity = artifactIdentity({
    sha256,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    path: artifactPath,
  });
  // Liveness and start time are two different questions. The process may be
  // alive while its start time cannot be reconstructed (an unreadable
  // /proc/<pid>/stat, a container PID namespace, a clock rate we cannot
  // read), and the start time may be known while the process is gone.
  const statText = pid === null ? null : readProcStat(pid);
  const alive = statText !== null;
  const startedMs = alive
    ? processStartMs(pid, { nowMs, hz, bootTimeMs })
    : null;
  const hasCommit = typeof commit === 'string' && commit.length > 0;
  const observedAt = new Date(nowMs).toISOString();
  const observation = {
    digest: identity.digest,
    built_at: identity.built_at,
    image_ref: artifactPath,
    artifact_path: identity.artifact_path,
    artifact_size: identity.artifact_size,
    pod_started_at:
      startedMs === null ? null : new Date(startedMs).toISOString(),
    commit: hasCommit ? commit : null,
    commit_source: hasCommit ? (commitSource ?? 'manual') : 'null',
    observed_at: observedAt,
  };
  // Only a process we can see gets a running observation. A dead pid is not
  // a running service, and a pid we were never given is not an observation.
  if (alive) {
    observation.running_observed_at = observedAt;
    observation.running_source = 'host';
  }
  return observation;
}

/**
 * 把宿主形态的观测转成台账的一行。
 *
 * 字段名和台账的其余段一致（cluster / namespace / workload / digest / …），
 * 所以读侧不需要为宿主形态开第二条路径：主键是 `digest`，形态上与镜像 digest
 * 同形（sha256:<64 hex>），查法完全一样。
 */
export function toLedgerEntry(observation, opts = {}) {
  return {
    cluster: opts.cluster ?? null,
    namespace: opts.namespace ?? null,
    workload: opts.workload ?? null,
    pod_name: opts.pod_name ?? null,
    node: null,
    image_ref: observation.image_ref,
    digest: observation.digest,
    built_at: observation.built_at ?? null,
    commit: observation.commit ?? null,
    commit_source: observation.commit_source ?? null,
    deployed_at: observation.pod_started_at ?? null,
    deployed_by: opts.deployedBy ?? 'host',
    pod_started_at: observation.pod_started_at ?? null,
    running_observed_at: observation.running_observed_at ?? null,
    running_source: observation.running_source ?? null,
    collected_at: observation.observed_at ?? null,
    evidence: [
      'host-artifact-sha256',
      ...(observation.pod_started_at ? ['proc-start-time'] : []),
    ],
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    artifact: null,
    pid: null,
    commit: null,
    commitSource: null,
    ledger: null,
    cluster: null,
    namespace: null,
    workload: null,
    deployedBy: 'host',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new HostTargetError(`选项 ${a} 需要一个值。`);
      i += 1;
      return v;
    };
    switch (a) {
      case '--artifact':
        opts.artifact = next();
        break;
      case '--pid':
        opts.pid = Number(next());
        break;
      case '--commit':
        opts.commit = next();
        break;
      case '--commit-source':
        opts.commitSource = next();
        break;
      case '--ledger':
        opts.ledger = next();
        break;
      case '--cluster':
        opts.cluster = next();
        break;
      case '--namespace':
        opts.namespace = next();
        break;
      case '--workload':
        opts.workload = next();
        break;
      case '--deployed-by':
        opts.deployedBy = next();
        break;
      default:
        throw new HostTargetError(`未知选项：${a}`);
    }
  }
  if (!opts.artifact) throw new HostTargetError('必须给出 --artifact。');
  return opts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const observation = hostObservation({
      artifactPath: opts.artifact,
      pid: Number.isFinite(opts.pid) ? opts.pid : null,
      commit: opts.commit,
      commitSource: opts.commitSource,
    });
    let write = null;
    if (opts.ledger) {
      const entry = toLedgerEntry(observation, opts);
      const result = writeEntries(opts.ledger, [entry]);
      write = {
        ledger: opts.ledger,
        appended: result.appended.length,
        skipped: result.skipped.length,
        conflicts: result.conflicts,
        superseded: result.superseded,
      };
    }
    // 观测的字段摊在顶层（digest / pod_started_at / …），
    // 写台账的结果另挂一个 key：CLI 的输出形状不变。
    process.stdout.write(
      `${JSON.stringify({ ...observation, ledger_write: write }, null, 2)}\n`,
    );
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
