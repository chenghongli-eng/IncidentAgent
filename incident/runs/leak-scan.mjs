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
 * 扫四个面（就是 Agent 能读到的全部）：
 *   1. 服务仓库工作树 + 完整 git 历史（`git log --all -p`）
 *   2. 工作区记忆（**含已删除条目**——`getWorkspaceMemory` 不过滤 status，
 *      软删的条目拿着 id 仍然能取回全文，见复核件 §6）
 *   3. 运行时 Skill 目录 `data/skills/<userId>/`
 *   4. Agent Profile（`agent_profiles` 表的四段 prompt）
 *
 * 用法：
 *   node incident/runs/leak-scan.mjs            # 打印报告，命中即 exit 1
 *   node incident/runs/leak-scan.mjs --quiet    # 只在有命中时打印
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
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

/**
 * 模式表。每条都写清「为什么它是答案」，否则后人加规则时会把正常内容当泄漏。
 * 注意区分**注释形态**与**代码形态**：
 * 代码里的 `order.put("ship_to", "UNKNOWN")` 是基线行为，Agent 本来就该看得见
 * （`git diff` 是设计好的证据通道）；注释里的 `to ship_to=UNKNOWN` 才是泄漏。
 */
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
};

const hits = [];
function scan(surface, label, text) {
  for (const { re, why } of PATTERNS[surface] ?? []) {
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
  console.log(`! Agent Profile 扫描跳过：${err.message}`);
}

// ---- 报告 ----
const surfaceName = {
  service: '服务仓库工作树',
  history: '服务仓库 git 历史',
  memory: '工作区记忆',
  skill: '运行时 Skill',
  profile: 'Agent Profile',
};
if (hits.length === 0) {
  if (!QUIET) {
    console.log('答案泄漏扫描：0 命中（服务仓库工作树 / git 历史 / 工作区记忆 / 运行时 Skill / Agent Profile）');
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
    + '> 当前取舍：保住证据链（SHA 不变），把历史残留如实记在复核件 §7；'
    + '**下一轮复跑前必须重建历史**（源文件已清干净，重建出来就是干净的），'
    + '并且 `leak-scan` 必须 0 命中才能开跑。',
  );
}
console.log('\n处理办法见 incident/runs/memory-de-leak.mjs 与 incident/RESUME.md「去泄漏」一节；'
  + '改完必须重跑本脚本。');
process.exit(blocking.length ? 1 : 1);
