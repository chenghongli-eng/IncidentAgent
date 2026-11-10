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
 * 扫十个面（Agent 能读到的，且**不构成答案键**的全部）：
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
 *   9. **聊天历史**（`messages` 表里本工作区所有 chat 的消息）
 *  10. **Pi 会话记录**（`data/sessions/<folder>/.claude/sessions/*.jsonl`）
 *
 * 【2026-10-30 补第 6 面】上一轮只扫前五个面，报了「0 命中」，
 * 而 Agent 实际上读了旋钮文件——那里面写着「F2 defect deployed but dormant
 * …… The next F4 round only turns DOWNSTREAM_TIMEOUT_MS to 1」，
 * 把故障编号和本轮设计直接交给了 Agent。**闸门漏掉一个面，报出来的
 * 「0 命中」就是假的**，这正是本脚本存在的理由：扫不到的面必须 exit 1，
 * 没扫的面也必须补上。
 *
 * 【2026-11-02 补第 9、10 面】这两面原来根本不在扫描面里，
 * 而它们恰恰是**上一轮答案的原文所在**：聊天历史里有上一轮的问题与
 * 根因报告，Pi 会话记录里有上一轮的完整对话。Agent 的 prompt 取的是
 * 「上次交互之后」的消息（`getMessagesSince(chatJid, lastAgentTimestamp)`），
 * 游标一旦缺失就整段灌进去；而且聊天表与 transcript 都在 Agent 能越界够到的
 * 磁盘上（0738Z 那轮越界读了 9 次）。
 *
 * 这两面用**结构性判据**（非空即阻断），不靠关键词表。理由是可验证的：
 * 0738Z 那份**完全正确**的报告里，`F2` 出现 0 次、`未判空`/`判空` 出现 0 次，
 * 它把机制写成散文——「user 9999 无 profile → 下游 404 → fetchProfile 返回 null
 * → OrderService.java:29 解引用 → NPE → 500」。**关键词表抓不住上一轮的答案**，
 * 所以这里只把关键词当附加线索（命中就给更具体的理由），阻断判据是「非空」。
 *
 * 任何一面扫不到（比如从错误的 CWD 跑，数据库定位不到），本脚本**不会**当作通过：
 * 会打印 `! 扫描跳过` 并 exit 1。静默跳过等于给出一个假的「0 命中」。
 *
 * 用法：
 *   node incident/runs/leak-scan.mjs            # 打印报告，命中即 exit 1
 *   node incident/runs/leak-scan.mjs --quiet    # 只在有命中时打印
 *   node incident/runs/leak-scan.mjs --real     # 真实靶子那一轮：换工作区、换答案词表
 *
 * `--real` 换掉三样东西：工作区 jid、源码面（靶子快照而不是合成夹具）、
 * 以及答案词表（旋钮名/取值，而不是夹具的 F2 缺陷机制）。
 * 沿用夹具那套词表会同时出两种错：漏（真实轮的答案扫不到）、
 * 误报（夹具 Profile 里正当出现的类名被当成泄漏）。
 *
 * ⚠️ 必须在**仓库根目录**跑：它用相对路径定位工作区、从 CWD 找数据库。
 *
 * ⚠️ 这是**开跑前**的闸门：第 9、10 面在闸门运行时必须为空。
 *    `run-round.mjs` 在扫描前会调 `POST /api/groups/:jid/clear-history`，
 *    那会连带清掉聊天历史、工作区记忆和 `data/sessions/<folder>/`；
 *    手工复跑要自己先清，否则这里会如实报「非空」。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';

const ROOT = new URL('../../', import.meta.url).pathname;
const require = createRequire(import.meta.url);

/** better-sqlite3 是可选依赖：缺了不能崩在这里，要走到扫描面时报「跳过」并 exit 1。 */
let Database = null;
try {
  Database = require('better-sqlite3');
} catch {
  Database = null;
}

