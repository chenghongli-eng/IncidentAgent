#!/usr/bin/env node
/**
 * 给一份 Agent 诊断报告打分。
 *
 * 口径来自 docs/PRD.md §7.1：
 *   命中 1.0 / 部分命中 0.5 / 未命中 0.0
 *   命中     = 定位到同一模块 + 同一失效机制
 *   部分命中 = 定位到正确模块，但未识别具体机制
 *   未命中   = 定位到错误模块，或只复述症状
 *
 * 另外单独记一个 **deployment_attribution**（发布归因对不对）——
 * PRD §7.2 的论点靠的是「变更类准确率高、F1/F5/F6 这类低」，
 * 也就是说真正要测的量是「该跳过的发布有没有被跳掉」。
 *
 * 设计上刻意不做的事：
 *   - 不做黑箱判定。每条判据都要留下**命中片段**，人能逐条复核。
 *   - 不把"规则没匹配上"直接当成 Agent 答错。匹配不上的进 NEEDS_REVIEW，
 *     由人复核后可以带理由覆盖分数（--override "<判据id>=<分数>:理由"）。
 *     本项目的历史教训就是"数字与证据表不一致"。
 *
 * 用法：
 *   node incident/runs/score-report.mjs <report.md> <ground-truth.json>
 *   node incident/runs/score-report.mjs <report.md> <ground-truth.json> --json
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * 判据版本。
 *
 * v1 → v2 改的四处，都是同一个毛病：**判据量的是排版，不是诊断能力**。
 *   1. 切段：按契约标记（【根因假设】…）切，不再只认 markdown 标题。
 *      Skill 规定的报告格式是 ```text 围栏，照契约写的报告在 v1 下六个字段全判 NO_SECTION。
 *   2. C2 的「产出 null」：接受折叠成/变成/降级为/转成…null 等中文说法。
 *   3. Q3：数**条目**（bullet/编号项/表格行），不再数「排除」两个字。
 *   4. Q2：层级词表扩到触发源/触发因/触发条件/必要条件/前置缺陷/放大条件…，
 *      且取全文并要求至少两个不同的层级词（分层归因 = 至少分出两层）。
 *
 * 改完必须过 `calibrate-scorer.mjs`（5 个人工审计过的案例，一个都不能变）。
 *
 * v2 → v3 改的一处，同一个毛病：**判据量的是措辞，不是诊断能力**。
 *   C2 的「未判空」这一环原来只认 `判空|兜底|未判空|无判空` 四个词。
 *   2026-10-30T0738Z 那轮把同一个概念全程写成「null 保护」（含 A/B/C/E/F
 *   对照表的「有 null 保护 / 无 null 保护」），`判空|兜底` 出现 0 次，
 *   于是 C2 判 FAIL、整轮被打成 0.5（partial）——而那份报告把机制链、
 *   受控对照、发布归因全做对了。量的是同义词表，不是诊断能力。
 *
 *   改法：把这一环的词表从四个词扩到「null 守卫」这个概念的各种说法
 *   （null 保护/检查/校验、空值检查、直接解引用…），F2 与 F4 同步改。
 *   词表只扩到「守卫概念」，不扩到「任何提到 null」——否则 C2 会退化成
 *   「报告里出现过 null 就算识别了机制」。`calibrate-scorer.mjs` 里有一条例
 *   负对照：把 0738Z 报告里的守卫概念整段拿掉（其余一字不改，报告里仍有
 *   大把 null），C2 必须仍然 FAIL。
 *
 * 改完必须过 `calibrate-scorer.mjs`（人工审计过的案例，一个都不能变）。
 *
 * v3 → v4 改的两处，同一个毛病：**判据量的是排版，不是诊断能力**。
 *   1. 切段：除契约标记（【根因假设】…）外，也认**同名的 markdown 标题**
 *      （`## 根因假设`）。2026-11-02T0702Z 那轮的报告把六个字段写成
 *      markdown 标题、一个契约标记都没有 → 五个字段全判 NO_SECTION，
 *      整轮打成 0 分——而那份报告把机制链、受控负证据、发布归因全做对了。
 *      v2 已经把切段从「只认 markdown 标题」改成「认契约标记」，
 *      但那两种写法**都带【】**；不带【】的 markdown 标题一直切不出来。
 *      v4 补上这一支：标题只认**标题行**（`^#{1,6}\s+`，且不在代码围栏里），
 *      去掉标题修饰后**以字段名开头**才算。正文里提到「根因假设」不算数
 *      （负对照证明：没有结构的报告仍然是 0.0）。
 *      分数不再量排版，但**偏离契约这件事仍然可见**：
 *      分数文件里记 `section_style`（契约标记 / markdown 标题 / 混用 / 无）。
 *   2. C2 的「未判空」词表漏了「空值防护」。这张表本来就是「null 守卫」
 *      这个概念的枚举（null 保护/检查/校验/判断/防护、空值检查/空值判断/空判断），
 *      唯独漏掉「空值防护」——是枚举的疏漏，不是刻意的排除。
 *
 * **Q2 的层级词表没有改**：0702Z 那轮通篇写「机制」，
 * 从未区分「触发源 / 必要条件 / 放大条件」——判据本意（分层归因）它没满足，
 * 那是 Agent 错，不是判据错。
 *
 * 改完必须过 `calibrate-scorer.mjs`（人工审计过的案例，一个都不能变）。
 *
 * v4 → v5 改的一处，同一个毛病：**判据量的是措辞，不是诊断能力**。
 *   F2 的三条判据（C1 的两条 all_of、C1 的 all_of[1]、D1）原来都要求报告里出现
 *   `commit|提交|代码变更|重新引入|revert` 这几个**commit 侧**的字面量。
 *   但这些判据自己的名字叫「根因定位到代码变更（**发布**），并把它指认为致因」，
 *   F2 真值也写的是「最近一次**发布**就是触发源」。而同一份真值里的反向判据
 *   F2-D2 认 `发布|部署|上线`，F4 的 D1 也认 `发布|部署|上线`
 *   —— **只有 F2 这一族要求 commit 侧的词**，是这一族里的结构不对称。
 *
 *   后果实测得到：2026-11-02T0827Z 那轮把触发源写成「**部署** 5f144fa 删除了
 *   OrderService.loadOrder 中对下游 profile 为空的判空保护」，内容完全满足判据本意
 *   （根因落在代码变更上、落在发布上、指名了文件与方法、指名了它就是机制），
 *   模式却一个都没命中 → C1 FAIL、D1 FAIL → 整轮 0.0、发布归因 unclear。
 *
 *   改法：把「发布/部署/上线 + **变更动词**」也认作「提到了那次代码变更」。
 *   带变更动词是硬条件——光说「最近一次发布：08:45:20Z」不算数，
 *   必须说出这次发布**动了什么**（删除/引入/恢复/回退…）。
 *   这不是把判据放宽成空白支票，负对照证明：把「发布→变更」这条链抽掉的报告，
 *   C1 与 D1 仍然必须 FAIL。
 *
 *   **Q2 的层级词表仍然没改**：0827Z 那轮通篇只写「机制」，
 *   从未区分「触发源 / 必要条件 / 放大条件」——判据本意（分层归因）它没满足，
 *   那是 Agent 错，不是判据错。
 *
 *   改完必须过 `calibrate-scorer.mjs`（人工审计过的案例，一个都不能变）。
 */
