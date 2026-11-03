#!/usr/bin/env node
/**
 * 简历包校验：把仓库外的成稿与仓库里的证据对账。
 *
 * 为什么要有这个：简历包在仓库外（`~/Desktop/文档/overleaf/miniclaw_incident相关/`），
 * 仓库里的证据改了它不会跟着改。2026-11-02 就出过这种事——通道审计口径修订后
 * 0738Z 的越界数由 9 变 10，包里还是 9，全靠人肉同步才没贴出去。
 *
 * 这个校验只查**可机械核对**的东西，不查文笔、不查「讲得好不好」：
 *   A 结构    必备文件在不在、台账能不能解析
 *   B 放行    正文每条 bullet 是否逐字来自 allowed_uses 含 resume_final 的 claim
 *   C 数字回指 包里的每个关键数字能不能在仓库证据里原样找到
 *   D 禁写    正文里有没有踩「无论怎么决定都不能写」那几条
 *   E 引用    台账里引用的仓库文件是否真的存在；正文有没有引用已作废的轮次
 *
 * 任何一条不过就 exit 1。**查不到就报错，不许静默跳过**——这条是这个工具存在的意义。
 *
 * 用法：node incident/runs/validate-resume-package.mjs [包目录]
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '../..');
const PKG =
  process.argv[2] ??
  '/home/fs-user/Desktop/文档/overleaf/miniclaw_incident相关';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function readRepo(rel) {
  const p = join(ROOT, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}
function readPkg(name) {
  const p = join(PKG, name);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

/** 正文 bullet：`- **标题** ……` 开头的一整行。 */
function bullets(md) {
  if (!md) return [];
  return md
    .split('\n')
    .filter((l) => /^- \*\*/.test(l))
    .map((l) => l.replace(/^- /, '').trim());
}

console.log(`简历包校验：${PKG}\n`);

// ---- A 结构 ------------------------------------------------------------
const REQUIRED = [
  'paste-ready-当前可贴.md',
  'paste-ready-最终版.md',
  'paste-ready-审计区.md',
  'claim-ledger.json',
];
const missing = REQUIRED.filter((f) => !existsSync(join(PKG, f)));
check(
  'A1 必备文件齐全',
  missing.length === 0,
  missing.length ? `缺：${missing.join('、')}` : REQUIRED.join('、'),
);

let ledger = null;
try {
  ledger = JSON.parse(readPkg('claim-ledger.json') ?? 'null');
  check('A2 台账可解析', !!ledger && Array.isArray(ledger.claims));
} catch (e) {
  check('A2 台账可解析', false, e.message);
}

if (!ledger) {
  console.log('\n台账都解析不了，后面的检查没有意义。');
  process.exit(1);
}

const claims = ledger.claims;

// ---- B 放行口径 --------------------------------------------------------
const finalizable = claims.filter(
  (c) =>
    Array.isArray(c.allowed_uses) && c.allowed_uses.includes('resume_final'),
);
const wording = new Set(
  finalizable.map((c) => (c.candidate_wording ?? '').trim()),
);
const bulletsNow = bullets(readPkg('paste-ready-当前可贴.md'));
const bulletsFinal = bullets(readPkg('paste-ready-最终版.md'));

check(
  'B1 当前可贴 有 bullet',
  bulletsNow.length > 0,
  `${bulletsNow.length} 条`,
);
check(
  'B2 最终版 有 bullet',
  bulletsFinal.length > 0,
  `${bulletsFinal.length} 条`,
);

const unmatched = [];
for (const b of [...bulletsNow, ...bulletsFinal]) {
  if (!wording.has(b.trim())) unmatched.push(b.slice(0, 40));
}
check(
  'B3 每条 bullet 逐字来自 resume_final claim 的 candidate_wording',
  unmatched.length === 0,
  unmatched.length
    ? `对不上：${unmatched.join(' / ')}`
    : `${bulletsNow.length + bulletsFinal.length} 条全部对得上`,
);

// 放行但没采用的 claim（001/004/005）不应出现在正文里——它们不在 wording 集合里，
// 上面那条检查已经覆盖；这里额外确认正文没有引用 pending claim。
const pendingIds = claims
  .filter((c) => c.verification_status !== 'confirmed')
  .map((c) => c.id);
const pendingInBody = pendingIds.filter((id) =>
  [...bulletsNow, ...bulletsFinal].some((b) => b.includes(id)),
);
check(
  'B4 正文没有引用未确认的 claim',
  pendingInBody.length === 0,
  pendingInBody.length
    ? `出现：${pendingInBody.join('、')}`
    : pendingIds.join('、') || '（无）',
);

// ---- C 数字回指 --------------------------------------------------------
const manifest0738 = JSON.parse(
  readRepo('incident/runs/round-manifest-2026-10-30T0738Z.json') ?? '{}',
);
const ca0738 = manifest0738.channel_audit ?? {};
const oosExpected = ca0738.out_of_surface;
const contamExpected = ca0738.contaminating;

const pkgText = REQUIRED.map((f) => readPkg(f) ?? '').join('\n');
const oosSeen = [...pkgText.matchAll(/(\d+)\s*次越界/g)].map((m) =>
  Number(m[1]),
);
const oosSet = [...new Set(oosSeen)];
check(
  'C1 包里的「N 次越界」与 0738Z manifest 一致',
  oosSet.length === 1 && oosSet[0] === oosExpected,
  `包内取值 ${JSON.stringify(oosSet)} / manifest out_of_surface=${oosExpected}`,
);