const LAB_PATHS = JSON.parse(
  readFileSync(new URL('../lab-paths.json', import.meta.url), 'utf8'),
);
/**
 * 真实靶子这一轮扫的是**另一套面**。
 *
 * 合成夹具那套面是「夹具源码 + 夹具工作区 + 夹具故障词表」。真实这一轮
 * 的面是「靶子源码快照 + 靶子工作区 + 这一轮自己的答案词表」——
 * 沿用夹具那套会同时出两种错：扫不到真实轮次的答案（漏），
 * 以及把夹具 Profile 里正当出现的类名当成泄漏（误报）。
 * 误报比漏报更坏：闸门一直红，就没人再看它了。
 */
const REAL_MODE = process.argv.includes('--real');
const WORKSPACE_JID = REAL_MODE
  ? LAB_PATHS.realGroupJid
  : 'web:8ff36e4b-e8da-4dfd-be0a-b55d70fd9edb';
const USER_ID = '68fcc7c5-f8ca-4265-acd5-f215f5aa24a4';
const REPO =
  process.env.LEAK_SCAN_REPO ??
  (REAL_MODE ? LAB_PATHS.realRepoPath : LAB_PATHS.serviceDir);
const SKILL_DIR = join(ROOT, 'data/skills', USER_ID);
const QUIET = process.argv.includes('--quiet');

/**
 * 测试开关：把这几处指向别处，就能在**副本**上验证闸门的行为，
 * 不必为了跑负对照去动真实库、真实会话目录和真实靶子源码快照。
 * 不设就是真实路径；生产用法永远用默认值。
 *
 *   LEAK_SCAN_DB              数据库副本
 *   LEAK_SCAN_SESSIONS        会话目录副本
 *   LEAK_SCAN_REPO            源码面（工作树 + git 历史）
 *   LEAK_SCAN_REAL_TARGET_DIR 真实靶子启动脚本目录（--real 的旋钮面）
 */
const DB_PATH = process.env.LEAK_SCAN_DB ?? join(ROOT, 'data/db/messages.db');
const SESSIONS_ROOT =
  process.env.LEAK_SCAN_SESSIONS ?? join(ROOT, 'data/sessions');

/** 扫不到的面。空数组才允许报告「0 命中」——扫不到的面等于没扫。 */
const skipped = [];

/**
 * 本工作区（以及同 folder 的所有 jid）的 jid 集合。
 *
 * 聊天历史面与工作区记忆面都要用它：Agent 跑在哪个 jid 上，答案就可能落在哪个 jid 里。
 * 同 folder 的 Web / IM 绑定、以及 Runtime Session 的虚拟 jid 都要算进来。
 *
 * 顺带把 folder 记在模块级变量上——Pi 会话记录面要用它定位 data/sessions/<folder>/。
 */
let workspaceFolder = null;
function workspaceJidSet() {
  if (!Database) throw new Error('better-sqlite3 不可用');
  const raw = new Database(DB_PATH, { readonly: true });
  try {
    const grp = raw
      .prepare('SELECT folder FROM registered_groups WHERE jid = ?')
      .get(WORKSPACE_JID);
    workspaceFolder = grp?.folder ?? null;
    if (!workspaceFolder)
      throw new Error(`工作区 ${WORKSPACE_JID} 没有登记 folder`);
    const jids = new Set(
      raw
        .prepare('SELECT jid FROM registered_groups WHERE folder = ?')
        .all(workspaceFolder)
        .map((r) => r.jid),
    );
    for (const a of raw
      .prepare('SELECT chat_jid, id FROM agents WHERE group_folder = ?')
      .all(workspaceFolder)) {
      jids.add(`${a.chat_jid}#agent:${a.id}`);
    }
    return { folder: workspaceFolder, jids: [...jids] };
  } finally {
    raw.close();
  }
}

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
  {
    re: /\bF[1-8]\b/,
    why: '裸故障编号——编号本身就是在告诉 Agent 命中的是哪条故障',
  },
];

