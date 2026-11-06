#!/usr/bin/env node
// Read-only observation channels for IncidentAgent.
//
// Every subcommand here performs a read and nothing else. There is no verb in
// this file that mutates the target service, its data, or the git history — the
// boundary is enforced by the absence of write code, not by a prompt telling
// the agent to behave.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, relative } from 'node:path';

// ---------------------------------------------------------------------------
// Target descriptor
//
// A target is data, not code: the same channels must work against the lab
// fixture and against a real service, and adding a target must not require
// editing this file. The descriptor names the paths, the Prometheus and
// actuator endpoints, the container, and the metric label the target's own
// metrics carry.
//
// Resolution order (first hit wins):
//   1. INCIDENT_TARGET_FILE -> absolute path to a descriptor
//   2. INCIDENT_TARGET      -> a name, looked up in INCIDENT_TARGET_DIR
//                              (colon separated) and in ./targets/ next to
//                              this file
//   3. no descriptor        -> the built-in defaults below
//
// Real targets' descriptors contain internal paths, so they live outside the
// repository; the lab fixture needs none and keeps the defaults.
// Environment variables still win over the descriptor: the round harness
// points the channels at the live workspace that way.
// ---------------------------------------------------------------------------

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readDescriptor(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    die(`target descriptor ${file} is not readable JSON: ${err.message}`);
  }
  return { ...parsed, __file: file };
}

function findDescriptor() {
  const explicit = process.env.INCIDENT_TARGET_FILE;
  if (explicit) {
    if (!existsSync(explicit))
      die(`INCIDENT_TARGET_FILE does not exist: ${explicit}`);
    return readDescriptor(explicit);
  }
  const name = process.env.INCIDENT_TARGET;
  if (!name) return null;
  const dirs = [
    ...(process.env.INCIDENT_TARGET_DIR ?? '').split(':').filter(Boolean),
    new URL('../targets/', import.meta.url).pathname,
  ];
  for (const dir of dirs) {
    const file = join(dir, `${name}.json`);
    if (existsSync(file)) return readDescriptor(file);
  }
  die(`target "${name}" not found in: ${dirs.join(', ')}`);
}

const DESCRIPTOR = findDescriptor();

const PROMETHEUS =
  process.env.PROMETHEUS_URL ??
  DESCRIPTOR?.prometheusUrl ??
  'http://127.0.0.1:9090';
const TARGET =
  process.env.TARGET_URL ??
  DESCRIPTOR?.actuatorBaseUrl ??
  'http://127.0.0.1:8080';
const LOG_DIR =
  process.env.LOG_DIR ??
  DESCRIPTOR?.logsDir ??
  new URL('../logs/', import.meta.url).pathname;
const REPO =
  process.env.TARGET_REPO ??
  DESCRIPTOR?.repoPath ??
  new URL('../target-service/', import.meta.url).pathname;
const CONTAINER =
  process.env.TARGET_CONTAINER ?? DESCRIPTOR?.container ?? 'target-service';
const APP_STARTED_PATTERN =
  DESCRIPTOR?.appStartedPattern ?? 'Started TargetServiceApplication';

/**
 * actuator 通道的认证头。
 *
 * 真实靶子的 actuator 往往在鉴权后面。凭据**只从环境变量读**，不进描述文件——
 * 描述文件是可以被复制的，凭据不该跟着描述文件走。
 *
 *   ACTUATOR_TOKEN             直接放进 Authorization 头（Bearer 之外的形态也照原样发）
 *   ACTUATOR_USERNAME + ACTUATOR_PASSWORD   走 Basic
 */
function actuatorAuthHeader() {
  const token = process.env.ACTUATOR_TOKEN;
  if (token) return { Authorization: token };
  const user = process.env.ACTUATOR_USERNAME;
  const pass = process.env.ACTUATOR_PASSWORD;
  if (user && pass) {
    const raw = Buffer.from(`${user}:${pass}`).toString('base64');
    return { Authorization: `Basic ${raw}` };
  }
  return {};
}

// The metric label the target's own metrics carry. The lab fixture's metrics
// are tagged `application="target-service"`; a real target may tag them
// differently, and the PromQL in the skills is written against the fixture's
// literal. Aliases are data, so the CLI resolves the fixture literal to the
// target's real label instead of the skills having to know which target they
// are running against.
const APP_LABEL = DESCRIPTOR?.application ?? null;
const METRIC_LABEL_NAME = DESCRIPTOR?.metricLabelName ?? 'application';
const LABEL_ALIASES = DESCRIPTOR?.metricLabelAliases ?? [];

function resolvePromql(promql) {
  if (!APP_LABEL) return { query: promql, rewritten: false };
  let query = promql.replaceAll('{{APP}}', APP_LABEL);
  let rewritten = query !== promql;
  for (const alias of LABEL_ALIASES) {
    if (alias === APP_LABEL) continue;
    const re = new RegExp(
      `${escapeRegExp(METRIC_LABEL_NAME)}=(["']?)${escapeRegExp(alias)}\\1`,
      'g',
    );
    const next = query.replace(
      re,
      (_m, quote) => `${METRIC_LABEL_NAME}=${quote}${APP_LABEL}${quote}`,
    );
    if (next !== query) rewritten = true;
    query = next;
  }
  return { query, rewritten };
}

