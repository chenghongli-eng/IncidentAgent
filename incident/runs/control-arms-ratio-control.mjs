#!/usr/bin/env node
/**
 * 负对照：`parseMatrix` 认形状这件事，必须证明它**认得出**也**认不得**。
 *
 * 为什么要有这个：第一版控制臂脚本把 `metrics range` 的返回形状认成了
 * `{data:{result}}`，而只读 CLI 实际返回的是 Prometheus API 的 `data` 字段
 * （即 `{resultType,result:[...]}`）。解析不到就静默当成 0，于是 C 臂明明有
 * 161 个 500，表格上却写着「5xx 峰值 = 0」——**量具坏了，长得却像台子没炸**。
 *
 * 所以负对照要同时覆盖两头：
 *   ① 两种真实形状都要能解析出同一个峰值；
 *   ② 认不出的形状必须**抛错**，不能悄悄返回 0。
 *
 * 用法：node incident/runs/control-arms-ratio-control.mjs
 * 退出码：0 = 全部符合预期；1 = 有不符项。
 */
import { parseMatrix } from './control-arms.mjs';

/** 只读 CLI 实际返回的形状：Prometheus API 响应的 data 字段。 */
const RAW_PROM_SHAPE = {
  resultType: 'matrix',
  result: [
    {
      metric: {},
      values: [
        [1793778071.634, '0.4360205027379358'],
        [1793778101.634, '0.12'],
        [1793778131.634, '0.30'],
      ],
    },
  ],
};

/** 有些封装会再包一层 data。 */
const WRAPPED_SHAPE = { data: RAW_PROM_SHAPE };

const cases = [
  {
    name: 'A 原始 Prometheus 形状 → 峰值 0.436',
    run: () => parseMatrix(JSON.stringify(RAW_PROM_SHAPE)),
    expect: (r) =>
      Math.abs(r.max - 0.4360205027379358) < 1e-12 && r.points === 3,
  },
  {
    name: 'B 包一层的 data 形状 → 峰值同样是 0.436',
    run: () => parseMatrix(JSON.stringify(WRAPPED_SHAPE)),
    expect: (r) =>
      Math.abs(r.max - 0.4360205027379358) < 1e-12 && r.points === 3,
  },
  {
    name: 'C 认不出的形状必须抛错（不许静默当 0）',
    run: () => parseMatrix(JSON.stringify({ oops: true })),
    expectThrew: true,
  },
  {
    name: 'D result 不是数组也必须抛错',
    run: () => parseMatrix(JSON.stringify({ result: 'nope' })),
    expectThrew: true,
  },
  {
    name: 'E 合法形状但没有数据点 → 峰值 0、点数 0（不是抛错）',
    run: () =>
      parseMatrix(JSON.stringify({ resultType: 'matrix', result: [] })),
    expect: (r) => r.max === 0 && r.points === 0,
  },
];

let failed = 0;
for (const c of cases) {
  let ok = false;
  let detail = '';
  try {
    const r = c.run();
    if (c.expectThrew) {
      detail = '没有抛错';
    } else {
      ok = c.expect(r);
      detail = `max=${r.max} points=${r.points}`;
    }
  } catch (e) {
    if (c.expectThrew) {
      ok = true;
      detail = `按预期抛错：${e.message}`;
    } else {
      detail = `意外抛错：${e.message}`;
    }
  }
  if (!ok) failed++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${c.name} — ${detail}`);
}

console.log(
  failed
    ? `\n${failed} 项对照不符。`
    : `\n${cases.length}/${cases.length} 项对照通过。`,
);
process.exit(failed ? 1 : 0);