check(
  'C2 0738Z 污染数仍为 0',
  contamExpected === 0,
  `manifest contaminating=${contamExpected}`,
);

const review0738 = readRepo('incident/runs/audit-2026-10-30T0738Z.md');
const defectCount = review0738
  ? (review0738.match(/^### D\d+/gm) ?? []).length
  : null;
const defectSeen = [
  ...new Set(
    [...pkgText.matchAll(/(\d+)\s*处数字问题/g)].map((m) => Number(m[1])),
  ),
];
check(
  'C3 包里的「N 处数字问题」与复核件 §3 条数一致',
  defectCount !== null &&
    defectSeen.length === 1 &&
    defectSeen[0] === defectCount,
  `包内取值 ${JSON.stringify(defectSeen)} / 复核件 §3 = ${defectCount} 条`,
);

const report0738 = readRepo('incident/runs/agent-report-2026-10-30T0738Z.md');
check(
  'C4 受控对照数字 237 可回指到 0738Z 报告',
  !!report0738 && report0738.includes('237'),
  'agent-report-2026-10-30T0738Z.md',
);

const review0727 = readRepo('incident/runs/audit-2026-10-27T0727Z.md');
check(
  'C5 「23h55m」可回指到 0727Z 复核件',
  !!review0727 && review0727.includes('23h55m'),
  'audit-2026-10-27T0727Z.md',
);

// ---- D 禁写 ------------------------------------------------------------
const FORBIDDEN = [
  { re: /F5/, why: 'F5 连接池类资源故障不可观测' },
  {
    re: /MCP\s*Server|MCP 服务端/i,
    why: '只读通道交付形态是 CLI，不是 MCP Server',
  },
  {
    re: /向量(知识库|检索)|RAG/i,
    why: '底座是结构化知识表 + FTS5，不是向量库',
  },
  {
    re: /100\s*%\s*无泄漏|完全无干扰|无干扰环境/i,
    why: '101 观察窗混有前两轮容器活动（L1）',
  },
  { re: /贡献上游|实现了\s*Miniclaw\s*运行时/, why: '底座零改动' },
  { re: /完美排除|完全排除所有误判/, why: '报告有 5 处数字问题' },
  {
    re: /\d+(\.\d+)?\s*%\s*(准确率|命中率)/,
    why: 'claim-201 pending，无打分器',
  },
];
const bodyText = [...bulletsNow, ...bulletsFinal].join('\n');
const hits = FORBIDDEN.filter((f) => f.re.test(bodyText));
check(
  'D1 正文没有踩禁写清单',
  hits.length === 0,
  hits.length
    ? hits.map((h) => h.why).join('；')
    : `${FORBIDDEN.length} 条全过`,
);

// ---- E 引用 ------------------------------------------------------------
const sourceLocations = claims.flatMap((c) =>
  (c.sources ?? []).map((s) => ({ claim: c.id, loc: s.location ?? '' })),
);
const repoPaths = sourceLocations.filter(
  (s) => s.loc.startsWith('incident/') || s.loc.startsWith('docs/'),
);
// location 常在路径后面跟中文说明（「…/SKILL.md（报告契约段…）」），只取前导 ASCII 路径。
const missingFiles = repoPaths
  .map((s) => ({ ...s, path: (s.loc.match(/^[A-Za-z0-9._/-]+/) ?? [''])[0] }))
  .filter((s) => s.path && !existsSync(join(ROOT, s.path)));
check(
  'E1 台账引用的仓库文件都存在',
  missingFiles.length === 0,
  missingFiles.length
    ? missingFiles.map((m) => `${m.claim}→${m.path}`).join('、')
    : `${repoPaths.length} 条引用全部命中`,
);

const VOID_ROUNDS = ['2026-10-30T0350Z'];
const bodyVoid = VOID_ROUNDS.filter((stamp) => bodyText.includes(stamp));
check(
  'E2 正文没有把已作废轮次当证据',
  bodyVoid.length === 0,
  bodyVoid.length
    ? `出现：${bodyVoid.join('、')}`
    : `作废轮 ${VOID_ROUNDS.join('、')} 均未进正文`,
);

const manifestVoid = VOID_ROUNDS.map((s) =>
  JSON.parse(readRepo(`incident/runs/round-manifest-${s}.json`) ?? '{}'),
);
const voidStillValid = manifestVoid.filter((m) => m.round_valid === true);
check(
  'E3 作废轮在 manifest 里确实标记为无效',
  voidStillValid.length === 0,
  voidStillValid.length === 0
    ? VOID_ROUNDS.map((s) => `${s} round_valid=false`).join('、')
    : '作废轮竟被标成有效',
);

const failed = results.filter((r) => !r.ok);
console.log(
  failed.length === 0
    ? `\n简历包校验：${results.length}/${results.length} 通过`
    : `\n简历包校验：${results.length - failed.length}/${results.length} 通过（${failed
        .map((f) => f.name)
        .join('；')}）`,
);
process.exitCode = failed.length === 0 ? 0 : 1;