// ---------------------------------------------------------------------------
// Deploy ledger
//
// The ledger answers exactly one question: "which code was running at this
// moment?" It is an append-only JSONL file, keyed by image *digest*.
//
// Why the CLI reads a file instead of querying the registry: the registry wants
// credentials, and a channel that holds credentials puts them inside the
// agent's reach. Reading a file keeps every channel offline and lets a finished
// round be replayed bit for bit. Collection is a separate process outside the
// agent's reach; see incident/DEPLOY-LEDGER.md.
//
// The failure that matters: "the ledger has no entry for this digest" and "no
// code changed inside the window" are opposite findings. The first means we
// could not look; the second means we looked and ruled out a deploy. Collapsing
// the first into the second turns a blind spot into a false exoneration, so a
// miss is a hard error here and the two phrasings never share a code path.
// ---------------------------------------------------------------------------

const LEDGER = process.env.DEPLOY_LEDGER ?? DESCRIPTOR?.ledgerPath ?? null;
const LEDGER_STALE_HOURS = Number(process.env.DEPLOY_LEDGER_STALE_HOURS ?? 24);
const DEFAULT_MATCH_TOLERANCE_SECONDS = Number(
  process.env.DEPLOY_MATCH_TOLERANCE_SECONDS ?? 600,
);

function loadLedger() {
  if (!LEDGER) {
    return die(
      'no deploy ledger configured: set DEPLOY_LEDGER, or ledgerPath in the target descriptor.\n' +
        '  台账缺条目：没有配置台账。\n' +
        '  没有台账时，部署归因这件事**没有查过**，不能当成查过并且排除了。',
    );
  }
  if (!existsSync(LEDGER)) {
    return die(
      `台账缺条目：部署台账文件不存在：${LEDGER}\n` +
        '  没读到台账 ≠ 排除了一次发布。请先确认采集器是否在跑。',
    );
  }
  let raw;
  try {
    raw = readFileSync(LEDGER, 'utf8');
  } catch (err) {
    return die(`台账缺条目：部署台账读不出来：${LEDGER}（${err.message}）`);
  }

  const entries = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i].trim();
    if (!text) continue;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      // A malformed line is a hard error, never a silent skip: the line being
      // skipped may be exactly the entry we were asked about, and skipping it
      // would report "not found" for an entry that is right there.
      return die(
        `台账缺条目：台账第 ${i + 1} 行不是合法 JSON：${err.message}\n` +
          `  ${LEDGER}\n` +
          '  坏行不能跳过——被跳过的那条可能正是要找的那条。',
      );
    }
    entries.push({ ...parsed, __line: i + 1 });
  }
  return entries;
}

// Accepts `sha256:...`, a bare 64-hex digest, or a full `repo/img@sha256:...`
// reference. Returns null when the key is not a digest at all, so callers can
// fall through to matching on the image reference or the commit.
function normalizeDigest(key) {
  if (!key) return null;
  const at = key.indexOf('@');
  const tail = at === -1 ? key : key.slice(at + 1);
  if (/^sha256:[0-9a-f]{64}$/i.test(tail)) return tail.toLowerCase();
  if (/^[0-9a-f]{64}$/i.test(tail)) return `sha256:${tail.toLowerCase()}`;
  return null;
}

function entryDigest(entry) {
  return normalizeDigest(entry?.digest ?? entry?.image_digest ?? null);
}

