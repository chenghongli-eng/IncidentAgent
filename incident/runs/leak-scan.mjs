#!/usr/bin/env node
/**
 * 扫描 Agent 可读面上是否残留「答案」。
 *
 * 为什么需要它：2026-10-27 的干净复跑做完之后，我一度写下「取证环境无泄漏」。
 * 后来做全仓库扫描才发现 `data.sql` 的种子注释还留着半句
 * 「the service degrades a missing profile to ship_to=UNKNOWN」——
 * 那是**被 F2 缺陷删掉的判空兜底**的行为描述，Agent 读到后写进了报告。
 * 去泄漏那一步当时是**手工**做的，只清掉了显式的 `fault F2` 字样，
 * 没清掉「描述已删除行为」的残留。这正是「记得去泄漏」这种口头约定必然会漏的地方——
 * 所以改成跑一下就知道。
 *
 * 扫八个面（Agent 能读到的，且**不构成答案键**的全部）：
 *   1. 服务仓库工作树
 *   2. 服务仓库完整 git 历史（`git log --all -p`）
 *   3. 工作区记忆（**注意：`listWorkspaceMemory` 会过滤 `status='deleted'`，
 *      所以软删条目的正文其实不在本扫描范围内**——那一层靠
 *      `incident/runs/memory-de-leak.mjs` 的 `scrubTombstone` 兜底，
 *      不要把这个脚本当成 tombstone 的保障）
 *   4. 运行时 Skill 目录 `data/skills/<userId>/`
 *   5. Agent Profile（`agent_profiles` 表的四段 prompt）
 *   6. **旋钮文件** `~/.config/miniclaw-lab/lab.env` + `incident/lab.env.example`
 *   7. Skill 源目录 `incident/skills/`（Agent 用 bash 能直接读到，
 *      运行时副本干净不代表源文件干净）
 *   8. Profile 源文件 `incident/agent-profile/*.json`（同上）
 *
 * 【2026-10-30 补第 6 面】上一轮只扫前五个面，报了「0 命中」，
 * 而 Agent 实际上读了旋钮文件——那里面写着「F2 defect deployed but dormant
 * …… The next F4 round only turns DOWNSTREAM_TIMEOUT_MS to 1」，
 * 把故障编号和本轮设计直接交给了 Agent。**闸门漏掉一个面，报出来的
 * 「0 命中」就是假的**，这正是本脚本存在的理由：扫不到的面必须 exit 1，
 * 没扫的面也必须补上。
 *
 * 任何一面扫不到（比如从错误的 CWD 跑，数据库定位不到），本脚本**不会**当作通过：
 * 会打印 `! 扫描跳过` 并 exit 1。静默跳过等于给出一个假的「0 命中」。
 *
 * 用法：
 *   node incident/runs/leak-scan.mjs            # 打印报告，命中即 exit 1
 *   node incident/runs/leak-scan.mjs --quiet    # 只在有命中时打印
 *
 * ⚠️ 必须在**仓库根目录**跑：它用相对路径定位工作区、从 CWD 找数据库。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = new URL('../../', import.meta.url).pathname;
const require = createRequire(import.meta.url);
const distUrl = (name) => pathToFileURL(new URL(`../../dist/${name}`, import.meta.url).pathname).href;

const WORKSPACE_JID = 'web:8ff36e4b-e8da-4dfd-be0a-b55d70fd9edb';
const ACTOR = { id: '68fcc7c5-f8ca-4265-acd5-f215f5aa24a4', role: 'admin' };
const USER_ID = '68fcc7c5-f8ca-4265-acd5-f215f5aa24a4';
const REPO = join(ROOT, 'incident/workspace/target-service');
const SKILL_DIR = join(ROOT, 'data/skills', USER_ID);
const QUIET = process.argv.includes('--quiet');

/** 扫不到的面。空数组才允许报告「0 命中」——扫不到的面等于没扫。 */
const skipped = [];

/**
 * 模式表。每条都写清「为什么它是答案」，否则后人加规则时会把正常内容当泄漏。
 * 注意区分**注释形态**与**代码形态**：
 * 代码里的 `order.put("ship_to", "UNKNOWN")` 是基线行为，Agent 本来就该看得见
 * （`git diff` 是设计好的证据通道）；注释里的 `to ship_to=UNKNOWN` 才是泄漏。
 */