const PATTERNS = {
  history: [
    {
      re: /Fault[- ]F\d/i,
      why: '故障标签，等于把注入的故障编号直接交给 Agent',
    },
    { re: /fault F\d/i, why: '同上（小写形态）' },
    { re: /unchecked downstream/i, why: 'F2 机制的一句话摘要' },
    { re: /turns it into an NPE/i, why: '直接说明「故障会变成 NPE」' },
    {
      re: /to ship_to=UNKNOWN/i,
      why: '注释形态：描述被 F2 删掉的判空兜底（代码形态不算）',
    },
    { re: /degrades? (a|the|that) missing profile/i, why: '同上，另一种写法' },
    { re: /Fault-injection target/i, why: '实验台自曝身份' },
    {
      re: /removes this index/i,
      why: 'F1 标签（注入器里已经没有 F1 了，注释本身也是过期的）',
    },
    { re: /未判空/, why: '中文机制描述' },
  ],
  service: [
    {
      re: /Fault[- ]F\d/i,
      why: '故障标签，等于把注入的故障编号直接交给 Agent',
    },
    { re: /fault F\d/i, why: '同上（小写形态）' },
    { re: /unchecked downstream/i, why: 'F2 机制的一句话摘要' },
    { re: /turns it into an NPE/i, why: '直接说明「故障会变成 NPE」' },
    {
      re: /to ship_to=UNKNOWN/i,
      why: '注释形态：描述被 F2 删掉的判空兜底（代码形态不算）',
    },
    { re: /degrades? (a|the|that) missing profile/i, why: '同上，另一种写法' },
    { re: /Fault-injection target/i, why: '实验台自曝身份' },
    {
      re: /removes this index/i,
      why: 'F1 标签（注入器里已经没有 F1 了，注释本身也是过期的）',
    },
    { re: /未判空/, why: '中文机制描述' },
  ],
  memory: [
    { re: /Fault[- ]F\d/i, why: '故障标签' },
    { re: /unchecked downstream/i, why: '机制摘要' },
    { re: /to ship_to=UNKNOWN/i, why: '被 F2 删掉的兜底行为' },
    { re: /degrades? (a|the|that) missing profile/i, why: '同上' },
    { re: /未判空/, why: '中文机制描述' },
    {
      re: /OrderService|DownstreamClient|LoadDriver|loadOrder/,
      why: '具体类名/方法名——记忆里应该是方法与症状词汇，不是本场景的实体',
    },
    { re: /DOWNSTREAM_TIMEOUT_MS\s*[=:]\s*1\b/, why: '触发源旋钮的具体值' },
    {
      re: /\b(20|23)\s*(小时|h)\s*5[45]\s*分/,
      why: '直接给出部署间隔的结论（应由 Agent 自己算）',
    },
  ],
  skill: [
    { re: /Fault[- ]F\d/i, why: '故障标签' },
    { re: /unchecked downstream/i, why: '机制摘要' },
    { re: /to ship_to=UNKNOWN/i, why: '被 F2 删掉的兜底行为' },
    {
      re: /OrderService|DownstreamClient|LoadDriver|loadOrder/,
      why: 'Skill 是通用方法论，不该出现本场景的具体类名',
    },
    { re: /未判空/, why: '中文机制描述' },
  ],
  profile: [
    { re: /Fault[- ]F\d/i, why: '故障标签' },
    { re: /unchecked downstream/i, why: '机制摘要' },
    { re: /to ship_to=UNKNOWN/i, why: '被 F2 删掉的兜底行为' },
    {
      re: /OrderService|DownstreamClient|LoadDriver|loadOrder/,
      why: 'Profile 是方法论，不该出现本场景的具体类名',
    },
    { re: /DOWNSTREAM_TIMEOUT_MS\s*[=:]\s*1\b/, why: '触发源旋钮的具体值' },
  ],
  /**
   * 旋钮文件：Agent 在 2026-10-30 那一轮用 bash 直接读过它，
   * 并从注释里读到了故障编号和本轮设计。这一面必须扫。
   */
  knob: [
    {
      re: /\bfaults?\b|故障/i,
      why: '旋钮文件只写运维说明，不该出现「故障」字样',
    },
    {
      re: /\bdormant\b|\b潜伏\b|静默态|\bsilent\b/i,
      why: '不该描述台子的静默态设计——那是本轮要测的东西',
    },
    {
      re: /下一轮|下次|next round|next F\d/i,
      why: '不该描述实验计划——下一轮要做什么就是答案',
    },
    { re: /deployed but|已上线|已部署/i, why: '不该描述某个缺陷的部署状态' },
  ],
  /** Skill 源文件：Agent 用 bash 能直接读到，运行时副本干净不代表源文件干净。 */
  skillSrc: [
    { re: /Fault[- ]F\d/i, why: '故障标签' },
    { re: /unchecked downstream/i, why: '机制摘要' },
    { re: /to ship_to=UNKNOWN/i, why: '被 F2 删掉的兜底行为' },
    {
      re: /OrderService|DownstreamClient|LoadDriver|loadOrder/,
      why: 'Skill 是通用方法论，不该出现本场景的具体类名',
    },
    { re: /未判空/, why: '中文机制描述' },
  ],
  /** Profile 源文件：同上，运行时副本干净不代表源文件干净。 */
  profileSrc: [
    { re: /Fault[- ]F\d/i, why: '故障标签' },
    { re: /unchecked downstream/i, why: '机制摘要' },
    { re: /to ship_to=UNKNOWN/i, why: '被 F2 删掉的兜底行为' },
    {
      re: /OrderService|DownstreamClient|LoadDriver|loadOrder/,
      why: 'Profile 是方法论，不该出现本场景的具体类名',
    },
    { re: /DOWNSTREAM_TIMEOUT_MS\s*[=:]\s*1\b/, why: '触发源旋钮的具体值' },
  ],
  /**
   * 聊天历史与 Pi 会话记录：关键词只当**附加线索**。
   * 这两面真正的阻断判据是「非空」——上一轮的答案就在里面，
   * 而一份正确的报告会完全绕开这些关键词（0738Z 那份 `F2` 出现 0 次）。
   * 所以这里只列「即使出现在报告里也不正当」的写法：
   * 故障编号、机制摘要、实验台自曝身份。类名不算——正确诊断本来就该点名 OrderService。
   */
  chat: [
    { re: /Fault[- ]F\d/i, why: '故障标签——把注入的故障编号交给了下一轮' },
    { re: /unchecked downstream/i, why: 'F2 机制的一句话摘要' },
    { re: /turns it into an NPE/i, why: '直接说明「故障会变成 NPE」' },
    { re: /Fault-injection target/i, why: '实验台自曝身份' },
    {
      re: /deployed but|已上线|已部署/i,
      why: '描述了某个缺陷的部署状态——那是本轮要测的东西',
    },
  ],
  session: [
    { re: /Fault[- ]F\d/i, why: '故障标签——把注入的故障编号交给了下一轮' },
    { re: /unchecked downstream/i, why: 'F2 机制的一句话摘要' },
    { re: /turns it into an NPE/i, why: '直接说明「故障会变成 NPE」' },
    { re: /Fault-injection target/i, why: '实验台自曝身份' },
    {
      re: /deployed but|已上线|已部署/i,
      why: '描述了某个缺陷的部署状态——那是本轮要测的东西',
    },
  ],
};

