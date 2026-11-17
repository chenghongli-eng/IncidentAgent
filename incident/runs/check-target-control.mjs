#!/usr/bin/env node
/**
 * 交付体检（check-target.mjs）的负对照。
 *
 * 为什么必须有：交付体检是**给别的团队用的第一道门**。它要是坏了，
 * 长得却像「接入合格」，那比没有体检更糟——对方会照着一条假结论去接系统。
 *
 * 规矩（实验室通用，见 README.md）：
 *   · 每条负对照配一条**只差一个变量**的正对照。
 *   · 断言「某句话**不**出现」时，不能用一句输出里本来就有的合法内容。
 *
 * 本对照只测**判定层**（纯函数 renderReport / exitCodeFor / labPathFrom /
 * deliveryGates），不测真实系统——真实系统那部分由 target-preflight-control.mjs
 * 负责。两层分开测：判定层错了和真实环境坏了，是两种不同的故障。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  deliveryGates,
  exitCodeFor,
  labPathFrom,
  renderReport,
} from './check-target.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const GATES = [
  { id: 'P1', ok: true, title: '证据通道在位', detail: 'Prometheus 可查，actuator 返回 200' },
  { id: 'P2', ok: true, title: '日志由靶子持有', detail: '进程持有 2 个日志文件的写句柄' },
  { id: 'D0', ok: false, title: '本体里的观测 CLI 路径', detail: 'tools_prompt 里的 CLI 路径不存在' },
];

const PROFILE = {
  id: 'demo',
  prometheusUrl: 'http://127.0.0.1:9090',
  actuatorBaseUrl: 'http://127.0.0.1:8080',
  logsDir: '/tmp/logs',
  ledgerPath: '/tmp/ledger.jsonl',
};

console.log('交付体检判定层：负对照');

/* ── N1：一条没过，退出码必须是 1，且报告必须点名那条闸门 ───────────── */
{
  const code = exitCodeFor(GATES);
  const out = renderReport({ gates: GATES, profile: PROFILE });
  check('N1 未过的闸门 → 退出码 1', code === 1, `实际 ${code}`);
  check('N1 报告点名了失败的闸门 id', out.includes('[D0] FAIL'));
  check('N1 报告保留了失败原因', out.includes('CLI 路径不存在'));
  check('N1 结论写明有几条没过', out.includes('1 条未通过'));
}

/* ── P1（正对照）：只把 D0 的 ok 翻成 true，其余字面不变 ───────────── */
{
  const passing = GATES.map((g) => (g.id === 'D0' ? { ...g, ok: true } : g));
  const code = exitCodeFor(passing);
  const out = renderReport({ gates: passing, profile: PROFILE });
  check('P1 全部通过 → 退出码 0', code === 0, `实际 ${code}`);
  check('P1 结论写明全部通过', out.includes('全部通过'));
  // 否定断言用「未通过」这个词——它不可能出现在「全部通过」那句话里，
  // 也不在「结论：全部通过。这个靶子的接入可以进入下一阶段（跑一轮）。」里。
  check('P1 通过的报告里不含「未通过」', !out.includes('未通过'));
}

/* ── N2：空闸门列表必须判失败，不能判通过 ─────────────────────────── */
{
  const code = exitCodeFor([]);
  check('N2 空闸门列表 → 退出码 1', code === 1, `实际 ${code}`);
  check('N2 空闸门列表 → 退出码不是 0', code !== 0);
}

/* ── N3：闸门项缺 ok 字段（读取失败时可能发生）也算没过 ───────────── */
{
  const code = exitCodeFor([{ id: 'P1', title: 'x' }]);
  check('N3 缺 ok 字段的闸门 → 退出码 1', code === 1, `实际 ${code}`);
}

/* ── N4 / P2：LAB= 路径抠取，坏写法与好写法只差一个变量 ─────────────── */
{
  const good = labPathFrom('export LAB="/a/b/incident-readonly.mjs"');
  check('P2 抠出正确的 LAB 路径', good === '/a/b/incident-readonly.mjs', `实际 ${good}`);
  const bad = labPathFrom('这里没有 LAB= 这一行');
  check('N4 抠不出路径时返回 null', bad === null, `实际 ${bad}`);
}

/* ── P6 / N8：`LAB=` 里带解释器名的形态（本体里就是这个形态） ───────── */
{
  const withNode = labPathFrom('export LAB="node /a/b/incident-readonly.mjs"');
  check(
    'P6 带 `node ` 前缀时只取路径',
    withNode === '/a/b/incident-readonly.mjs',
    `实际 ${withNode}`,
  );
  // 只差一个变量：把 node 去掉，其余不动 → 同一结果
  const withoutNode = labPathFrom('export LAB="/a/b/incident-readonly.mjs"');
  check('P6 两种写法的路径相同', withNode === withoutNode);
}

/* ── N5 / P3：D0 必须认出「CLI 路径不存在」 ─────────────────────────── */
{
  const identity = {
    tools_prompt: 'LAB="/definitely/not/here/incident-readonly.mjs"',
  };
  const syncSource = "const PROFILE_ID = 'bbc54f27-afd9-454a-be99-842531057c43';";
  const gates = deliveryGates({ identity, syncSource, dbToolsPrompt: null });
  const d0 = gates.find((g) => g.id === 'D0');
  check('N5 D0 认出 CLI 路径不存在', d0 && d0.ok === false);
  check('N5 D0 的说明点名了那个路径', d0 && d0.detail.includes('/definitely/not/here'));

  // 正对照：同一个文件真实存在 → D0 过
  const identityOk = {
    tools_prompt: `LAB="${fileURLToPath(new URL('./check-target.mjs', import.meta.url))}"`,
  };
  const gatesOk = deliveryGates({ identity: identityOk, syncSource, dbToolsPrompt: null });
  const d0Ok = gatesOk.find((g) => g.id === 'D0');
  check('P3 D0 在路径真实存在时通过', d0Ok && d0Ok.ok === true);
}

/* ── N6 / P4：profile id 漂移必须被认出 ─────────────────────────────── */
{
  const identity = { tools_prompt: 'LAB="/x"' };
  const drifted = "const PROFILE_ID = '00000000-0000-0000-0000-000000000000';";
  const gates = deliveryGates({ identity, syncSource: drifted, dbToolsPrompt: null });
  const d1 = gates.find((g) => g.id === 'D1');
  check('N6 D1 认出 profile id 漂移', d1 && d1.ok === false);
  check('N6 D1 的说明里有两个 id', d1 && d1.detail.includes('00000000-0000-0000-0000-000000000000'));
}

/* ── N7 / P5：改了 JSON 没入库必须被认出 ───────────────────────────── */
{
  const identity = { tools_prompt: 'LAB="/x"' };
  const syncSource = "const PROFILE_ID = 'bbc54f27-afd9-454a-be99-842531057c43';";
  const gates = deliveryGates({ identity, syncSource, dbToolsPrompt: 'LAB="/y"' });
  const d2 = gates.find((g) => g.id === 'D2');
  check('N7 D2 认出「改了 JSON 没入库」', d2 && d2.ok === false);
  check('N7 D2 的说明指向同步脚本', d2 && d2.detail.includes('sync-agent-profile.mjs'));

  const gatesSame = deliveryGates({ identity, syncSource, dbToolsPrompt: identity.tools_prompt });
  const d2Ok = gatesSame.find((g) => g.id === 'D2');
  check('P5 D2 在已入库时通过', d2Ok && d2Ok.ok === true);
}

console.log('');
if (failures) {
  console.log(`交付体检负对照：${failures} 条红`);
  process.exit(1);
}
console.log('交付体检负对照：全绿');
