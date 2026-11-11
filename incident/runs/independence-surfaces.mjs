#!/usr/bin/env node
/**
 * 证据面的度量：日志面与源码面。
 *
 * 为什么单独一个模块：这些度量有两个用户——
 *   · `independence-audit.mjs`：给轮次盖章（独立 / 污染 / 未知）；
 *   · `run-round.mjs`：在**开跑之前**用它当闸门——源码面不干净就不跑这一轮。
 * 两边必须用**同一把尺子**，否则闸门通过而审计判污染，谁也说不清是谁错了。
 *
 * 这个模块不含任何故障机制的字眼：痕迹行靠「时间戳 + 关键词」认，
 * 源码面靠「原始仓库里有没有这个提交」认，答案签名靠**本轮自己的**注入提交
 * 当尺子。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * 故障痕迹行：<时间戳> … DiskSpaceHealthIndicator … Free disk space below threshold …
 *
 * 同一个应用有两种日志格式（文件日志 / 控制台日志），只锚「行首时间戳」和
 * 「两个关键词」，中间的格式差异不管。
 */
export const TRACE_RE =
  /^(?<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+).*DiskSpaceHealthIndicator.*Free disk space below threshold/;

/** 靶子日志用的时区偏移（靶子的启动脚本里导出 TZ=Asia/Shanghai）。 */
export const LOG_TZ_OFFSET_MINUTES = 8 * 60;

/** 日志里的本地时间戳 → UTC 毫秒 */
export function localStampToUtc(line) {
  const m = TRACE_RE.exec(line);
  if (!m) return null;
  const naive = Date.parse(m.groups.ts.replace(' ', 'T') + 'Z');
  if (Number.isNaN(naive)) return null;
  return naive - LOG_TZ_OFFSET_MINUTES * 60_000;
}

/** 递归列出目录下所有 .log 文件（归档目录是嵌套的：<stamp>/logs/*.log）。 */
export function listLogFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listLogFiles(p));
    else if (entry.name.endsWith('.log')) out.push(p);
  }
  return out;
}

/**
 * 数日志面里的痕迹行。按时间戳去重：控制台日志与应用文件日志是同一批行的
 * 两种格式，同一行会被算两遍——那是重复计数，不是两条证据。
 */
export function countTraces(dir, beforeUtc) {
  if (!existsSync(dir)) {
    return { total: 0, stale: 0, firstStamp: null, dir, log_files: 0 };
  }
  const files = listLogFiles(dir);
  const stamps = new Set();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      const ts = localStampToUtc(line);
      if (ts === null) continue;
      stamps.add(ts);
    }
  }
  const sorted = [...stamps].sort((a, b) => a - b);
  const stale =
    beforeUtc === null ? 0 : sorted.filter((t) => t < beforeUtc).length;
  return {
    total: sorted.length,
    stale,
    firstStamp: sorted.length ? new Date(sorted[0]).toISOString() : null,
    dir,
    log_files: files.length,
  };
}

// ── 源码面（git）──────────────────────────────────────────────────────────