/**
 * 真实靶子这一轮的答案词表（分两组，因为两类面的可信度不一样）。
 *
 * 这一轮的答案不是「某条缺陷的编号」，而是**运行时配置里的那个旋钮**：
 * 根因必须落在「健康检查的磁盘空间阈值被调到 50GB（进程环境变量）」这一层，
 * 并把制品/代码路径排除掉。所以盯的是旋钮名、旋钮取值和阈值措辞。
 *
 * 分两组是因为**误报比漏报更坏**：
 *   - 靶子自己的产物（源码工作树、git 历史）里可能合法地出现「50GB」这类字样；
 *     更要命的是靶子打包进去的 web 资源里有压缩过的 js，压缩代码里出现
 *     `R1` 这样的裸 token 是常事——拿裸编号去扫它，闸门会一直红，
 *     红久了的闸门就没人再看它了。
 *   - 实验室自己的面（记忆、聊天、会话、Skill、Profile、旋钮文件）里，
 *     出现裸的故障编号只可能来自实验室，那就是泄漏。
 */
const REAL_TARGET_ANSWER_WORDS = [
  {
    re: /MANAGEMENT_HEALTH_DISKSPACE_THRESHOLD/i,
    why: '这一轮故障旋钮的名字——出现即等于把触发源直接交给 Agent',
  },
  { re: /\b50\s*GB\b/, why: '这一轮旋钮的取值' },
  {
    re: /\b53687091200\b/,
    why: '阈值换算成字节后的值（actuator health 会报它，但那是证据，不是预置答案）',
  },
  { re: /磁盘空间阈值|磁盘阈值|空间阈值/, why: '真值与启动规格里的中文措辞' },
];