function entryStartMs(entry) {
  const raw = entry?.pod_started_at ?? entry?.started_at ?? null;
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

// When did this observation happen? Different from "when did the pod start":
// a running observation has a time even when the start time is unknown.
function entryObservedMs(entry) {
  const raw =
    entry?.running_observed_at ??
    entry?.deployed_at ??
    entry?.pod_started_at ??
    entry?.started_at ??
    entry?.collected_at ??
    null;
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

// Which sources let a commit be treated as "the code inside this image".
//
// Only a value the build wrote into the image itself qualifies. Everything
// else is an inference from timestamps, and an inference can name a commit
// whose tree is not what shipped -- a build run on an uncommitted working tree
// produces exactly that, and it looks completely normal in the ledger. This is
// not hypothetical: it was observed on a real image (see
// incident/DEPLOY-LEDGER.md section 12.6).
const RELIABLE_COMMIT_SOURCES = new Set([
  'oci-label',
  'oci_label',
  'annotation',
]);

// A build record is a machine fact about the build, like an OCI label is a
// machine fact about the image -- but it is one step further away from the
// bytes, so it is reported separately rather than lumped in with the label.
const BUILD_RECORD_COMMIT_SOURCES = new Set(['jenkins-build']);

function commitReliability(entry) {
  const source = entry?.commit_source ?? null;
  const commit = entry?.commit ?? null;
  if (!commit) {
    return {
      commit_reliable: false,
      commit_note:
        '台账里没有 commit——这是「这个镜像报不出自己的 commit」，不是「这段代码没有变」。',
    };
  }
  if (RELIABLE_COMMIT_SOURCES.has(source)) {
    return {
      commit_reliable: true,
      commit_note: `commit 来自镜像自身（${source}），可以当作「镜像里的代码」。`,
    };
  }
  if (BUILD_RECORD_COMMIT_SOURCES.has(source)) {
    return {
      commit_reliable: true,
      commit_note:
        'commit 来自 CI 的构建记录（这次构建检出的 commit），是事实而不是按时间推断。' +
        '注意：若构建工作区当时有未提交改动，镜像内容仍可能与该 commit 的树不同；' +
        '读源码时把它当作「最可能的那份代码」，不要断言「逐字节相同」。',
    };
  }
  const kind =
    source === 'jenkins-parameter'
      ? 'CI 自述的参数'
      : source === 'manual'
        ? '人工填写'
        : source === 'git-window' || source === 'git-head-fallback'
          ? '按构建时刻从 git 历史推断'
          : `来源 ${source ?? '(缺失)'}`;
  return {
    commit_reliable: false,
    commit_note:
      `commit 是${kind}，不是镜像自述——只能当线索。` +
      '构建可能跑在未提交的工作区上，此时这个 commit 的树并不是镜像里的代码；' +
      '不要据此读源码并断言「这就是当时在跑的代码」。',
  };
}

// The timestamp inference is kept next to the fact it produced. When the two
// disagree, that difference is the evidence that the inference is not to be
// trusted -- and it is exactly the case that was observed on the real
// project, where the inference named a commit that was weeks old.
function commitInferenceNote(entry) {
  const inferred = entry?.commit_inferred ?? null;
  const commit = entry?.commit ?? null;
  if (!inferred) return { commit_inference_conflict: false };
  const conflict = Boolean(commit) && inferred !== commit;
  return {
    commit_inference_conflict: conflict,
    commit_inferred: inferred,
    commit_inferred_source: entry?.commit_inferred_source ?? null,
    ...(conflict
      ? {
          commit_inference_note:
            '按构建时刻从 git 历史推断出的 commit 与本次记录的 commit 不是同一个——' +
            '推断错了。以记录里的 commit 为准。',
        }
      : {}),
  };
}

function decorateEntry(entry, freshness) {
  return {
    ...withFreshness(entry, freshness),
    ...commitReliability(entry),
    ...commitInferenceNote(entry),
  };
}

// Several rows can share a digest: the same image deployed twice, or observed
// running later. The newest observation is the one to answer with, and the
// caller is told how many there were.
function newestByObservation(rows) {
  return [...rows].sort(
    (a, b) =>
      (entryObservedMs(b) ?? -Infinity) - (entryObservedMs(a) ?? -Infinity),
  );
}

function ledgerFreshness(entries) {
  let newest = null;
  for (const entry of entries) {
    const ms = Date.parse(entry?.collected_at ?? '');
    if (Number.isNaN(ms)) continue;
    if (newest === null || ms > newest) newest = ms;
  }
  const now = Date.now();
  const ageHours = newest === null ? null : (now - newest) / 3_600_000;
  return {
    newest_collected_at:
      newest === null ? null : new Date(newest).toISOString(),
    age_hours: ageHours === null ? null : Number(ageHours.toFixed(2)),
    stale: ageHours === null ? null : ageHours > LEDGER_STALE_HOURS,
    stale_threshold_hours: LEDGER_STALE_HOURS,
  };
}

// The scariest way this ledger can lie is by going stale: a collector that died
// in March still answers "the digest you asked about is imaged at commit X" in
// November, with no hint that nothing has been written since March. Freshness
// rides along with every hit so the staleness is visible in the same output as
// the answer, not in a separate command the agent has to think to run.
function withFreshness(entry, freshness) {
  const { __line, ...rest } = entry ?? {};
  return { ...rest, ledger_freshness: freshness };
}

// The knob file holds the runtime settings the lab applies on container
// start. Its mtime is the "when was the configuration last changed" evidence
// that `runtime env` cannot give on its own -- actuator masks the effective
// values, and the container only ever shows the current ones.
function knobFile() {
  const candidates = [
    process.env.LAB_ENV,
    `${process.env.HOME}/.config/miniclaw-lab/lab.env`,
    new URL('../.env', import.meta.url).pathname,
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? null;
}

// The actuator masks every configuration value ("******"), so the effective
// value of a runtime knob cannot be read from inside the application. These
// are the only keys this tool will surface, and only for the container under
// test -- the point is to give the agent a sanctioned path to the knob it
// would otherwise have to shell out for.
const RUNTIME_KNOBS = [
  'DOWNSTREAM_TIMEOUT_MS',
  'DB_POOL_SIZE',
  'LOAD_ENABLED',
  'LOAD_PATHS',
  'SPRING_DATASOURCE_HIKARI_CONNECTION_TIMEOUT',
  'TZ',
];

const args = process.argv.slice(2);
const channel = args.shift();

/**
 * 容器启动时刻。
 *
 * `logs first` 把它当默认窗口起点：问「异常首现」时，正确的起点是**当前这次部署之后**，
 * 不是日志文件的最开头（日志归档里还留着前几天别的故障）。少了这个默认值，
 * Agent 只能自己猜一个 --since，然后很容易猜出一个**产出不了它引用的那个值**的窗口——
 * 2026-11-04 那轮报告的锚点 ② 就是这么错的（第 3 次犯这一类）。
 */
function startAnchor() {
  try {
    const raw = execFileSync(
      'docker',
      ['inspect', CONTAINER, '--format', '{{.State.StartedAt}}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    const ms = Date.parse(raw);
    if (!Number.isNaN(ms)) return { ms, source: 'docker inspect' };
  } catch {
    // A target that is not a local container (a service running on a
    // developer's machine) has no docker inspect to ask. The descriptor can
    // carry the anchor instead.
  }
  const declared = DESCRIPTOR?.startedAt;
  if (!declared) return { ms: null, source: 'unavailable' };
  const ms = Date.parse(declared);
  return Number.isNaN(ms)
    ? { ms: null, source: 'unavailable' }
    : { ms, source: 'descriptor.startedAt (target is not a local container)' };
}

function containerStartedAt() {
  return startAnchor().ms;
}

const usage = `incident-readonly <channel> [options]

channels (all read-only):
  target info                             which target these channels talk to:
                                          application, the metric label its own
                                          metrics carry, and the endpoints. Write
                                          PromQL against this label, not against
                                          the one the skills happen to show.
  metrics query   <promql>                  instant query against Prometheus
  metrics range   <promql> <start> <end> <step>   range query over a window that has
                                                      already closed -- the end must NOT be
                                                      later than the current time:
                                                      steps past now are computed by
                                                      Prometheus from truncated windows and
                                                      come back as artifacts, not observations
  metrics alerts                               currently firing alerts
  metrics targets                              scrape target health
  logs   grep    <pattern> [--since ISO] [--until ISO] [--limit N] [--count]
  logs   first   <pattern> [--since ISO]     earliest occurrence after a timestamp
                                               (--since defaults to the container
                                               start time and the effective window
                                               is printed with the result)
  git    log     [--since ISO] [--until ISO] [--limit N]
  git    diff    <ref> [--stat]              changes introduced by a commit
  git    show    <ref>                        commit metadata and changed files
  git    file    <ref>:<path>                 file content at a revision
  actuator <endpoint>                         GET a Spring Boot actuator endpoint
  runtime env                                 runtime knobs effective in the running container
  runtime started                             container start time and application readiness
  deploy current [--tolerance S]               which ledger entry is the rollout now
                                               running: matched on the start anchor
                                               (default tolerance ${DEFAULT_MATCH_TOLERANCE_SECONDS}s)
  deploy lookup  <digest|image_ref|commit>     the ledger entry for one image or commit
  deploy running                               which image is running now, and how
                                               that was observed (human or cluster)
  deploy list    [--limit N]                   recent rollouts, newest first
  deploy check                                 ledger health: entry count, freshness,
                                               duplicate digests, entries with no commit

  The deploy channel is how "which code was running" gets answered. Its
  primary key is the image digest. A lookup that finds nothing is an ERROR,
  not an empty result: "the ledger has no entry" and "no code changed in the
  window" are opposite findings, and only the second one rules out a deploy.

  Every answer carries \`commit_reliable\`. It is true only when the commit came
  from the image itself (an OCI label or an annotation the build wrote). A
  commit inferred from git history is a LEAD, not evidence: it may name a
  commit whose tree is not what the image contains, because a build can run on
  an uncommitted working tree. Do not read source at an unreliable commit and
  call it "the code that was running".
`;

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

// Prometheus answers a range query by stepping from `start` to `end`. A step
// that lands past the current time is not "no data" -- Prometheus evaluates it
// against a window it does not have yet, so the ratio collapses to whatever
// the truncated window yields (1/10, 1/12, ...) and reads like a plausible
// observation. A round once asked for a range that ran 3 minutes into the
// future and reported a 9.9% 5xx spike that never happened; the true maximum
// was 8.917%. The boundary is enforced here rather than described in the help
// text, because a prompt-level rule is exactly what the agent ignored.
function parseTime(value) {
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    const n = Number(value);
    return n > 1e12 ? n : n * 1000;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? NaN : ms;
}

async function prom(path, params = {}) {
  const url = new URL(path, PROMETHEUS);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (!res.ok) die(`prometheus ${res.status}: ${await res.text()}`);
  return res.json();
}

let lastGitError = '';

function gitOut(...argv) {
  try {
    return execFileSync('git', argv, {
      cwd: REPO,
      encoding: 'utf8',
      maxBuffer: 8 << 20,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Commit times are host-local by default; the target service logs in UTC.
      // Emitting UTC here is what lets deployment-window compare the two.
      env: { ...process.env, TZ: 'UTC' },
    });
  } catch (err) {
    lastGitError = err.stderr ?? err.message;
    return null;
  }
}

function git(...argv) {
  const out = gitOut(...argv);
  if (out === null) die(`git ${argv.join(' ')} failed: ${lastGitError}`);
  return out;
}

// Container logs are stamped in UTC ("2026-10-23 10:06:37.092"). Date.parse
// would read that as host-local and shift every timestamp by the host offset.
function parseLogTimestamp(text) {
  const ms = Date.parse(`${text.slice(0, 10)}T${text.slice(11, 23)}Z`);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

function logFiles() {
  try {
    const entries = readdirSync(LOG_DIR)
      // "app.log" is the live file; "app.log.<date>.<n>[.gz]" are rotated
      // archives. Both are evidence -- an agent that can only see the live
      // file cannot prove what happened before the last restart.
      .filter((f) => f.endsWith('.log') || f.startsWith('app.log.'));
    // A target may keep one file per level ("all.log" plus "info.log"), in
    // which case the same line appears in two files and a count channel
    // doubles it. The descriptor names the files to read so the count means
    // one thing.
    const patterns = DESCRIPTOR?.logFiles;
    const selected = patterns
      ? entries.filter((f) => patterns.some((p) => matchesPattern(p, f)))
      : entries;
    return selected.sort().map((f) => join(LOG_DIR, f));
  } catch {
    die(`no log directory at ${LOG_DIR}`);
  }
}

function matchesPattern(pattern, name) {
  const re = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`);
  return re.test(name);
}

// Rotated archives are usually gzip, but the lab also contains archives that
// were renamed into place without compression. Sniff the gzip magic bytes
// instead of trusting the file name, so both kinds read correctly.
function readLogText(file) {
  const buf = readFileSync(file);
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    return gunzipSync(buf).toString('utf8');
  }
  return buf.toString('utf8');
}

function flag(name, fallback = undefined) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
}

async function main() {
  switch (channel) {
    case 'metrics': {
      const op = args.shift();
      if (op === 'query') {
        const promql = args.shift();
        if (!promql) die('usage: metrics query <promql>');
        const { query, rewritten } = resolvePromql(promql);
        if (rewritten) {
          process.stderr.write(`effective query: ${query}\n`);
        }
        const out = await prom('/api/v1/query', { query });
        return void console.log(JSON.stringify(out.data, null, 2));
      }
      if (op === 'range') {
        const [promql, start, end, step = '15s'] = args;
        if (!promql || !start || !end)
          die('usage: metrics range <promql> <start> <end> [step]');
        const startMs = parseTime(start);
        if (Number.isNaN(startMs))
          die(
            `metrics range: cannot parse start "${start}" (use RFC3339 or unix seconds)`,
          );
        const endMs = parseTime(end);
        if (Number.isNaN(endMs))
          die(
            `metrics range: cannot parse end "${end}" (use RFC3339 or unix seconds)`,
          );
        const now = Date.now();
        if (endMs > now) {
          die(
            `metrics range: end (${end}) is later than the current time (${new Date(now).toISOString()}). ` +
              'A range that runs into the future returns values Prometheus computed from truncated ' +
              'windows; they are artifacts, not observations. Query a window that has already closed.',
          );
        }
        if (startMs > endMs)
          die(`metrics range: start (${start}) is later than end (${end})`);
        const { query, rewritten } = resolvePromql(promql);
        if (rewritten) {
          process.stderr.write(`effective query: ${query}\n`);
        }
        const out = await prom('/api/v1/query_range', {
          query,
          start,
          end,
          step,
        });
        return void console.log(JSON.stringify(out.data, null, 2));
      }
      if (op === 'alerts') {
        const out = await prom('/api/v1/alerts');
        const firing = out.data.alerts.filter((a) => a.state === 'firing');
        return void console.log(JSON.stringify(firing, null, 2));
      }
      if (op === 'targets') {
        const out = await prom('/api/v1/targets');
        return void console.log(
          JSON.stringify(out.data.activeTargets, null, 2),
        );
      }
      return die(`unknown metrics op: ${op}`);
    }

    case 'logs': {
      const op = args.shift();
      const pattern = args.shift();
      if (!pattern)
        die(
          'usage: logs <grep|first> <pattern> [--since ISO] [--until ISO] [--limit N] [--count]',
        );
      const since = flag('since');
      const until = flag('until');
      const count = args.includes('--count');
      const limit = Number(flag('limit', op === 'first' ? '1' : '50'));
      let sinceMs = since ? Date.parse(since) : Number.NEGATIVE_INFINITY;
      const untilMs = until ? Date.parse(until) : Number.POSITIVE_INFINITY;
      if (Number.isNaN(sinceMs))
        die(`--since is not a valid timestamp: ${since}`);
      if (Number.isNaN(untilMs))
        die(`--until is not a valid timestamp: ${until}`);

      /**
       * `first` 的默认窗口：容器启动时刻。
       *
       * 为什么要默认值：问「异常首现」却不给窗口，工具就只能从日志文件开头找，
       * 而日志归档里还留着前几天别的故障——找到的是「历史上第一次」，不是「这次的首现」。
       * Agent 于是自己编一个 --since，然后引一个**产出不了那个值**的命令（2026-11-04 那轮的
       * 硬错误 D1，第 3 次犯这一类）。把默认值放进工具，Agent 就不用猜。
       *
       * 窗口本身随结果一起打印：引用这条输出时，窗口是自带的，读者不必反推。
       */
      let windowNote = '';
      if (op === 'first' && !since) {
        const started = containerStartedAt();
        if (started === null) {
          windowNote =
            '# --since omitted and the container start time is unavailable: the window starts at the beginning of the logs';
        } else {
          sinceMs = started;
          windowNote = `# --since omitted: the window starts at the container start time (${new Date(started).toISOString()})`;
        }
      }

      let lines = logFiles().flatMap((file) =>
        readLogText(file)
          .split('\n')
          .filter(Boolean)
          .map((text) => ({ text, ts: parseLogTimestamp(text) })),
      );
      lines = lines.filter(
        (l) => l.ts >= sinceMs && l.ts <= untilMs && l.text.includes(pattern),
      );
      lines.sort((a, b) => a.ts - b.ts);
      if (count) {
        return void console.log(String(lines.length));
      }
      const picked = op === 'first' ? lines.slice(0, 1) : lines.slice(0, limit);
      const body = picked.length
        ? picked.map((l) => l.text).join('\n')
        : `(no match for ${JSON.stringify(pattern)} since ${since ?? (Number.isFinite(sinceMs) ? new Date(sinceMs).toISOString() : 'beginning')})`;
      return void console.log(windowNote ? `${windowNote}\n${body}` : body);
    }

    case 'git': {
      const op = args.shift();
      // %aI is strict ISO 8601. We re-emit it as UTC ourselves: git's own
      // %ad keeps the commit's recorded offset, so a commit made at +08:00
      // would print 18:04 and the container's UTC log would print 10:04 for
      // the same instant, breaking deployment-window correlation.
      const LOG_FORMAT = '--pretty=format:%H%x09%aI%x09%an%x09%s';
      const toUtcLines = (out) =>
        out
          .split('\n')
          .map((line) => {
            const m = line.match(/^(\S+)\t(\S+?)(?:[+-]\d{2}:\d{2}|Z)\t(.*)$/);
            return m
              ? `${m[1]}\t${new Date(m[2]).toISOString()}\t${m[3]}`
              : line;
          })
          .join('\n');

      if (op === 'log') {
        const argv = ['log', LOG_FORMAT];
        for (const name of ['since', 'until']) {
          const v = flag(name);
          if (v) argv.push(`--${name}=${v}`);
        }
        argv.push(`-n${flag('limit', '20')}`);
        return void console.log(toUtcLines(git(...argv)));
      }
      if (op === 'diff') {
        const ref = args.shift();
        if (!ref) die('usage: git diff <ref> [--stat]');
        const argv = ['show', '--patch', ref];
        if (flag('stat')) argv.push('--stat');
        return void console.log(git(...argv));
      }
      if (op === 'show') {
        const ref = args.shift();
        if (!ref) die('usage: git show <ref>');
        return void console.log(git('show', '--stat', '--pretty=fuller', ref));
      }
      if (op === 'file') {
        const spec = args.shift();
        if (!spec) die('usage: git file <ref>:<path>');
        const sep = spec.indexOf(':');
        if (sep === -1)
          die(`expected <ref>:<path>, got ${JSON.stringify(spec)}`);
        const ref = spec.slice(0, sep);
        const path = spec.slice(sep + 1);
        // The service lives in a subdirectory of the repository, so the path
        // the caller knows (relative to the service) has to be rebased onto the
        // repository root before git will resolve it.
        const top = git('rev-parse', '--show-toplevel').trim();
        const candidates = path.startsWith('/')
          ? [path]
          : [join(top, path), join(REPO, path)];
        for (const candidate of candidates) {
          const rel = relative(top, candidate);
          if (rel.startsWith('..')) continue;
          const out = gitOut('show', `${ref}:${rel}`);
          if (out !== null) return void console.log(out);
        }
        die(`git file: ${ref}:${path} not found under ${top}`);
      }
      return die(`unknown git op: ${op}`);
    }

    case 'actuator': {
      const endpoint = (args.shift() ?? 'health').replace(/^\/+/, '');
      const res = await fetch(`${TARGET}/actuator/${endpoint}`, {
        headers: actuatorAuthHeader(),
      });
      const body = await res.text();
      if (!res.ok)
        die(
          `actuator ${endpoint} returned ${res.status}: ${body.slice(0, 400)}`,
        );
      return void console.log(body);
    }

    case 'runtime': {
      const op = args.shift();
      let inspectError = null;
      const inspectOrNull = (format) => {
        try {
          return execFileSync(
            'docker',
            ['inspect', CONTAINER, '--format', format],
            {
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          ).trim();
        } catch (err) {
          inspectError = err.stderr ?? err.message;
          return null;
        }
      };
      const inspect = (format) => {
        const raw = inspectOrNull(format);
        if (raw === null) {
          die(
            `docker inspect ${CONTAINER} failed: ${inspectError ?? 'unknown error'}`,
          );
        }
        return raw;
      };
      const latestLogLine = (pattern) => {
        let best = null;
        for (const file of logFiles()) {
          for (const text of readLogText(file).split('\n')) {
            if (!text.includes(pattern)) continue;
            const ts = parseLogTimestamp(text);
            if (!best || ts >= best.ts) best = { text, ts };
          }
        }
        return best?.text ?? null;
      };

      if (op === 'env') {
        const raw = inspectOrNull('{{range .Config.Env}}{{println .}}{{end}}');
        const kv = new Map(
          (raw ?? '')
            .split('\n')
            .filter(Boolean)
            .map((line) => {
              const i = line.indexOf('=');
              return i === -1
                ? [line, '']
                : [line.slice(0, i), line.slice(i + 1)];
            }),
        );
        console.log(`container: ${CONTAINER}`);
        if (raw === null) {
          console.log(
            'container_env: (unavailable: target is not a local container)',
          );
        }
        for (const key of RUNTIME_KNOBS) {
          const value = kv.get(key);
          console.log(
            value === undefined
              ? `${key}=<not set in container> (compose default applies)`
              : `${key}=${value}`,
          );
        }
        const knob = knobFile();
        if (knob) {
          console.log(`knob_file: ${knob}`);
          console.log(
            `knob_file_mtime: ${statSync(knob).mtime.toISOString()} (last edit of the knob file)`,
          );
        }
        return;
      }

      if (op === 'started') {
        console.log(`container: ${CONTAINER}`);
        const raw = inspectOrNull('{{.State.StartedAt}}');
        if (raw !== null) {
          console.log(`container_started_at: ${raw}`);
        } else {
          // The target is not a local container (a service running as a host
          // process). The descriptor carries the anchor instead of docker.
          const ms = containerStartedAt();
          console.log(
            `container_started_at: ${
              ms === null ? '(unavailable)' : new Date(ms).toISOString()
            }`,
          );
          console.log(
            `container_started_at_source: ${
              ms === null
                ? 'unavailable'
                : 'descriptor.startedAt (target is not a local container)'
            }`,
          );
        }
        console.log(
          `app_started_log: ${
            latestLogLine(APP_STARTED_PATTERN) ??
            '(no "Started ...Application" line found)'
          }`,
        );
        return;
      }

      return die(`unknown runtime op: ${op}`);
    }

    case 'deploy': {
      const op = args.shift() ?? 'current';
      // Validate the verb before touching the ledger: a typo should say "unknown
      // op", not send the caller off chasing a ledger that was never the
      // problem.
      if (!['current', 'lookup', 'running', 'list', 'check'].includes(op)) {
        return die(`unknown deploy op: ${op}`);
      }
      const entries = loadLedger();
      const freshness = ledgerFreshness(entries);

      if (op === 'check') {
        const seen = new Map();
        const duplicates = [];
        for (const entry of entries) {
          const digest = entryDigest(entry);
          if (!digest) continue;
          if (seen.has(digest)) {
            duplicates.push({
              digest,
              lines: [seen.get(digest), entry.__line],
            });
          } else {
            seen.set(digest, entry.__line);
          }
        }
        return void console.log(
          JSON.stringify(
            {
              ledger: LEDGER,
              entries: entries.length,
              distinct_digests: seen.size,
              duplicate_digests: duplicates,
              with_start_anchor: entries.filter((e) => entryStartMs(e) !== null)
                .length,
              with_running_observation: entries.filter(
                (e) => e.running_observed_at != null,
              ).length,
              without_commit: entries
                .filter((e) => entryDigest(e) && !e.commit)
                .map((e) => entryDigest(e)),
              unreliable_commits: entries
                .filter(
                  (e) =>
                    entryDigest(e) && !commitReliability(e).commit_reliable,
                )
                .map((e) => entryDigest(e)),
              ledger_freshness: freshness,
            },
            null,
            2,
          ),
        );
      }

      if (op === 'list') {
        const limit = Number(flag('limit', 20));
        const sorted = [...entries].sort((a, b) => {
          const am = entryObservedMs(a);
          const bm = entryObservedMs(b);
          if (am === null && bm === null) return 0;
          if (am === null) return 1;
          if (bm === null) return -1;
          return bm - am;
        });
        return void console.log(
          JSON.stringify(
            {
              ledger: LEDGER,
              total: sorted.length,
              shown: Math.min(limit, sorted.length),
              ledger_freshness: freshness,
              entries: sorted
                .slice(0, limit)
                .map((e) => decorateEntry(e, freshness)),
            },
            null,
            2,
          ),
        );
      }

      if (op === 'lookup') {
        const key = args.shift();
        if (!key) return die('usage: deploy lookup <digest|image_ref|commit>');

        const digest = normalizeDigest(key);
        let hit = null;
        let matched_on = null;
        let rollouts = 0;

        // The same image can be in the ledger more than once (deployed twice,
        // or observed running, or looked at again by a later poll). Answer with
        // the newest observation and say how many there were, instead of
        // silently returning whichever line came first in the file.
        //
        // "How many" means how many *deployments*, not how many lines: a poll
        // that finds the same pod still running adds a line but not a
        // rollout, and counting lines would make a heartbeat look like a
        // deployment history.
        let observations = 0;
        let unknownStartBuckets = 0;
        const pickNewest = (rows) => {
          if (rows.length === 0) return null;
          observations = rows.length;
          // A rollout is identified by the image plus the pod's start time. A
          // row without a start time cannot be tied to a rollout -- it was
          // observed before the cluster could be read, or by a human -- so it
          // forms its own bucket and is reported separately rather than
          // silently inflating the deployment count.
          const buckets = new Map();
          const unknownDigests = new Set();
          for (const e of rows) {
            const started = e.pod_started_at ?? null;
            const digest = entryDigest(e) ?? '';
            if (started === null) unknownDigests.add(digest);
            const key = `${digest}|${started ?? '(no start time)'}`;
            buckets.set(key, (buckets.get(key) ?? 0) + 1);
          }
          unknownStartBuckets = unknownDigests.size;
          rollouts = buckets.size;
          return newestByObservation(rows)[0];
        };

        if (digest) {
          hit = pickNewest(entries.filter((e) => entryDigest(e) === digest));
          if (hit) matched_on = 'digest';
        }
        // Docker prints short image IDs (12 hex characters) and people paste
        // them. A short ID that is in the ledger must not come back as "not in
        // the ledger" -- that reads as "this deploy does not exist", which is
        // the opposite of what a prefix match means.
        const digestPrefixMatches = digest
          ? []
          : (() => {
              const prefix = key.toLowerCase().replace(/^sha256:/, '');
              if (!/^[0-9a-f]{7,64}$/.test(prefix)) return [];
              return entries.filter((e) => {
                const d = entryDigest(e);
                return d && d.replace(/^sha256:/, '').startsWith(prefix);
              });
            })();
        const commitPrefixMatches = /^[0-9a-f]{7,40}$/i.test(key)
          ? entries.filter(
              (e) =>
                typeof e.commit === 'string' &&
                e.commit.toLowerCase().startsWith(key.toLowerCase()),
            )
          : [];
        // Two rows of the same digest are two observations of one image, not
        // an ambiguous prefix. Ambiguity is measured in distinct images.
        const distinctDigits = new Set(digestPrefixMatches.map(entryDigest));
        const distinctCommits = new Set(
          commitPrefixMatches.map((e) => e.commit),
        );
        if (distinctDigits.size > 1) {
          return die(
            `台账前缀有歧义：${key} 同时匹配 ${distinctDigits.size} 个不同的 digest。\n` +
              '  请用完整 digest 查询。',
          );
        }
        if (distinctDigits.size === 1 && distinctCommits.size > 0) {
          const theDigest = [...distinctDigits][0];
          const matchesAnotherImage = commitPrefixMatches.some(
            (e) => entryDigest(e) !== theDigest,
          );
          if (matchesAnotherImage) {
            return die(
              `台账前缀有歧义：${key} 既匹配一个 digest 又匹配另一个 digest 的 commit。\n` +
                '  请用完整 digest 或完整 commit 查询。',
            );
          }
        }
        if (!hit) {
          hit = pickNewest(entries.filter((e) => e.image_ref === key));
          if (hit) matched_on = 'image_ref';
        }
        if (!hit && !key.includes('/')) {
          hit = pickNewest(
            entries.filter(
              (e) =>
                typeof e.image_ref === 'string' &&
                e.image_ref.endsWith(`:${key}`),
            ),
          );
          if (hit) matched_on = 'image_ref tag';
        }
        if (!hit && digestPrefixMatches.length === 1) {
          hit = pickNewest(digestPrefixMatches);
          matched_on = 'digest prefix';
        }
        if (!hit && commitPrefixMatches.length === 1) {
          hit = pickNewest(commitPrefixMatches);
          matched_on = 'commit prefix';
        }

        if (!hit) {
          return die(
            `台账缺条目：台账里没有 ${key}。\n` +
              `  台账：${LEDGER}（${entries.length} 条，最新一条采集于 ${
                freshness.newest_collected_at ?? '(无 collected_at)'
              }）\n` +
              '  这是「没查到」，不等于「排除了发布」——两者是相反的结论。\n' +
              '  在把「没有发布」写进结论之前，先确认这个 digest 是不是压根没被采集过。',
          );
        }

        return void console.log(
          JSON.stringify(
            {
              matched_on,
              ledger: LEDGER,
              rollouts: rollouts || 1,
              observations,
              // How many of those rollouts have no known start time and
              // therefore cannot be pinned to a pod.
              rollouts_without_start_time: unknownStartBuckets,
              entry: decorateEntry(hit, freshness),
            },
            null,
            2,
          ),
        );
      }

      if (op === 'running') {
        // "Which image is running now" is a different question from "when did
        // it start", and it can be answered by something other than a cluster
        // query. The answer must say who observed it and when -- a human
        // confirmation is a real fact, but it is not a machine measurement.
        const observations = entries.filter(
          (e) => e.running_observed_at != null,
        );
        if (observations.length === 0) {
          return die(
            '台账缺条目：台账里没有任何运行态观测。\n' +
              `  台账：${LEDGER}（${entries.length} 条，最新一条采集于 ${
                freshness.newest_collected_at ?? '(无 collected_at)'
              }）\n` +
              '  「没观测到」不等于「没有在跑的服务」——这是没查到，不是结论。\n' +
              '  要用 cluster 查询或人工确认补上这一条，再问。',
          );
        }
        const newest = newestByObservation(observations)[0];
        const startedMs = entryStartMs(newest);
        const observedMs = entryObservedMs(newest);
        return void console.log(
          JSON.stringify(
            {
              ledger: LEDGER,
              observed_at: newest.running_observed_at,
              source: newest.running_source ?? '(缺失)',
              // A human saying "this is the image running now" answers which,
              // never when. Say so instead of leaving a blank that reads like
              // "it just started".
              pod_started_at: newest.pod_started_at ?? null,
              running_for_seconds:
                startedMs === null || observedMs === null
                  ? null
                  : Number(((observedMs - startedMs) / 1000).toFixed(0)),
              pod_started_note:
                startedMs === null
                  ? '起跑时刻未知（观测到的是「跑的是哪个」，不是「什么时候起的」）；时长不可得。'
                  : null,
              ledger_freshness: freshness,
              entry: decorateEntry(newest, freshness),
            },
            null,
            2,
          ),
        );
      }

      if (op === 'current') {
        const toleranceSeconds = Number(
          flag('tolerance', DEFAULT_MATCH_TOLERANCE_SECONDS),
        );
        const anchor = startAnchor();
        if (anchor.ms === null) {
          return die(
            '台账缺条目：拿不到启动锚点，无法关联当前部署。\n' +
              '  既没有本地容器可供 docker inspect，描述文件里也没有 startedAt。\n' +
              '  没有锚点就无法判断「现在是哪次发布在跑」——这是「没查到」。',
          );
        }

        const candidates = [];
        for (const entry of entries) {
          const ms = entryStartMs(entry);
          if (ms === null) continue;
          candidates.push({ entry, delta_seconds: (ms - anchor.ms) / 1000 });
        }
        candidates.sort(
          (a, b) => Math.abs(a.delta_seconds) - Math.abs(b.delta_seconds),
        );
        const best = candidates[0] ?? null;
        const tolerance = toleranceSeconds;

        if (!best || Math.abs(best.delta_seconds) > tolerance) {
          const near = candidates.slice(0, 3).map((c) => ({
            digest: entryDigest(c.entry),
            image_ref: c.entry.image_ref ?? null,
            pod_started_at:
              c.entry.pod_started_at ?? c.entry.started_at ?? null,
            delta_seconds: Number(c.delta_seconds.toFixed(1)),
          }));
          return die(
            '台账缺条目：台账里没有任何一条能对上当前这次启动。\n' +
              `  锚点：${new Date(anchor.ms).toISOString()}（来源：${anchor.source}）\n` +
              `  容差：${tolerance} 秒；台账里最近的三条：\n` +
              (near.length
                ? near
                    .map(
                      (c) =>
                        `    ${c.digest ?? '(无 digest)'} ${c.image_ref ?? ''} 启动于 ${
                          c.pod_started_at ?? '(无时间)'
                        } 差 ${c.delta_seconds}s`,
                    )
                    .join('\n')
                : '    （台账里没有任何条目带 pod_started_at / started_at）') +
              '\n  这是「没查到」，不等于「排除了发布」——两者是相反的结论。',
          );
        }

        return void console.log(
          JSON.stringify(
            {
              ledger: LEDGER,
              anchor: new Date(anchor.ms).toISOString(),
              anchor_source: anchor.source,
              tolerance_seconds: tolerance,
              matched: true,
              delta_seconds: Number(best.delta_seconds.toFixed(1)),
              ledger_freshness: freshness,
              entry: decorateEntry(best.entry, freshness),
            },
            null,
            2,
          ),
        );
      }

      return die(`unknown deploy op: ${op}`);
    }

    case 'target': {
      const op = args.shift() ?? 'info';
      if (op !== 'info') return die(`unknown target op: ${op}`);
      return void console.log(
        JSON.stringify(
          {
            id: DESCRIPTOR?.id ?? 'target-service',
            application: APP_LABEL ?? 'target-service',
            metric_label: {
              [METRIC_LABEL_NAME]: APP_LABEL ?? 'target-service',
            },
            metric_label_aliases: LABEL_ALIASES,
            prometheus: PROMETHEUS,
            actuator: TARGET,
            container: CONTAINER,
            repo: REPO,
            logs_dir: LOG_DIR,
            deploy_ledger: LEDGER,
            descriptor: DESCRIPTOR?.__file ?? '(built-in defaults)',
          },
          null,
          2,
        ),
      );
    }

    default:
      process.stdout.write(usage);
      process.exit(channel ? 1 : 0);
  }
}

main().catch((err) => die(err?.stack ?? String(err)));
