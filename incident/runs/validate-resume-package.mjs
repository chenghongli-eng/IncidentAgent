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
 *              （含该 claim 的精简措辞 candidate_wording_compact）
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
  'paste-ready-精简版.md',
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

// 禁写清单在 B5 与 D1 都要用，先定义在这里。
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

// ---- B 放行口径 --------------------------------------------------------
const finalizable = claims.filter(
  (c) =>
    Array.isArray(c.allowed_uses) && c.allowed_uses.includes('resume_final'),
);
const wording = new Set();
for (const c of finalizable) {
  wording.add((c.candidate_wording ?? '').trim());
  if (c.candidate_wording_compact) {
    wording.add(c.candidate_wording_compact.trim());
  }
}
const bulletsNow = bullets(readPkg('paste-ready-当前可贴.md'));
const bulletsFinal = bullets(readPkg('paste-ready-最终版.md'));
const bulletsSlim = bullets(readPkg('paste-ready-精简版.md'));
const allBullets = [...bulletsNow, ...bulletsFinal, ...bulletsSlim];

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
for (const b of allBullets) {
  if (!wording.has(b.trim())) unmatched.push(b.slice(0, 40));
}
check(
  'B3 每条 bullet 逐字来自 resume_final claim 的 candidate_wording（或其精简措辞）',
  unmatched.length === 0,
  unmatched.length
    ? `对不上：${unmatched.join(' / ')}`
    : `${allBullets.length} 条全部对得上`,
);

// B5 精简措辞保真：精简是「重新措辞」，机器拦不住语义夸大，但能拦住数字。
// 规则：精简措辞必须短于原文、必须带人工复核说明、且它出现的每个数字都必须出自原文。
// 数字是简历上唯一能把「实测」变成「吹牛」的地方，所以这条比看起来重要。
const compactProblems = [];
for (const c of finalizable) {
  const k = c.candidate_wording_compact;
  if (!k) continue;
  const full = c.candidate_wording ?? '';
  const nums = (s) => new Set(s.match(/\d+(?:\.\d+)?/g) ?? []);
  const extra = [...nums(k)].filter((n) => !nums(full).has(n));
  if (extra.length) {
    compactProblems.push(`${c.id} 引入原文没有的数字：${extra.join('、')}`);
  }
  if (k.trim().length >= full.trim().length) {
    compactProblems.push(`${c.id} 精简措辞不短于原文`);
  }
  if (k.trim().length < 30) {
    compactProblems.push(`${c.id} 精简措辞过短`);
  }
  const forbidden = FORBIDDEN.filter((f) => f.re.test(k));
  if (forbidden.length) {
    compactProblems.push(
      `${c.id} 精简措辞踩禁写：${forbidden.map((f) => f.why).join('；')}`,
    );
  }
  if (!c.compact_review_note || !c.compact_review_note.trim()) {
    compactProblems.push(`${c.id} 精简措辞缺人工复核说明 compact_review_note`);
  }
}
check(
  'B5 精简措辞保真（数字不新增、不踩禁写、有复核说明）',
  compactProblems.length === 0,
  compactProblems.length
    ? compactProblems.join(' / ')
    : `${finalizable.filter((c) => c.candidate_wording_compact).length} 条精简措辞全过`,
);

// B6 精简版正文必须真的用上精简措辞，否则这个文件只是摆设。
check(
  'B6 精简版正文用的是精简措辞',
  bulletsSlim.length > 0 &&
    bulletsSlim.every((b) =>
      finalizable.some(
        (c) => (c.candidate_wording_compact ?? '').trim() === b.trim(),
      ),
    ),
  `${bulletsSlim.length} 条`,
);

// 放行但没采用的 claim（001/004/005）不应出现在正文里——它们不在 wording 集合里，
// 上面那条检查已经覆盖；这里额外确认正文没有引用 pending claim。
const pendingIds = claims
  .filter((c) => c.verification_status !== 'confirmed')
  .map((c) => c.id);
