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

const PROMETHEUS = process.env.PROMETHEUS_URL ?? 'http://127.0.0.1:9090';
const TARGET = process.env.TARGET_URL ?? 'http://127.0.0.1:8080';
const LOG_DIR = process.env.LOG_DIR ?? new URL('../logs/', import.meta.url).pathname;
const REPO = process.env.TARGET_REPO ?? new URL('../target-service/', import.meta.url).pathname;
const CONTAINER = process.env.TARGET_CONTAINER ?? 'target-service';

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

const usage = `incident-readonly <channel> [options]

channels (all read-only):
  metrics query   <promql>                  instant query against Prometheus
  metrics range   <promql> <start> <end> <step>   range query
  metrics alerts                               currently firing alerts
  metrics targets                              scrape target health
  logs   grep    <pattern> [--since ISO] [--until ISO] [--limit N] [--count]
  logs   first   <pattern> [--since ISO]     earliest occurrence after a timestamp
  git    log     [--since ISO] [--until ISO] [--limit N]
  git    diff    <ref> [--stat]              changes introduced by a commit
  git    show    <ref>                        commit metadata and changed files
  git    file    <ref>:<path>                 file content at a revision
  actuator <endpoint>                         GET a Spring Boot actuator endpoint
  runtime env                                 runtime knobs effective in the running container
  runtime started                             container start time and application readiness
`;

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
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
    return readdirSync(LOG_DIR)
      // "app.log" is the live file; "app.log.<date>.<n>[.gz]" are rotated
      // archives. Both are evidence -- an agent that can only see the live
      // file cannot prove what happened before the last restart.
      .filter((f) => f.endsWith('.log') || f.startsWith('app.log.'))
      .sort()
      .map((f) => join(LOG_DIR, f));
  } catch {
    die(`no log directory at ${LOG_DIR}`);
  }
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
        const out = await prom('/api/v1/query', { query: promql });
        return void console.log(JSON.stringify(out.data, null, 2));
      }
      if (op === 'range') {
        const [promql, start, end, step = '15s'] = args;
        if (!promql || !start || !end) die('usage: metrics range <promql> <start> <end> [step]');
        const out = await prom('/api/v1/query_range', {
          query: promql,
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
        return void console.log(JSON.stringify(out.data.activeTargets, null, 2));
      }
      return die(`unknown metrics op: ${op}`);
    }

    case 'logs': {
      const op = args.shift();
      const pattern = args.shift();
      if (!pattern) die('usage: logs <grep|first> <pattern> [--since ISO] [--until ISO] [--limit N] [--count]');
      const since = flag('since');
      const until = flag('until');
      const count = args.includes('--count');
      const limit = Number(flag('limit', op === 'first' ? '1' : '50'));
      const sinceMs = since ? Date.parse(since) : Number.NEGATIVE_INFINITY;
      const untilMs = until ? Date.parse(until) : Number.POSITIVE_INFINITY;
      if (Number.isNaN(sinceMs)) die(`--since is not a valid timestamp: ${since}`);
      if (Number.isNaN(untilMs)) die(`--until is not a valid timestamp: ${until}`);

      let lines = logFiles().flatMap((file) =>
        readLogText(file)
          .split('\n')
          .filter(Boolean)
          .map((text) => ({ text, ts: parseLogTimestamp(text) })),
      );
      lines = lines.filter((l) => l.ts >= sinceMs && l.ts <= untilMs && l.text.includes(pattern));
      lines.sort((a, b) => a.ts - b.ts);
      if (count) {
        return void console.log(String(lines.length));
      }
      const picked = op === 'first' ? lines.slice(0, 1) : lines.slice(0, limit);
      return void console.log(
        picked.length
          ? picked.map((l) => l.text).join('\n')
          : `(no match for ${JSON.stringify(pattern)} since ${since ?? 'beginning'})`,
      );
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
            return m ? `${m[1]}\t${new Date(m[2]).toISOString()}\t${m[3]}` : line;
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
        if (sep === -1) die(`expected <ref>:<path>, got ${JSON.stringify(spec)}`);
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
      const res = await fetch(`${TARGET}/actuator/${endpoint}`);
      const body = await res.text();
      if (!res.ok) die(`actuator ${endpoint} returned ${res.status}: ${body.slice(0, 400)}`);
      return void console.log(body);
    }

    case 'runtime': {
      const op = args.shift();
      const inspect = (format) => {
        try {
          return execFileSync('docker', ['inspect', CONTAINER, '--format', format], {
            encoding: 'utf8',
          }).trim();
        } catch (err) {
          die(`docker inspect ${CONTAINER} failed: ${err.stderr ?? err.message}`);
        }
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
        const raw = inspect('{{range .Config.Env}}{{println .}}{{end}}');
        const kv = new Map(
          raw
            .split('\n')
            .filter(Boolean)
            .map((line) => {
              const i = line.indexOf('=');
              return i === -1 ? [line, ''] : [line.slice(0, i), line.slice(i + 1)];
            }),
        );
        console.log(`container: ${CONTAINER}`);
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
        console.log(`container_started_at: ${inspect('{{.State.StartedAt}}')}`);
        console.log(
          `app_started_log: ${
            latestLogLine('Started TargetServiceApplication') ??
            '(no "Started ...Application" line found)'
          }`,
        );
        return;
      }

      return die(`unknown runtime op: ${op}`);
    }

    default:
      process.stdout.write(usage);
      process.exit(channel ? 1 : 0);
  }
}

main().catch((err) => die(err?.stack ?? String(err)));