/**
 * 每一面都要查的通用模式。
 *
 * 【2026-10-30 新增裸故障编号】原来的规则只查 `Fault F2` / `fault F2` 这种
 * 带前缀的写法，漏掉了旋钮文件里的 `F2 defect deployed but dormant`——
 * 裸编号 `F2` 一样是在把答案交给 Agent。编号在受控面上没有正当出现场景，
 * 所以按裸编号查。
 */
const COMMON = [
  { re: /\bF[1-8]\b/, why: '裸故障编号——编号本身就是在告诉 Agent 命中的是哪条故障' },
];

const PATTERNS = {
  history: [
    { re: /Fault[- ]F\d/i, why: '故障标签，等于把注入的故障编号直接交给 Agent' },
    { re: /fault F\d/i, why: '同上（小写形态）' },
    { re: /unchecked downstream/i, why: 'F2 机制的一句话摘要' },
    { re: /turns it into an NPE/i, why: '直接说明「故障会变成 NPE」' },
    { re: /to ship_to=UNKNOWN/i, why: '注释形态：描述被 F2 删掉的判空兜底（代码形态不算）' },
    { re: /degrades? (a|the|that) missing profile/i, why: '同上，另一种写法' },
    { re: /Fault-injection target/i, why: '实验台自曝身份' },
    { re: /removes this index/i, why: 'F1 标签（注入器里已经没有 F1 了，注释本身也是过期的）' },
    { re: /未判空/, why: '中文机制描述' },
  ],
  service: [
    { re: /Fault[- ]F\d/i, why: '故障标签，等于把注入的故障编号直接交给 Agent' },
    { re: /fault F\d/i, why: '同上（小写形态）' },
    { re: /unchecked downstream/i, why: 'F2 机制的一句话摘要' },
    { re: /turns it into an NPE/i, why: '直接说明「故障会变成 NPE」' },
    { re: /to ship_to=UNKNOWN/i, why: '注释形态：描述被 F2 删掉的判空兜底（代码形态不算）' },
    { re: /degrades? (a|the|that) missing profile/i, why: '同上，另一种写法' },
    { re: /Fault-injection target/i, why: '实验台自曝身份' },
    { re: /removes this index/i, why: 'F1 标签（注入器里已经没有 F1 了，注释本身也是过期的）' },
    { re: /未判空/, why: '中文机制描述' },
  ],
  memory: [
    { re: /Fault[- ]F\d/i, why: '故障标签' },
    { re: /unchecked downstream/i, why: '机制摘要' },
    { re: /to ship_to=UNKNOWN/i, why: '被 F2 删掉的兜底行为' },
    { re: /degrades? (a|the|that) missing profile/i, why: '同上' },
    { re: /未判空/, why: '中文机制描述' },
    { re: /OrderService|DownstreamClient|LoadDriver|loadOrder/, why: '具体类名/方法名——记忆里应该是方法与症状词汇，不是本场景的实体' },
    { re: /DOWNSTREAM_TIMEOUT_MS\s*[=:]\s*1\b/, why: '触发源旋钮的具体值' },
    { re: /\b(20|23)\s*(小时|h)\s*5[45]\s*分/, why: '直接给出部署间隔的结论（应由 Agent 自己算）' },
  ],
  skill: [
    { re: /Fault[- ]F\d/i, why: '故障标签' },
    { re: /unchecked downstream/i, why: '机制摘要' },
    { re: /to ship_to=UNKNOWN/i, why: '被 F2 删掉的兜底行为' },
    { re: /OrderService|DownstreamClient|LoadDriver|loadOrder/, why: 'Skill 是通用方法论，不该出现本场景的具体类名' },
    { re: /未判空/, why: '中文机制描述' },
  ],
  profile: [
    { re: /Fault[- ]F\d/i, why: '故障标签' },
    { re: /unchecked downstream/i, why: '机制摘要' },
    { re: /to ship_to=UNKNOWN/i, why: '被 F2 删掉的兜底行为' },
    { re: /OrderService|DownstreamClient|LoadDriver|loadOrder/, why: 'Profile 是方法论，不该出现本场景的具体类名' },
    { re: /DOWNSTREAM_TIMEOUT_MS\s*[=:]\s*1\b/, why: '触发源旋钮的具体值' },
  ],
  /**
   * 旋钮文件：Agent 在 2026-10-30 那一轮用 bash 直接读过它，
   * 并从注释里读到了故障编号和本轮设计。这一面必须扫。
   */
  knob: [
    { re: /\bfaults?\b|故障/i, why: '旋钮文件只写运维说明，不该出现「故障」字样' },
    { re: /\bdormant\b|\b潜伏\b|静默态|\bsilent\b/i, why: '不该描述台子的静默态设计——那是本轮要测的东西' },
    { re: /下一轮|下次|next round|next F\d/i, why: '不该描述实验计划——下一轮要做什么就是答案' },
    { re: /deployed but|已上线|已部署/i, why: '不该描述某个缺陷的部署状态' },
  ],
  /** Skill 源文件：Agent 用 bash 能直接读到，运行时副本干净不代表源文件干净。 */
  skillSrc: [
    { re: /Fault[- ]F\d/i, why: '故障标签' },
    { re: /unchecked downstream/i, why: '机制摘要' },
    { re: /to ship_to=UNKNOWN/i, why: '被 F2 删掉的兜底行为' },
    { re: /OrderService|DownstreamClient|LoadDriver|loadOrder/, why: 'Skill 是通用方法论，不该出现本场景的具体类名' },
    { re: /未判空/, why: '中文机制描述' },
  ],
  /** Profile 源文件：同上，运行时副本干净不代表源文件干净。 */
  profileSrc: [
    { re: /Fault[- ]F\d/i, why: '故障标签' },
    { re: /unchecked downstream/i, why: '机制摘要' },
    { re: /to ship_to=UNKNOWN/i, why: '被 F2 删掉的兜底行为' },
    { re: /OrderService|DownstreamClient|LoadDriver|loadOrder/, why: 'Profile 是方法论，不该出现本场景的具体类名' },
    { re: /DOWNSTREAM_TIMEOUT_MS\s*[=:]\s*1\b/, why: '触发源旋钮的具体值' },
  ],
};