const pendingInBody = pendingIds.filter((id) =>
  allBullets.some((b) => b.includes(id)),
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

// C6 / C7：简历包里那批真实靶子的数字，要和仓库内的机器可读总表对得上。
//
// 为什么加这两条：103 那条 claim 的数字（几个独立样本、命中几轮、归因对几轮、
// 分层归因几轮）原先只能回指到**仓库外**的产物——公开仓库里查不到，
// 等于简历上挂了一串没人能核的数。`incident/runs/real-target-rounds.json`
// 把它们落成仓库内可读的总表，这里就拿它跟简历包对账。
// **查不到就报错，不许静默跳过**：总表缺失也算失败。
const summaryRaw = readRepo('incident/runs/real-target-rounds.json');
let summary = null;
let summaryProblem = null;
if (!summaryRaw) {
  summaryProblem = '缺 incident/runs/real-target-rounds.json';
} else {
  try {
    summary = JSON.parse(summaryRaw);
  } catch (e) {
    summaryProblem = `总表解析失败：${e.message}`;
  }
}

if (!summary) {
  check('C6 简历包的独立样本数字与仓库总表一致', false, summaryProblem);
  check('C7 简历包没有落后于总表的旧口径', false, summaryProblem);
} else {
  const totals = summary.totals ?? {};
  const ratios = summary.ratios ?? {};
  const knownRootCause = new Set(
    Object.values(ratios.root_cause ?? {}).map(String),
  );
  const knownAttribution = new Set(
    Object.values(ratios.deployment_attribution ?? {}).map(String),
  );

  const sampleSeen = [
    ...new Set([...pkgText.matchAll(/(\d+)\s*个独立样本/g)].map((m) => m[1])),
  ];
  const sampleBad = sampleSeen.filter(
    (n) => Number(n) !== Number(totals.independent_samples),
  );
  check(
    'C6 简历包的独立样本数字与仓库总表一致',
    sampleBad.length === 0,
    sampleSeen.length === 0
      ? '包内未出现独立样本数字（不校验）'
      : `包内取值 ${JSON.stringify(sampleSeen)} / 总表 ${totals.independent_samples}`,
  );

  const rcSeen = [
    ...new Set(
      [...pkgText.matchAll(/根因命中\s*(\d+)\s*\/\s*(\d+)/g)].map(
        (m) => `${m[1]}/${m[2]}`,
      ),
    ),
  ];
  const rcBad = rcSeen.filter((r) => !knownRootCause.has(r));
  check(
    'C6 简历包写的根因命中数与仓库总表一致',
    rcBad.length === 0,
    rcSeen.length === 0
      ? '包内未出现根因命中数字（不校验）'
      : `包内取值 ${JSON.stringify(rcSeen)} / 总表允许 ${JSON.stringify([...knownRootCause])}`,
  );

  const atSeen = [
    ...new Set(
      [...pkgText.matchAll(/发布归因\s*(\d+)\s*\/\s*(\d+)/g)].map(
        (m) => `${m[1]}/${m[2]}`,
      ),
    ),
  ];
  const atBad = atSeen.filter((r) => !knownAttribution.has(r));
  check(
    'C6 简历包写的发布归因数与仓库总表一致',
    atBad.length === 0,
    atSeen.length === 0
      ? '包内未出现发布归因数字（不校验）'
      : `包内取值 ${JSON.stringify(atSeen)} / 总表允许 ${JSON.stringify([...knownAttribution])}`,
  );

  const q2Seen = [
    ...new Set(
      [...pkgText.matchAll(/分层归因[^0-9]{0,8}(\d+)\s*\/\s*(\d+)/g)].map(
        (m) => `${m[1]}/${m[2]}`,
      ),
    ),
  ];
  const q2Bad = q2Seen.filter(
    (r) => r !== String(ratios.q2_layered_attribution),
  );
  check(
    'C6 简历包写的分层归因命中数与仓库总表一致',
    q2Bad.length === 0,
    q2Seen.length === 0
      ? '包内未出现分层归因数字（不校验）'
      : `包内取值 ${JSON.stringify(q2Seen)} / 总表 ${ratios.q2_layered_attribution}`,
  );

  // C7：总表已经跑出新结果，包里却还在说「重跑未执行」——那是**事实性过期**，
  // 不是措辞问题。过期必须报错，不能靠人记得同步。
  //
  // 扫描范围只取**正文 bullet 与台账措辞**：文件抬头里引用旧措辞是合法的
  // （比如成稿抬头写「已把原来的『重跑未执行』披露换成实测后的披露」），
  // 那是历史说明，不是当前口径。台账那几段要扫——它同样是当前口径的载体。
  const claimText = (ledger?.claims ?? [])
    .map((c) =>
      [
        c.candidate_wording,
        c.candidate_wording_compact,
        c.interview_details?.result,
        c.boundary,
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n');
  const currentText = [allBullets.join('\n'), claimText].join('\n');
  const STALE_MARKERS = [
    '修复后重跑未执行',
    '重跑未执行',
    '重跑批次待执行',
    '发布类命中率暂缺',
    '发布类的独立样本数与命中率目前未知',
  ];
  const staleHits = STALE_MARKERS.filter((m) => currentText.includes(m));
  check(
    'C7 简历包没有落后于总表的旧口径',
    staleHits.length === 0,
    staleHits.length === 0
      ? `总表口径：独立样本 ${totals.independent_samples}，命中 ${ratios.root_cause?.all}`
      : `包里仍写着旧口径：${staleHits.join('、')}；总表已是 ${totals.independent_samples} 个独立样本`,
  );
}

const review0727 = readRepo('incident/runs/audit-2026-10-27T0727Z.md');
check(
  'C5 「23h55m」可回指到 0727Z 复核件',
  !!review0727 && review0727.includes('23h55m'),
  'audit-2026-10-27T0727Z.md',
);

// ---- D 禁写 ------------------------------------------------------------
const bodyText = allBullets.join('\n');
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
