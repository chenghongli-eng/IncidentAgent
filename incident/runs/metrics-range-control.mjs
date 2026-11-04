#!/usr/bin/env node
// Negative control for the L2 boundary: `metrics range` must refuse a window
// that ends in the future.
//
// Why this control exists: the 2026-11-03 round (0324Z) asked Prometheus for a
// range that ran three minutes past the execution moment. Prometheus does not
// answer "no data" for those steps -- it computes them from a truncated window,
// so the ratio collapses to 1/10 and 1/12. The agent read the artifact as a
// 9.9% 5xx spike and shipped it; the audit called it D1, a hard error.
//
// A boundary that is only described in a help text is a prompt, and the agent
// is not obliged to obey a prompt it can misread. The tool refuses instead.
// This control proves the refusal actually fires -- a gate that reports "no
// problem" for a case it never checked is the exact failure this lab exists
// to catch.
//
// Run from the repository root:
//     node incident/runs/metrics-range-control.mjs

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const cli = resolve(repoRoot, 'incident/workspace/tools/incident-readonly.mjs');

if (!existsSync(cli)) {
  console.error(`找不到被测工具：${cli}`);
  process.exit(1);
}

const NOW = Math.floor(Date.now() / 1000);

function run(args) {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

const cases = [];
let failed = 0;

function expectRefusal(name, args, needle) {
  const r = run(args);
  const refused = r.code !== 0 && r.err.includes(needle);
  cases.push({
    name,
    ok: refused,
    detail: `exit=${r.code} stderr=${r.err.trim().slice(0, 160)}`,
  });
  if (!refused) failed++;
}

// 1. unix-seconds end in the future -> refused
expectRefusal(
  'unix end in the future is refused',
  ['metrics', 'range', 'up', String(NOW - 600), String(NOW + 300), '60s'],
  'later than the current time',
);

// 2. RFC3339 end in the future -> refused
expectRefusal(
  'RFC3339 end in the future is refused',
  [
    'metrics',
    'range',
    'up',
    new Date((NOW - 600) * 1000).toISOString(),
    new Date((NOW + 300) * 1000).toISOString(),
    '60s',
  ],
  'later than the current time',
);

// 3. start after end -> refused
expectRefusal(
  'start after end is refused',
  ['metrics', 'range', 'up', String(NOW), String(NOW - 600), '60s'],
  'is later than end',
);

// 4. unparsable timestamp -> refused
expectRefusal(
  'unparsable start is refused',
  ['metrics', 'range', 'up', 'not-a-timestamp', String(NOW), '60s'],
  'cannot parse start',
);

// 5. a closed window is still accepted -- the gate must not be a blanket
//    refusal. This one needs a reachable Prometheus: if it is down the CLI
//    cannot answer, and the control says so instead of quietly passing.
{
  const r = run([
    'metrics',
    'range',
    'up',
    String(NOW - 600),
    String(NOW - 60),
    '60s',
  ]);
  let ok = r.code === 0;
  let detail = `exit=${r.code}`;
  if (!ok) {
    detail += ` stderr=${r.err.trim().slice(0, 200)}`;
    if (/ECONNREFUSED|fetch failed/i.test(r.err)) {
      detail += ' (Prometheus 不可达：这一项没有验成，不是通过)';
    }
  } else {
    try {
      const parsed = JSON.parse(r.out);
      ok = parsed && Array.isArray(parsed.result);
      detail = `exit=0 result=${Array.isArray(parsed?.result) ? `${parsed.result.length} series` : 'unparsed'}`;
    } catch {
      ok = false;
      detail = 'exit=0 but the output was not the expected JSON';
    }
  }
  cases.push({ name: 'a closed window is still accepted', ok, detail });
  if (!ok) failed++;
}

for (const c of cases) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  [${c.detail}]`);
}
console.log(`\n${cases.length - failed}/${cases.length} 通过`);

if (failed > 0) process.exit(1);
