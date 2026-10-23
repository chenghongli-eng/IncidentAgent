#!/usr/bin/env node
// Read-only observation channels for IncidentAgent.
//
// Every subcommand here performs a read and nothing else. There is no verb in
// this file that mutates the target service, its data, or the git history — the
// boundary is enforced by the absence of write code, not by a prompt telling
// the agent to behave.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PROMETHEUS = process.env.PROMETHEUS_URL ?? 'http://127.0.0.1:9090';
const TARGET = process.env.TARGET_URL ?? 'http://127.0.0.1:8080';
const LOG_DIR = process.env.LOG_DIR ?? new URL('../logs/', import.meta.url).pathname;
const REPO = process.env.TARGET_REPO ?? new URL('../target-service/', import.meta.url).pathname;

const args = process.argv.slice(2);
const channel = args.shift();

const usage = `incident-readonly <channel> [options]

channels (all read-only):
  metrics query   <promql>                  instant query against Prometheus
  metrics range   <promql> <start> <end> <step>   range query
  metrics alerts                               currently firing alerts
  metrics targets                              scrape target health
  logs   grep    <pattern> [--since ISO] [--limit N]
  logs   first   <pattern> --since ISO        earliest occurrence after a timestamp
  git    log     [--since ISO] [--until ISO] [--limit N]
  git    diff    <ref> [--stat]              changes introduced by a commit
  git    show    <ref>                        commit metadata and changed files
  actuator <endpoint>                         GET a Spring Boot actuator endpoint
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

function git(...argv) {
  try {
    return execFileSync('git', argv, { cwd: REPO, encoding: 'utf8', maxBuffer: 8 << 20 });
  } catch (err) {
    die(`git ${argv.join(' ')} failed: ${err.stderr ?? err.message}`);
  }
}

function logFiles() {
  try {
    return readdirSync(LOG_DIR)
      .filter((f) => f.endsWith('.log'))
      .sort()
      .map((f) => join(LOG_DIR, f));
  } catch {
    die(`no log directory at ${LOG_DIR}`);
  }
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
      if (!pattern) die('usage: logs <grep|first> <pattern> [--since ISO] [--limit N]');
      const since = flag('since');
      const limit = Number(flag('limit', op === 'first' ? '1' : '50'));
      const sinceMs = since ? Date.parse(since) : Number.NEGATIVE_INFINITY;
      if (Number.isNaN(sinceMs)) die(`--since is not a valid timestamp: ${since}`);

      let lines = logFiles().flatMap((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((text) => ({ text, ts: Date.parse(text.slice(0, 23)) })),
      );
      lines = lines.filter((l) => l.ts >= sinceMs && l.text.includes(pattern));
      lines.sort((a, b) => a.ts - b.ts);
      const picked = op === 'first' ? lines.slice(0, 1) : lines.slice(0, limit);
      return void console.log(
        picked.length
          ? picked.map((l) => l.text).join('\n')
          : `(no match for ${JSON.stringify(pattern)} since ${since ?? 'beginning'})`,
      );
    }

    case 'git': {
      const op = args.shift();
      const fmt = { log: '--pretty=format:%H%x09%ad%x09%an%x09%s', date: 'iso-strict' };
      if (op === 'log') {
        const argv = ['log', fmt.log, `--date=${fmt.date}`];
        for (const [name, flagName] of [['since', 'since'], ['until', 'until']]) {
          const v = flag(name);
          if (v) argv.push(`--${flagName}=${v}`);
        }
        argv.push(`-n${flag('limit', '20')}`);
        return void console.log(git(...argv));
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
        return void console.log(
          git('show', '--stat', '--pretty=fuller', `--date=${fmt.date}`, ref),
        );
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

    default:
      process.stdout.write(usage);
      process.exit(channel ? 1 : 0);
  }
}

main().catch((err) => die(err?.stack ?? String(err)));