const REAL_LAB_ANSWER_WORDS = [
  ...REAL_TARGET_ANSWER_WORDS,
  {
    re: /\bR[1-9]\b/,
    why: '这一轮的故障编号——编号本身就是在告诉 Agent 命中的是哪条故障',
  },
];

/** 实验室自己的面：靶子产物之外的一切。 */
const LAB_SURFACES = new Set([
  'memory',
  'skill',
  'profile',
  'knob',
  'skillSrc',
  'profileSrc',
  'chat',
  'session',
]);

function patternsFor(surface) {
  if (!REAL_MODE) return [...COMMON, ...(PATTERNS[surface] ?? [])];
  return LAB_SURFACES.has(surface)
    ? REAL_LAB_ANSWER_WORDS
    : REAL_TARGET_ANSWER_WORDS;
}

const hits = [];
function scan(surface, label, text) {
  for (const { re, why } of patternsFor(surface)) {
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
  const history = execFileSync('git', ['log', '--all', '-p'], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 << 20,
  });
  scan('history', '<git log --all -p>', history);
}

// ---- 2. 工作区记忆（**含软删条目**）----
//
// 【2026-11-04 补缺口 ①】原来这里调的是 memory.listWorkspaceMemory，
// 而它只返回 status='active' 的条目——软删条目的正文它根本看不见。
// 但底座的 forget 只把 status 置成 'deleted'，正文原样留在表里：
// **扫不到不等于不在**，这正是「扫不到的面等于没扫」的那一类缺口。
// 之前靠 memory-de-leak.mjs 的 scrubTombstone 兜底，那是流程约定，不是闸门。
// 现在直接查表，不按 status 过滤：软删、superseded、conflicted 一起扫。
try {
  const { jids } = workspaceJidSet();
  const raw = new Database(DB_PATH, { readonly: true });
  try {
    const rows = raw
      .prepare(
        `SELECT workspace_jid, id, kind, status, title, content
           FROM workspace_memory_items
          WHERE workspace_jid IN (${jids.map(() => '?').join(',')})`,
      )
      .all(...jids);
    for (const row of rows) {
      scan(
        'memory',
        `memory:${row.workspace_jid}/${row.kind}/${row.status}/${row.id}`,
        `${row.title ?? ''}\n${row.content ?? ''}`,
      );
    }
  } finally {
    raw.close();
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
  if (!Database) throw new Error('better-sqlite3 不可用');
  const raw = new Database(DB_PATH, { readonly: true });
  const cols = raw
    .prepare('PRAGMA table_info(agent_profiles)')
    .all()
    .map((r) => r.name);
  const promptCols = [
    'identity_prompt',
    'soul_prompt',
    'agents_prompt',
    'tools_prompt',
  ].filter((c) => cols.includes(c));
  if (promptCols.length) {
    const rows = raw
      .prepare(`SELECT ${promptCols.join(',')} FROM agent_profiles`)
      .all();
    rows.forEach((row, i) => {
      for (const c of promptCols)
        scan('profile', `agent_profiles[${i}].${c}`, String(row[c] ?? ''));
    });
  }
  raw.close();
} catch (err) {
  skipped.push(`Agent Profile（${err.message}）`);
  console.log(`! Agent Profile 扫描跳过：${err.message}`);
}

// ---- 5. 旋钮文件（Agent 用 bash 直接读得到）----
//
// 真实这一轮**没有**夹具那种「旋钮文件」：故障旋钮写在启动规格里，
// 而启动规格是**答案键**（它自己就写着「这一轮的答案键的一半」），
// 所以它不进这个闸门的面——它由通道审计盯着（读到即污染）。
// 这一轮真正该干净的是**启动脚本**：旋钮必须由轮次编排在运行时经环境变量注入，
// 启动脚本里一旦写死了阈值，就等于把触发源烤进了「制品」里。
const KNOB_FILES = [
  process.env.LAB_ENV ?? join(homedir(), '.config/miniclaw-lab/lab.env'),
  join(ROOT, 'incident/lab.env.example'),
];
if (REAL_MODE) {
  const targetDir =
    process.env.LEAK_SCAN_REAL_TARGET_DIR ?? dirname(LAB_PATHS.realLaunchSpec);
  if (!existsSync(targetDir)) {
    skipped.push(`真实靶子启动脚本目录（${targetDir} 不存在）`);
    console.log(`! 真实靶子启动脚本扫描跳过：${targetDir} 不存在`);
  } else {
    for (const name of readdirSync(targetDir)) {
      if (name.endsWith('.sh')) KNOB_FILES.push(join(targetDir, name));
    }
  }
}
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

// ---- 8. 聊天历史（上一轮的问题与根因报告都在这里）----
// 阻断判据是**结构性**的：闸门运行时这个工作区的 chat 必须一条消息都没有。
// 关键词只能给出更具体的理由，抓不抓得住上一轮答案靠的是「非空」。
try {
  if (!Database) throw new Error('better-sqlite3 不可用');
  const raw = new Database(DB_PATH, { readonly: true });
  try {
    // 同 folder 的所有 jid（Web + IM 绑定）以及各 Runtime Session 的虚拟 jid 都要算进来。
    const list = workspaceJidSet().jids;
    const rows = raw
      .prepare(
        `SELECT chat_jid, timestamp, is_from_me, content FROM messages
          WHERE chat_jid IN (${list.map(() => '?').join(',')})
          ORDER BY timestamp`,
      )
      .all(...list);
    const perChat = new Map();
    for (const row of rows) {
      const bucket = perChat.get(row.chat_jid) ?? [];
      bucket.push(row);
      perChat.set(row.chat_jid, bucket);
    }
    for (const [chatJid, bucket] of perChat) {
      hits.push({
        surface: 'chat',
        label: `${chatJid}（${bucket.length} 条）`,
        why:
          '闸门运行时聊天历史非空——上一轮的问题与根因报告都还在里面。' +
          'Agent 的 prompt 取的是「上次交互之后」的消息（getMessagesSince(chatJid, 游标)），' +
          '游标一旦缺失就整段灌进上下文；而聊天表本身也在 Agent 越界够得到的磁盘上。' +
          '开跑前必须先 POST /api/groups/:jid/clear-history。',
        matched: `${bucket[0].timestamp} ${(bucket[0].content ?? '').replace(/\s+/g, ' ').slice(0, 80)}`,
        blocking: true,
      });
    }
    for (const row of rows) {
      scan(
        'chat',
        `${row.chat_jid}@${row.timestamp}`,
        String(row.content ?? ''),
      );
    }
  } finally {
    raw.close();
  }
} catch (err) {
  skipped.push(`聊天历史（${err.message}）`);
  console.log(`! 聊天历史扫描跳过：${err.message}`);
}

// ---- 9. Pi 会话记录（Agent 自己上一轮的完整对话）----
// clear-history 会把 data/sessions/<folder> 整个移走，所以闸门运行时
// 这个目录里不该有 .jsonl transcript。有 = 上一轮的对话原文还在。
try {
  if (!workspaceFolder)
    throw new Error('工作区 folder 未取到（聊天历史那一面没扫到）');
  const sessionDir = join(SESSIONS_ROOT, workspaceFolder, '.claude/sessions');
  const transcripts = existsSync(sessionDir)
    ? readdirSync(sessionDir).filter((f) => f.endsWith('.jsonl'))
    : [];
  for (const name of transcripts) {
    const file = join(sessionDir, name);
    const text = readFileSync(file, 'utf8');
    hits.push({
      surface: 'session',
      label: `${workspaceFolder}/.claude/sessions/${name}`,
      why:
        '闸门运行时会话记录还在——这是 Agent 上一轮的完整对话原文（提问、工具调用、' +
        '以及它自己写下的根因报告）。clear-history 会把 data/sessions/<folder> 整个移走，' +
        '所以这里出现 transcript 就说明清理没生效或根本没清。',
      matched: `${(text.length / 1024).toFixed(1)} KB`,
      blocking: true,
    });
    scan('session', `${workspaceFolder}/.claude/sessions/${name}`, text);
  }
} catch (err) {
  skipped.push(`Pi 会话记录（${err.message}）`);
  console.log(`! Pi 会话记录扫描跳过：${err.message}`);
}

// ---- 报告 ----
const surfaceName = REAL_MODE
  ? {
      service: '靶子源码快照工作树',
      history: '靶子源码 git 历史',
      memory: '工作区记忆',
      skill: '运行时 Skill',
      profile: 'Agent Profile',
      knob: '旋钮/启动脚本',
      skillSrc: 'Skill 源目录',
      profileSrc: 'Profile 源文件',
      chat: '聊天历史',
      session: 'Pi 会话记录',
    }
  : {
      service: '服务仓库工作树',
      history: '服务仓库 git 历史',
      memory: '工作区记忆',
      skill: '运行时 Skill',
      profile: 'Agent Profile',
      knob: '旋钮文件',
      skillSrc: 'Skill 源目录',
      profileSrc: 'Profile 源文件',
      chat: '聊天历史',
      session: 'Pi 会话记录',
    };
const SURFACE_LIST = Object.values(surfaceName).join(' / ');
if (hits.length === 0) {
  if (skipped.length) {
    console.log(
      `\n答案泄漏扫描：**不能报告 0 命中**——${skipped.length} 个面没扫到：\n` +
        skipped.map((s) => `  - ${s}`).join('\n') +
        '\n扫不到的面等于没扫。检查 CWD（必须在仓库根目录跑）与依赖文件是否存在。',
    );
    process.exitCode = 1;
  } else {
    if (!QUIET) {
      console.log(`答案泄漏扫描：0 命中（${SURFACE_LIST}）`);
    }
    process.exitCode = 0;
  }
}

if (hits.length > 0) {
  const blocking = hits.filter((h) => h.blocking);
  const historical = hits.filter((h) => !h.blocking);

  console.log(
    `答案泄漏扫描：**${hits.length} 处命中**（阻断 ${blocking.length}，历史残留 ${historical.length}）\n`,
  );
  for (const h of hits) {
    console.log(`  [${surfaceName[h.surface]}] ${h.label}`);
    console.log(`      命中：${h.matched}`);
    console.log(`      为什么是答案：${h.why}`);
  }
  if (historical.length) {
    console.log(
      '\n> 历史残留说明：git 历史里的命中**不是当前工作树的问题**，而是旧提交的内容' +
        '（或删除某行时 diff 里留下的原文）。清掉它必须重建整条提交链，' +
        '那会改掉审计件与台账引用的 SHA。\n' +
        '> 2026-10-30 已经这么做过一次：整条链重建为 `a9c8957 / 46ea5d5 / 3ca923c / 072d275`，' +
        '旧链打包存档在 `~/incident-lab-archive/service-repo-pre-rebuild.bundle`（旧 SHA 仍可解析、可审计）。\n' +
        '> 再遇到残留，同样用 `node incident/runs/rebuild-service-history.mjs` 重建，' +
        '并且 `leak-scan` 必须 0 命中才能开跑。',
    );
  }
  console.log(
    '\n处理办法见 incident/runs/memory-de-leak.mjs 与 incident/RESUME.md「去泄漏」一节；' +
      '改完必须重跑本脚本。',
  );
  // 任何命中都判失败：历史残留也算——「必须 0 命中才能开跑」。
  // 用 exitCode 而不是 process.exit()：管道里 process.exit() 会截断输出。
  process.exitCode = 1;
}