const hits = [];
function scan(surface, label, text) {
  for (const { re, why } of [...COMMON, ...(PATTERNS[surface] ?? [])]) {
    const m = re.exec(text);
    if (m) {
      hits.push({
        surface,
        label,
        why,
        matched: m[0].replace(/\s+/g, ' ').slice(0, 80),
        blocking: surface !== 'history',
      });
    }
  }
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// ---- 1. 服务仓库：工作树 + 完整历史 ----
if (existsSync(REPO)) {
  for (const file of walk(REPO)) {
    if (file.includes('/.git/')) continue;
    scan('service', relative(REPO, file), readFileSync(file, 'utf8'));
  }
  const history = execFileSync('git', ['log', '--all', '-p'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 << 20 });
  scan('history', '<git log --all -p>', history);
}

// ---- 2. 工作区记忆（含软删条目）----
try {
  const db = await import(distUrl('db.js'));
  db.initDatabase();
  const memory = await import(distUrl('memory-service.js'));
  const res = memory.listWorkspaceMemory({ actor: ACTOR, workspaceJid: WORKSPACE_JID, limit: 100 });
  for (const item of res.items ?? []) {
    scan('memory', `memory:${item.kind}/${item.status}/${item.id}`, `${item.title ?? ''}\n${item.content ?? ''}`);
  }
} catch (err) {
  skipped.push(`工作区记忆（${err.message}）`);
  console.log(`! 工作区记忆扫描跳过：${err.message}`);
}

// ---- 3. 运行时 Skill ----
for (const file of walk(SKILL_DIR)) {
  if (!file.endsWith('.md')) continue;
  scan('skill', relative(SKILL_DIR, file), readFileSync(file, 'utf8'));
}

// ---- 4. Agent Profile ----
try {
  const Database = require('better-sqlite3');
  const raw = new Database(join(ROOT, 'data/db/messages.db'), { readonly: true });
  const cols = raw.prepare('PRAGMA table_info(agent_profiles)').all().map((r) => r.name);
  const promptCols = ['identity_prompt', 'soul_prompt', 'agents_prompt', 'tools_prompt'].filter((c) => cols.includes(c));
  if (promptCols.length) {
    const rows = raw.prepare(`SELECT ${promptCols.join(',')} FROM agent_profiles`).all();
    rows.forEach((row, i) => {
      for (const c of promptCols) scan('profile', `agent_profiles[${i}].${c}`, String(row[c] ?? ''));
    });
  }
  raw.close();
} catch (err) {
  skipped.push(`Agent Profile（${err.message}）`);
  console.log(`! Agent Profile 扫描跳过：${err.message}`);
}

// ---- 5. 旋钮文件（Agent 用 bash 直接读得到）----
const KNOB_FILES = [
  process.env.LAB_ENV ?? join(homedir(), '.config/miniclaw-lab/lab.env'),
  join(ROOT, 'incident/lab.env.example'),
];
for (const file of KNOB_FILES) {
  if (!existsSync(file)) {
    skipped.push(`旋钮文件（${file} 不存在）`);
    console.log(`! 旋钮文件扫描跳过：${file} 不存在`);
    continue;
  }
  scan('knob', file, readFileSync(file, 'utf8'));
}

// ---- 6. Skill 源目录（Agent 用 bash 直接读得到）----
const SKILL_SRC = join(ROOT, 'incident/skills');
if (!existsSync(SKILL_SRC)) {
  skipped.push(`Skill 源目录（${SKILL_SRC} 不存在）`);
  console.log(`! Skill 源目录扫描跳过：${SKILL_SRC} 不存在`);
} else {
  for (const file of walk(SKILL_SRC)) {
    if (!file.endsWith('.md')) continue;
    scan('skillSrc', relative(SKILL_SRC, file), readFileSync(file, 'utf8'));
  }
}

// ---- 7. Profile 源文件（Agent 用 bash 直接读得到）----
const PROFILE_SRC = join(ROOT, 'incident/agent-profile');
if (!existsSync(PROFILE_SRC)) {
  skipped.push(`Profile 源目录（${PROFILE_SRC} 不存在）`);
  console.log(`! Profile 源目录扫描跳过：${PROFILE_SRC} 不存在`);
} else {
  for (const file of walk(PROFILE_SRC)) {
    if (!file.endsWith('.json')) continue;
    scan('profileSrc', relative(PROFILE_SRC, file), readFileSync(file, 'utf8'));
  }
}

// ---- 报告 ----
const surfaceName = {
  service: '服务仓库工作树',
  history: '服务仓库 git 历史',
  memory: '工作区记忆',
  skill: '运行时 Skill',
  profile: 'Agent Profile',
  knob: '旋钮文件',
  skillSrc: 'Skill 源目录',
  profileSrc: 'Profile 源文件',
};
const SURFACE_LIST = Object.values(surfaceName).join(' / ');
if (hits.length === 0) {
  if (skipped.length) {
    console.log(
      `\n答案泄漏扫描：**不能报告 0 命中**——${skipped.length} 个面没扫到：\n`
      + skipped.map((s) => `  - ${s}`).join('\n')
      + '\n扫不到的面等于没扫。检查 CWD（必须在仓库根目录跑）与依赖文件是否存在。',
    );
    process.exit(1);
  }
  if (!QUIET) {
    console.log(`答案泄漏扫描：0 命中（${SURFACE_LIST}）`);
  }
  process.exit(0);
}

const blocking = hits.filter((h) => h.blocking);
const historical = hits.filter((h) => !h.blocking);

console.log(`答案泄漏扫描：**${hits.length} 处命中**（阻断 ${blocking.length}，历史残留 ${historical.length}）\n`);
for (const h of hits) {
  console.log(`  [${surfaceName[h.surface]}] ${h.label}`);
  console.log(`      命中：${h.matched}`);
  console.log(`      为什么是答案：${h.why}`);
}
if (historical.length) {
  console.log(
    '\n> 历史残留说明：git 历史里的命中**不是当前工作树的问题**，而是旧提交的内容'
    + '（或删除某行时 diff 里留下的原文）。清掉它必须重建整条提交链，'
    + '那会改掉审计件与台账引用的 SHA。\n'
    + '> 2026-10-30 已经这么做过一次：整条链重建为 `a9c8957 / 46ea5d5 / 3ca923c / 072d275`，'
    + '旧链打包存档在 `~/incident-lab-archive/service-repo-pre-rebuild.bundle`（旧 SHA 仍可解析、可审计）。\n'
    + '> 再遇到残留，同样用 `node incident/runs/rebuild-service-history.mjs` 重建，'
    + '并且 `leak-scan` 必须 0 命中才能开跑。',
  );
}
console.log('\n处理办法见 incident/runs/memory-de-leak.mjs 与 incident/RESUME.md「去泄漏」一节；'
  + '改完必须重跑本脚本。');
process.exit(blocking.length ? 1 : 1);
