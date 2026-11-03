#!/usr/bin/env node
// Read-only helper: pretty-print a Prometheus range query as ISO-timestamped rows.
const PROMETHEUS = process.env.PROMETHEUS_URL ?? 'http://127.0.0.1:9090';
const [promql, start, end, step = '30s'] = process.argv.slice(2);
const url = new URL('/api/v1/query_range', PROMETHEUS);
url.searchParams.set('query', promql);
url.searchParams.set('start', start);
url.searchParams.set('end', end);
url.searchParams.set('step', step);
const res = await fetch(url);
const out = await res.json();
const iso = (s) => new Date(s * 1000).toISOString().replace('.000Z', 'Z');
for (const r of out.data.result) {
  const labels = Object.entries(r.metric).map(([k, v]) => `${k}="${v}"`).join(',');
  console.log(`--- series ${labels || '(no labels)'} ---`);
  let prev = null;
  for (const [ts, val] of r.values) {
    const t = iso(ts);
    if (prev !== null) {
      const gap = ts - prev;
      if (gap > Number(step) * 2) console.log(`    ... GAP ${gap}s (${(gap / 60).toFixed(1)} min, no data) ...`);
    }
    console.log(`${t}  ${val}`);
    prev = ts;
  }
}