export function git(repo, argv) {
  return execFileSync('git', ['-C', repo, ...argv], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * 一个提交的「签名」：它增删了哪些行（注释行不算）。
 *
 * 为什么注释行不算：注入时会写一行 `# build <轮次戳>`，那是给每一轮的
 * 字节留个指纹用的，带上它就分不出「同一处注入」和「两处不同的注入」。
 * 把注释去掉之后，两轮注入的签名就一样——于是**上一轮的注入**能被认出来。
 */
export function commitSignature(repo, sha) {
  let out = '';
  try {
    out = git(repo, ['show', '--format=', '--unified=0', sha]);
  } catch {
    return null;
  }
  const lines = [];
  for (const line of out.split('\n')) {
    if (!/^[+-]/.test(line)) continue;
    if (/^\+\+\+|^---/.test(line)) continue;
    if (/^[+-]\s*#/.test(line)) continue;
    lines.push(line);
  }
  return lines.sort().join('\n');
}

/** 对象库里所有提交对象（含悬空的、reflog 指着的）。 */
export function allCommitObjects(repo) {
  let out = '';
  try {
    out = git(repo, [
      'cat-file',
      '--batch-all-objects',
      '--batch-check=%(objectname) %(objecttype)',
    ]);
  } catch {
    return [];
  }
  return out
    .split('\n')
    .filter((l) => l.endsWith(' commit'))
    .map((l) => l.split(' ')[0]);
}

/**
 * 源码面上的外来提交。
 *
 * 判据（全部是**相对**本轮自己的，不含任何故障机制的字眼）：
 *   · 提交时间早于本轮注入时刻（它这一轮还没存在）；
 *   · **原始仓库里没有这个提交**（不是项目本来就有的东西，是实验留下的）；
 *   · 不是本轮自己的注入提交（那是本轮的答案，不算外来）；
 *   · 其中「带着答案的」：增删行签名与本轮注入提交一致。
 *
 * 为什么拿**原始仓库**当尺子，而不是「ref 能不能到」：这份快照是整个项目
 * 克隆下来的，里面本来就有些 ref 到不了的提交（项目自己在别处 stash 过的
 * 临时提交就是这种），它们在实验开始前就存在，不是实验留下的。按 ref 判，
 * 这些会被当成「实验留下的提交」——一个假阳性会把整批轮次判成污染。
 * 原始仓库是「项目本来是什么样」的唯一真相源：它有的，就是项目自带的；
 * 它没有的，就是实验在这份快照上留下的。
 */
export function measureSourceSurface(repo, { head, injectedAt, pristineRepo }) {
  if (!repo || !existsSync(repo)) {
    return {
      status: 'not_measured',
      why: '源码快照目录不存在',
      foreign: [],
      answering: [],
    };
  }
  if (!injectedAt) {
    return {
      status: 'not_measured',
      why: 'manifest 里没有注入时刻',
      foreign: [],
      answering: [],
    };
  }
  if (!pristineRepo || !existsSync(pristineRepo)) {
    return {
      status: 'not_measured',
      why: '没有原始仓库就分不出「实验留下的提交」和「项目本来就有的提交」',
      foreign: [],
      answering: [],
    };
  }

  let pristineObjects;
  try {
    pristineObjects = new Set(
      git(pristineRepo, [
        'cat-file',
        '--batch-all-objects',
        '--batch-check=%(objectname)',
      ])
        .split('\n')
        .filter(Boolean),
    );
  } catch (err) {
    return {
      status: 'not_measured',
      why: `读不出原始仓库的对象清单：${err.message}`,
      foreign: [],
      answering: [],
    };
  }

  const ownSignature = head ? commitSignature(repo, head) : null;
  const foreign = [];
  const answering = [];
  for (const sha of allCommitObjects(repo)) {
    if (pristineObjects.has(sha)) continue;
    if (head && sha === head) continue;
    let date;
    try {
      date = Date.parse(git(repo, ['show', '-s', '--format=%cI', sha]).trim());
    } catch {
      continue;
    }
    if (Number.isNaN(date)) continue;
    if (date >= injectedAt) continue;
    const entry = { sha, committed_at: new Date(date).toISOString() };
    foreign.push(entry);
    if (ownSignature && commitSignature(repo, sha) === ownSignature) {
      answering.push(entry);
    }
  }
  return {
    status: 'measured',
    dir: repo,
    pristine_repo: pristineRepo,
    head: head ?? null,
    foreign_count: foreign.length,
    answering_count: answering.length,
    foreign: foreign.slice(0, 40),
    answering,
  };
}

/**
 * 源码快照的「原始仓库」在哪：它的 origin 远端就是克隆来源。
 * 拿不到就返回 null（调用方据此判「量不到」，不许当成干净）。
 */
export function pristineOf(repo) {
  try {
    const url = git(repo, ['remote', 'get-url', 'origin']).trim();
    return url && existsSync(url) ? url : null;
  } catch {
    return null;
  }
}
