#!/usr/bin/env node
// Concurrent request generator for the incident lab.
//
// The in-container LoadDriver is deliberately sequential (@Scheduled fixedDelay,
// one request per tick), so it can never create connection-pool contention.
// Pool exhaustion needs real concurrency, which this provides from the host.
//
//   node incident/tools/load-hammer.mjs --concurrency 64 --duration 20
//   node incident/tools/load-hammer.mjs --concurrency 64 --duration 20 --path /api/orders/1

import http from 'node:http';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const concurrency = Number(opt('concurrency', 8));
const durationSec = Number(opt('duration', 10));
const path = opt('path', '/api/orders/1');
const host = opt('host', '127.0.0.1');
const port = Number(opt('port', 8080));

const statuses = new Map();
const latencies = [];
let started = 0;

function record(status, ms) {
  statuses.set(status, (statuses.get(status) ?? 0) + 1);
  latencies.push(ms);
}

function once(agent) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const req = http.request(
      { host, port, path, agent, headers: { connection: 'keep-alive' } },
      (res) => {
        res.resume();
        res.on('end', () => {
          record(res.statusCode, Number(process.hrtime.bigint() - t0) / 1e6);
          resolve();
        });
      },
    );
    req.on('error', (err) => {
      record(`ERR:${err.code ?? err.message}`, Number(process.hrtime.bigint() - t0) / 1e6);
      resolve();
    });
    req.end();
  });
}

async function worker(agent, deadline) {
  while (Date.now() < deadline) await once(agent);
}

const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency * 2 });
const deadline = Date.now() + durationSec * 1000;
const t0 = Date.now();
await Promise.all(Array.from({ length: concurrency }, () => worker(agent, deadline)));
agent.destroy();

const elapsed = (Date.now() - t0) / 1000;
latencies.sort((a, b) => a - b);
const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))]?.toFixed(1);
const total = latencies.length;
const summary = [...statuses.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s}=${n}`).join(' ');

process.stdout.write(
  `path=${path} concurrency=${concurrency} elapsed=${elapsed.toFixed(1)}s total=${total} rps=${(total / elapsed).toFixed(1)}\n` +
    `status: ${summary}\n` +
    `latency ms: p50=${pct(0.5)} p95=${pct(0.95)} p99=${pct(0.99)} max=${latencies.at(-1)?.toFixed(1)}\n`,
);