const RUBRIC_VERSION = 'v5';

/**
 * 报告契约的固定字段。
 *
 * 按**契约标记**切段，不按 markdown 标题切。
 *
 * 为什么改：root-cause-report 这个 Skill 规定的报告格式就是一段 ```text 围栏，
 * 字段名用【】括起来。2026-10-30T0431Z 那轮照契约写在围栏里，
 * 旧实现只认 `^#+.*【…】`，六个字段一个都没切出来——判据全部 NO_SECTION，
 * 那一轮被打成 0 分。测的是排版，不是诊断能力。
 * 10-27 那轮把同样的字段写成了 markdown 标题，所以旧实现碰巧能用。
 *
 * 两种写法都认：标记行是标题还是围栏里的普通行，不影响切段。
 *
 * v4 再加一种：**同名 markdown 标题**（`## 根因假设`）。
 * 只认标题行（`^#{1,6}\s+`），且不在代码围栏里——
 * ```bash 块里的 `# 注释` 不是标题（0702Z 那轮的处置建议块里就有）。
 * 正文里提到「根因假设」不算数。
 */
const SECTION_MARKERS = [
  { name: 'root_cause', label: '【根因假设】', heading: '根因假设' },
  { name: 'support', label: '【支持证据】', heading: '支持证据' },
  { name: 'against', label: '【反对证据', heading: '反对证据' },
  { name: 'excluded', label: '【已排除的假设', heading: '已排除的假设' },
  { name: 'skipped', label: '【跳过的步骤', heading: '跳过的步骤' },
];

