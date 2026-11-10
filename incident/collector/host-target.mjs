// Host-process targets: the artifact is the identity.
//
// The ledger's key is the digest of what is deployed. For a container that is
// the image digest; for a host process (`java -jar`) there is no image, so the
// identity is the **artifact's own sha256**. Both are written as `sha256:...`,
// which means the read side needs no second lookup path -- one query, one key.
//
// A deployment unit can be more than one file. The real target's CI image
// runs a thin jar against a `lib/` directory, so the unit is the pair and the
// key is a **tree hash** over the whole unit (`--artifact-dir`). Keying on
// `app.jar` alone would call two deployments with different dependencies the
// same artifact.
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
  readdirSync,
  readlinkSync,
  readSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

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

// A deployment unit is not always a single file.
//
// The real target's CI image runs a **thin** jar against a `lib/` directory:
// `java -Dloader.path=lib -jar app.jar`. The running code is that pair. A key
// computed over `app.jar` alone would call two deployments that differ only in
// their dependency set the same artifact -- the same false equality the whole
// ledger exists to avoid, one level down.
//
// So a directory deployment unit gets a **tree hash**: every regular file
// under it, addressed by its path relative to the unit, in sorted order. Two
// properties matter:
//
//   - **Content-addressed and path-independent.** The root directory is not
//     part of the hash, so the same unit unpacked somewhere else keeps its
//     key. The artifact is what is deployed; where it was unpacked is not.
//   - **Path-sensitive inside the unit.** A file that moves inside the unit
//     changes the key, because `java -Dloader.path` resolves relative to the
//     unit root.
export function listTreeFiles(dirPath) {
  const out = [];
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (err) {
      throw new HostTargetError(
        `读不到部署单元目录 ${current}：${err.message}`,
      );
    }
    for (const entry of entries) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      // Symlinks and anything that is not a regular file are not part of the
      // running code, and following them could walk out of the unit.
      if (!entry.isFile()) continue;
      const st = statSync(abs);
      out.push({
        rel: relative(dirPath, abs),
        abs,
        size: st.size,
        mtimeMs: st.mtimeMs,
      });
    }
  };
  walk(dirPath);
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

export function treeSha256(dirPath) {
  const files = listTreeFiles(dirPath);
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.rel);
    hash.update('\0');
    hash.update(fileSha256(file.abs));
    hash.update('\0');
    hash.update(String(file.size));
    hash.update('\n');
  }
  return hash.digest('hex');
}

// The identity of a directory deployment unit. `built_at` is the newest
// file mtime in the unit: for an unpacked image layer that is the build
// time the artifact itself carries, not a clock we read now.
export function treeIdentity(dirPath) {
  const files = listTreeFiles(dirPath);
  if (files.length === 0) {
    throw new HostTargetError(
      `部署单元目录 ${dirPath} 是空的，没有可部署的内容。`,
    );
  }
  const size = files.reduce((sum, f) => sum + f.size, 0);
  const mtimeMs = files.reduce((max, f) => Math.max(max, f.mtimeMs), 0);
  return {
    digest: `sha256:${treeSha256(dirPath)}`,
    built_at: new Date(mtimeMs).toISOString(),
    artifact_path: dirPath,
    artifact_size: size,
  };
}

// The access mode of an open file descriptor: O_RDONLY / O_WRONLY / O_RDWR.
// /proc/<pid>/fdinfo/<fd> reports the flags in octal, and the low two bits
// are the access mode.
const O_ACCMODE = 3;
const O_RDONLY = 0;