/** 只当分界、不单独成节的字段。 */
const BOUNDARY_LABELS = ['【处置建议'];
const BOUNDARY_HEADINGS = ['处置建议'];

/**
 * 标题归一：去掉 markdown 修饰与标点，只留可比较的字。
 *
 * '## 【已排除的假设及排除依据】' → '已排除的假设及排除依据'
 * '## 反对证据 / 尚未解释'        → '反对证据尚未解释'
 */
function normalizeHeading(text) {
  return text
    .replace(/^\s{0,3}#{1,6}\s*/, '')
    .replace(/[*`_]/g, '')
    .replace(/[【】（）()：:，,。.、；;！!？?|／/—–\-\s]/g, '');
}

/**
 * 找第一个「以 prefix 开头」的 markdown 标题行。
 *
 * 代码围栏里的行不算标题——处置建议块里的 `# 1) 回滚…` 是注释。
 */
function headingIndex(lines, prefix) {
  const target = normalizeHeading(prefix);
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if (!m) continue;
    if (normalizeHeading(m[1]).startsWith(target)) return i;
  }
  return -1;
}

function extractSections(text) {
  const out = {};
  const lines = text.split('\n');
  const firstAt = (label) => lines.findIndex((l) => l.includes(label));

  // 契约标记优先；没有标记才退到同名标题。
  // 记下每节是用哪种写法找到的——分数不量排版，但偏离契约要看得见。
  const styles = {};
  const startOf = (m) => {
    const byMarker = firstAt(m.label);
    if (byMarker >= 0) {
      styles[m.name] = 'contract-marker';
      return byMarker;
    }
    const byHeading = headingIndex(lines, m.heading);
    if (byHeading >= 0) styles[m.name] = 'markdown-heading';
    return byHeading;
  };

  const bounds = [
    ...SECTION_MARKERS.map(startOf),
    ...BOUNDARY_LABELS.map(firstAt),
    ...BOUNDARY_HEADINGS.map((h) => headingIndex(lines, h)),
  ].filter((i) => i >= 0);

  for (const m of SECTION_MARKERS) {
    const start = startOf(m);
    if (start === -1) {
      out[m.name] = null;
      continue;
    }
    // 段落结束于下一个契约标记（根因假设 / 支持证据 / … / 处置建议）
    let end = lines.length;
    for (const b of bounds) if (b > start && b < end) end = b;
    out[m.name] = lines.slice(start, end).join('\n');
  }

  out.sectionStyles = styles;

  // 锚点：先认标题；没有标题就退回「包含锚点二字的第一行」
  const anchorHeading = lines.findIndex((l) => /^#+\s*.*锚点/.test(l));
  if (anchorHeading >= 0) {
    const level = (lines[anchorHeading].match(/^#+/) || [''])[0].length;
    let end = lines.length;
    for (let i = anchorHeading + 1; i < lines.length; i += 1) {
      const m = lines[i].match(/^(#+)\s/);
      if (m && m[1].length <= level) {
        end = i;
        break;
      }
    }
    out.anchors = lines.slice(anchorHeading, end).join('\n');
  } else {
    const i = lines.findIndex((l) => l.includes('锚点'));
    out.anchors = i === -1 ? null : lines.slice(i).join('\n');
  }

  out.whole = text;
  return out;
}

/* 旧实现（按 markdown 标题切）保留在 git 历史里：
   它只认 `^#+.*【…】`，因此把照 Skill 契约写在 ```text 围栏里的报告判成「没有这一节」。
   判据量的是诊断能力，不是排版，所以改成按契约标记切。 */

const _legacySECTIONS = [
  { name: 'root_cause', re: /^#+\s*.*【根因假设】.*$/m, label: '【根因假设】' },
  { name: 'support', re: /^#+\s*.*【支持证据】.*$/m, label: '【支持证据】' },
  { name: 'against', re: /^#+\s*.*【反对证据.*】.*$/m, label: '【反对证据 / 尚未解释】' },
  { name: 'excluded', re: /^#+\s*.*【已排除的假设.*】.*$/m, label: '【已排除的假设及排除依据】' },
  { name: 'skipped', re: /^#+\s*.*【跳过的步骤.*】.*$/m, label: '【跳过的步骤及原因】' },
  { name: 'anchors', re: /^#+\s*.*锚点.*$/m, label: '三个锚点' },
  { name: 'whole', re: /^$/m, label: '整篇报告' },
];

function extractSectionsLegacy(text) {
  const out = {};
  const lines = text.split('\n');
  for (const sec of _legacySECTIONS) {
    if (sec.name === 'whole') {
      out.whole = text;
      continue;
    }
    let start = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (sec.re.test(lines[i])) {
        start = i;
        break;
      }
    }
    if (start === -1) {
      out[sec.name] = null;
      continue;
    }
    // 段落结束于下一个同级或更高级标题
    const headingLevel = (lines[start].match(/^#+/) || [''])[0].length;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      const m = lines[i].match(/^(#+)\s/);
      if (m && m[1].length <= headingLevel) {
        end = i;
        break;
      }
    }
    out[sec.name] = lines.slice(start, end).join('\n');
  }
  return out;
}

/* 旧实现保留用于对照：给校准脚本同时打新旧两套切段结果，
   确认「换了切段口径」没有改变任何一份历史报告的结论。 */
export { extractSectionsLegacy };

function findSnippet(text, pattern) {
  const re = new RegExp(pattern, 'i');
  const m = text.match(re);
  if (!m) return null;
  const idx = m.index ?? 0;
  const from = Math.max(0, idx - 40);
  const raw = text.slice(from, idx + m[0].length + 40).replace(/\s+/g, ' ').trim();
  return `…${raw}…`;
}

/**
 * 数一节里列了多少条目：bullet、编号项、表格数据行各算一条。
 *
 * 表格的识别：连续的 `|` 开头行里，第一行是表头、第二行是分隔行，
 * 其后都是数据行。分隔行长成 `|---|---|` 那样，去掉空白后全是
 * `|`、`-`、`:`、空格——表头里含中文，所以不会被误判成分隔行。
 */
function countItems(text) {
  const lines = text.split('\n');
  let bullets = 0;
  let numbered = 0;
  let rows = 0;
  let tableHeaderSeen = false;
  for (const line of lines) {
    const t = line.trim();
    if (/^[-*+•]\s+/.test(t)) { bullets += 1; continue; }
    if (/^\d+[.)]\s+/.test(t)) { numbered += 1; continue; }
    if (!t.startsWith('|')) { tableHeaderSeen = false; continue; }
    if (/^\|[\s:|-]*\|$/.test(t.replace(/\s/g, ''))) continue; // 分隔行
    if (!tableHeaderSeen) { tableHeaderSeen = true; continue; }  // 表头
    rows += 1;
  }
  const kinds = [
    bullets ? `bullet ${bullets}` : null,
    numbered ? `编号 ${numbered}` : null,
    rows ? `表格行 ${rows}` : null,
  ].filter(Boolean).join(' / ');
  return { count: bullets + numbered + rows, bullets, numbered, rows, kinds };
}

function runCheck(check, sections) {
  const scope = check.section ?? 'whole';
  const text = sections[scope];
  if (text === null) {
    return { id: check.id, name: check.name, scope, result: 'NO_SECTION', evidence: null };
  }
  const missing = [];
  const evidence = [];
  for (const p of check.all_of ?? []) {
    const hit = findSnippet(text, p);
    if (hit) evidence.push(hit);
    else missing.push(p);
  }
  const absent = [];
  for (const p of check.none_of ?? []) {
    if (findSnippet(text, p)) absent.push(p);
  }
  let result = 'PASS';
  if (missing.length || absent.length) result = 'FAIL';
  // min_count：同一模式至少要出现 N 次（例如"排除了 N 条假设"）
  if (check.min_count) {
    const { pattern, n } = check.min_count;
    const hits = text.match(new RegExp(pattern, 'gi')) ?? [];
    if (hits.length < n) {
      result = 'FAIL';
      missing.push(`${pattern} 出现 ${hits.length} 次 < ${n} 次`);
    } else {
      evidence.push(`（${pattern} 命中 ${hits.length} 次）`);
    }
  }
  // min_items：这一节至少列了 N 条目（列表项或表格数据行）。
  //
  // 为什么不用 min_count 数「排除」两个字：那是数**用词**，不是数**假设**。
  // 2026-10-30T0423Z 那轮把 6 条已排除假设写成 6 个 bullet，
  // 但每条都不带「排除」二字（写的是「发布不是起因」「下游服务宕机/不可用」），
  // 数用词只得 2，判 FAIL——判据测错了东西。
  // 数条目才对：bullet / 编号项 / 表格数据行都算一条。
  if (check.min_items) {
    const items = countItems(text);
    if (items.count < check.min_items) {
      result = 'FAIL';
      missing.push(`本节只列出 ${items.count} 条 < ${check.min_items} 条`);
    } else {
      evidence.push(`（本节列出 ${items.count} 条：${items.kinds}）`);
    }
  }
  return {
    id: check.id,
    name: check.name,
    scope,
    result,
    missing_patterns: missing,
    forbidden_hits: absent,
    evidence: evidence[0] ?? null,
    evidence_all: evidence,
  };
}

function scoreAccuracy(accuracy, sections) {
  const tiers = [
    ['hit', 1.0],
    ['partial', 0.5],
    ['miss', 0.0],
  ];
  const attempts = [];
  // 判据明细一律展示 hit 层的全集——它是实质判据表；tier 只决定分数。
  // 否则未命中时列出来的是 partial 的子集，看不出到底缺了哪一条机制。
  let hitResults = null;
  for (const [tier, value] of tiers) {
    const spec = accuracy?.[tier];
    if (!spec) continue;
    const results = (spec.all ?? []).map((c) => runCheck(c, sections));
    const passed = results.every((r) => r.result === 'PASS');
    attempts.push({ tier, value, results, passed });
    if (tier === 'hit') hitResults = results;
    if (passed) {
      return { score: value, tier, attempts, results: hitResults ?? results };
    }
  }
  const last = attempts[attempts.length - 1];
  return { score: 0.0, tier: 'miss', attempts, results: hitResults ?? last?.results ?? [] };
}

/**
 * 发布归因。要回答的是：**报告把「最近一次发布」当成了什么角色？**
 *
 *   verdict = 'excluded' → 报告说发布不是触发源
 *   verdict = 'relevant' → 报告说发布就是触发源
 *   verdict = 'unclear'  → 两种说法都有，或都看不出来（进人工复核）
 *
 * expected:
 *   'excluded' → 真值是「发布不是触发源」
 *   'relevant' → 真值是「发布就是触发源」
 *
 * expected='excluded' 而 verdict='relevant'，就是**过度归因**——
 * 这正是本项目要测的失败模式，必须能被指标表统计到。
 */
function scoreDeployment(expected, spec, sections) {
  const notTrigger = spec?.says_not_trigger ? runCheck(spec.says_not_trigger, sections) : null;
  const isTrigger = spec?.says_is_trigger ? runCheck(spec.says_is_trigger, sections) : null;
  const checks = [notTrigger, isTrigger].filter(Boolean);

  let verdict;
  if (!notTrigger && !isTrigger) {
    verdict = 'unclear';
  } else if (notTrigger?.result === 'PASS' && isTrigger?.result !== 'PASS') {
    verdict = 'excluded';
  } else if (isTrigger?.result === 'PASS' && notTrigger?.result !== 'PASS') {
    verdict = 'relevant';
  } else {
    verdict = 'unclear';
  }

  let correct;
  if (verdict === 'unclear') correct = 'unclear';
  else if (expected === 'excluded') correct = verdict === 'excluded' ? 'correct' : 'wrong';
  else correct = verdict === 'relevant' ? 'correct' : 'wrong';

  return { expected, verdict, correct, checks };
}

/**
 * 报告用了哪种写法分节：契约标记 / markdown 标题 / 混用 / 一个都没用上。
 *
 * 这不是判据，是**披露**：v4 起分数不再因为排版扣分，
 * 但偏离 `root-cause-report` 的契约这件事要在分数文件里看得见，
 * 否则「不量排版」就变成了「不承认排版」。
 */
function summarizeSectionStyle(styles) {
  const vals = Object.values(styles ?? {});
  if (!vals.length) return 'none';
  const kinds = new Set(vals);
  if (kinds.size > 1) return 'mixed';
  return vals[0];
}

/**
 * 给一份报告打完整分。抽出来是为了让 calibrate-scorer.mjs 能直接调用，
 * 而不是 fork 一个子进程再解析 stdout——那样断言的是「输出的形状」，
 * 不是「判据的结论」。
 */
export function scoreReport(report, truth, meta = {}) {
  const sections = extractSections(report);
  const accuracy = scoreAccuracy(truth.accuracy, sections);
  const deployment = scoreDeployment(
    truth.deployment_attribution?.expected,
    truth.deployment_attribution,
    sections,
  );
  const quality = (truth.quality ?? []).map((c) => runCheck(c, sections));

  // 需要人工复核的判据：有 FAIL，且报告里出现了近似表述
  const nearMiss = truth.near_miss_wording ?? [];
  const needsReview = [];
  for (const r of accuracy.results) {
    if (r.result !== 'FAIL') continue;
    const scope = sections[r.scope] ?? sections.whole;
    const near = nearMiss.filter((p) => findSnippet(scope, p));
    if (near.length) needsReview.push({ id: r.id, reason: `近似表述命中：${near.join(' / ')}` });
  }

  return {
    report: meta.reportPath ?? null,
    ground_truth: meta.truthPath ?? null,
    rubric_version: RUBRIC_VERSION,
    fault_id: truth.fault_id,
    fault_class: truth.fault_class,
    section_style: summarizeSectionStyle(sections.sectionStyles),
    root_cause_accuracy: accuracy.score,
    accuracy_tier: accuracy.tier,
    deployment_attribution: deployment.verdict,
    deployment_attribution_correct: deployment.correct,
    deployment_expected: deployment.expected,
    criteria: accuracy.results.map((r) => ({
      id: r.id,
      name: r.name,
      scope: r.scope,
      result: r.result,
      missing_patterns: r.missing_patterns,
      forbidden_hits: r.forbidden_hits,
      evidence: r.evidence,
    })),
    deployment_checks: deployment.checks.map((c) => ({
      id: c.id,
      name: c.name,
      result: c.result,
      evidence: c.evidence,
    })),
    quality: quality.map((c) => ({
      id: c.id,
      name: c.name,
      scope: c.scope,
      result: c.result,
      evidence: c.evidence,
    })),
    needs_review: needsReview,
  };
}

export { extractSections, runCheck, scoreAccuracy, scoreDeployment };

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [reportPath, truthPath, ...rest] = process.argv.slice(2);
  if (!reportPath || !truthPath) {
    console.error('usage: score-report.mjs <report.md> <ground-truth.json> [--json]');
    process.exit(2);
  }
  const asJson = rest.includes('--json');
  const report = readFileSync(reportPath, 'utf8');
  const truth = JSON.parse(readFileSync(truthPath, 'utf8'));
  const out = scoreReport(report, truth, { reportPath, truthPath });

  if (asJson) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(`\n=== 报告评分：${truth.fault_id}（${truth.fault_class}） ===`);
    console.log(`报告：${reportPath}`);
    console.log(`真值：${truth.title}`);
    console.log(`\nRoot Cause Accuracy：${out.root_cause_accuracy.toFixed(1)}（tier=${out.accuracy_tier}）`);
    console.log(`发布归因：${out.deployment_attribution}（真值要求 ${out.deployment_expected}）`);
    console.log('\n--- 判据明细 ---');
    for (const r of out.criteria) {
      console.log(`[${r.result}] ${r.id} ${r.name}`);
      if (r.result === 'FAIL') {
        if (r.missing_patterns?.length) console.log(`      未匹配：${r.missing_patterns.join(' | ')}`);
        if (r.forbidden_hits?.length) console.log(`      命中禁用：${r.forbidden_hits.join(' | ')}`);
      }
      if (r.evidence) console.log(`      证据：${r.evidence}`);
    }
    console.log('\n--- 发布归因判据 ---');
    for (const c of out.deployment_checks) {
      console.log(`[${c.result}] ${c.id} ${c.name}`);
      if (c.evidence) console.log(`      证据：${c.evidence}`);
    }
    if (out.quality.length) {
      console.log('\n--- 质量判据（不计入准确率） ---');
      for (const c of out.quality) {
        console.log(`[${c.result}] ${c.id} ${c.name}`);
        if (c.evidence) console.log(`      证据：${c.evidence}`);
      }
    }
    if (out.needs_review.length) {
      console.log('\n--- 需人工复核 ---');
      for (const n of out.needs_review) console.log(`  ${n.id}: ${n.reason}`);
    }
    console.log('');
  }
}