export function fdOpenFlags(pid, fd) {
  try {
    const text = readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8');
    const m = /^flags:\s*(\d+)/m.exec(text);
    if (!m) return null;
    const value = Number.parseInt(m[1], 8);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function isInside(dir, target) {
  const rel = relative(dir, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * 部署单元里被这个进程**以写方式**打开的文件。
 *
 * 为什么这件事要拦：部署单元的主键是整个单元的 tree hash。运行中的进程往
 * 单元里写东西（日志、临时文件），主键就随写入漂移——同一份部署前后算出
 * 两个不同的 digest，而台账读侧是按 digest 反查的，于是它会「查不到自己
 * 刚写的这一行」。
 *
 * 真实靶子踩的就是这个：应用的 logback 配置写 `./logs`（相对工作目录），
 * 从单元目录里启动，进程就把日志写进了自己要作为身份的那个目录里。
 */
export function unitWriteHandles(pid, unitDir) {
  const fdDir = `/proc/${pid}/fd`;
  let entries;
  try {
    entries = readdirSync(fdDir);
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    let target;
    try {
      target = readlinkSync(join(fdDir, entry));
    } catch {
      continue;
    }
    if (typeof target !== 'string') continue;
    if (target.includes('(deleted)')) continue;
    if (!isInside(unitDir, target)) continue;
    const flags = fdOpenFlags(pid, entry);
    if (flags === null) continue;
    if ((flags & O_ACCMODE) === O_RDONLY) continue;
    out.push(target);
  }
  return [...new Set(out)].sort();
}

/**
 * 部署单元里比进程启动时刻还新的文件。
 *
 * 上面那个检查抓的是「正在写」，这个抓的是「已经写过、句柄已关」——
 * 比如上一次从单元目录里启动时留下的日志。它们同样不属于产物，却会被
 * tree hash 算进主键。
 *
 * 时间比较带一个容差，因为进程启动时刻本身不是精确值：/proc/stat 里的
 * btime 只到秒（截断），算出来的启动时刻因此可能比真实值早将近一秒。
 * 不带这个容差，边界上的正常产物文件会被误判成运行期残留——那就会把
 * 一份干净的部署单元说成不可用。代价是：进程启动后不到两秒内写下的文件
 * 可能漏过去。这个漏检写在这里，不藏。
 */
export const START_TIME_UNCERTAINTY_MS = 2000;

export function unitFilesNewerThan(
  pid,
  unitDir,
  startMs,
  toleranceMs = START_TIME_UNCERTAINTY_MS,
) {
  if (!Number.isFinite(startMs)) return [];
  const out = [];
  for (const file of listTreeFiles(unitDir)) {
    if (file.mtimeMs > startMs + toleranceMs) out.push(file.rel);
  }
  return out.sort();
}

/**
 * 部署单元必须是**不可变**的：它是主键。
 *
 * 两件事会让它可变：运行中的进程正在往里写，或者上一次运行往里留了东西。
 * 两种情况都拒绝，并且把「为什么拒绝」和「怎么改」一起说出来——一个会
 * 漂移的主键比没有主键更糟，因为它看起来能用。
 */
export function assertUnitImmutable(unitDir, pid, startMs = null) {
  if (!Number.isFinite(pid) || pid <= 0) return;
  const writers = unitWriteHandles(pid, unitDir);
  if (writers.length) {
    throw new HostTargetError(
      `部署单元里有正在被进程 ${pid} 写入的文件：\n` +
        writers.map((w) => `  ${w}`).join('\n') +
        `\n主键是整个部署单元的 tree hash。运行中的进程往单元里写东西，主键就会随写入漂移：\n` +
        `同一份部署会算出不同的 digest，读侧按 digest 反查就会查不到自己刚写的这一行。\n` +
        `改法：把工作目录放到部署单元之外（日志写到别处），或者换一个没有被写入的部署单元。`,
    );
  }
  const fresh = unitFilesNewerThan(pid, unitDir, startMs);
  if (fresh.length) {
    throw new HostTargetError(
      `部署单元里有比进程启动时刻还新的文件（${fresh.length} 个）：\n` +
        fresh
          .slice(0, 10)
          .map((f) => `  ${f}`)
          .join('\n') +
        (fresh.length > 10 ? `\n  …还有 ${fresh.length - 10} 个` : '') +
        `\n这些是上一次运行留在单元里的运行期产物（多半是日志），不属于产物本身，\n` +
        `但会被 tree hash 算进主键。改法：把它们挪出单元，或换一个干净的部署单元。`,
    );
  }
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
  artifactDir = null,
  pid = null,
  commit = null,
  commitSource = null,
  nowMs = Date.now(),
  hz = null,
  bootTimeMs = null,
} = {}) {
  if (artifactPath && artifactDir) {
    throw new HostTargetError(
      '产物路径与部署单元目录只能给一个：前者是一个产物文件，后者是一个部署单元目录。',
    );
  }
  if (!artifactPath && !artifactDir) {
    throw new HostTargetError('必须给出产物路径或部署单元目录。');
  }
  // Liveness and start time are two different questions. The process may be
  // alive while its start time cannot be reconstructed (an unreadable
  // /proc/<pid>/stat, a container PID namespace, a clock rate we cannot
  // read), and the start time may be known while the process is gone.
  const statText = pid === null ? null : readProcStat(pid);
  const alive = statText !== null;
  const startedMs = alive
    ? processStartMs(pid, { nowMs, hz, bootTimeMs })
    : null;

  let identity;
  let evidence;
  if (artifactDir) {
    if (!existsSync(artifactDir)) {
      throw new HostTargetError(`部署单元目录不存在：${artifactDir}`);
    }
    // 单元必须不可变才能当主键，所以这一步排在算 tree hash **之前**：
    // 算出来的 digest 会被写进台账，写完才发现它会漂移就晚了。
    assertUnitImmutable(artifactDir, alive ? pid : null, startedMs);
    identity = treeIdentity(artifactDir);
    evidence = 'host-artifact-tree-sha256';
  } else {
    if (!existsSync(artifactPath)) {
      throw new HostTargetError(`产物文件不存在：${artifactPath}`);
    }
    const sha256 = fileSha256(artifactPath);
    const stat = artifactStat(artifactPath);
    identity = artifactIdentity({
      sha256,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      path: artifactPath,
    });
    evidence = 'host-artifact-sha256';
  }
  const hasCommit = typeof commit === 'string' && commit.length > 0;
  const observedAt = new Date(nowMs).toISOString();
  const observation = {
    digest: identity.digest,
    built_at: identity.built_at,
    image_ref: identity.artifact_path,
    artifact_path: identity.artifact_path,
    artifact_size: identity.artifact_size,
    artifact_kind: artifactDir ? 'deployment-unit-dir' : 'file',
    pod_started_at:
      startedMs === null ? null : new Date(startedMs).toISOString(),
    commit: hasCommit ? commit : null,
    commit_source: hasCommit ? (commitSource ?? 'manual') : 'null',
    observed_at: observedAt,
    evidence,
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
      observation.evidence ?? 'host-artifact-sha256',
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
    artifactDir: null,
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
      case '--artifact-dir':
        opts.artifactDir = next();
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
  if (opts.artifact && opts.artifactDir) {
    throw new HostTargetError(
      '--artifact 与 --artifact-dir 只能给一个：前者是一个产物文件，后者是一个部署单元目录。',
    );
  }
  if (!opts.artifact && !opts.artifactDir) {
    throw new HostTargetError('必须给出 --artifact 或 --artifact-dir。');
  }
  return opts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const observation = hostObservation({
      artifactPath: opts.artifact,
      artifactDir: opts.artifactDir,
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
