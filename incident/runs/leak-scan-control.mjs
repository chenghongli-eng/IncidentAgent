#!/usr/bin/env node
/**
 * leak-scan 的负对照：证明这个闸门**该拦的拦得住、该放的放得过、扫不到的不装没看见**。
 *
 * 为什么要有这个：闸门自己出错时，它报出来的一切都是假的。
 * 2026-10-30 那次「跑错目录 → 静默跳过 → 照样报 0 命中」是这个项目最贵的一次教训，
 * 当时的修法只是「跑错目录会 exit 1」，但没有任何东西保证它**以后**不会又漏一个面。
 * 所以对照必须是可复现的，不是靠人记得跑一次。
 *
 * 四条对照（全部在**副本**上跑，不碰真实库、不碰真实会话目录）：
 *   A 脏      → 必须 exit 1，且同时命中「聊天历史」与「Pi 会话记录」两个面
 *   B 净      → 必须 exit 0，报「0 命中」
 *   C 半脏    → 只清聊天、会话记录还在 → 必须 exit 1，且只剩会话记录一个面
 *               （证明两个面各自独立生效，不是靠其中一个盖住另一个）
 *   D 扫不到  → 数据库路径指向不存在的文件 → 必须 exit 1，且报「不能报告 0 命中」
 *
 * 六条对照（全部在**合成副本**上跑，不碰真实库、不碰真实会话目录）：
 *   A 脏      → 必须 exit 1，且同时命中「聊天历史」与「Pi 会话记录」两个面
 *   B 净      → 必须 exit 0，报「0 命中」
 *   C 半脏    → 只清聊天、会话记录还在 → 必须 exit 1，且只剩会话记录一个面
 *               （证明两个面各自独立生效，不是靠其中一个盖住另一个）
 *   D 扫不到  → 数据库路径指向不存在的文件 → 必须 exit 1，且报「不能报告 0 命中」
 *   E 软删记忆 → 必须 exit 1，且工作区记忆面命中
 *   F Profile → Profile 提示词里带故障标签 → 必须 exit 1，且 Agent Profile 面命中
 *
 * R 组（真实靶子那一轮，`--real`）：
 *   R1 靶子产物面 · 负对照   → 源码快照里出现旋钮名 → exit 1，命中靶子源码快照面
 *   R2 靶子产物面 · 近邻正对照 → 同一份快照，只差「压缩过的 web 资源里有裸 R1/R2 token」
 *                              → 必须 exit 0（这条最容易把闸门压成常年红）
 *   R3 实验室面 · 负对照     → 真实工作区记忆里出现旋钮名 → exit 1，命中工作区记忆面
 *   R4 实验室面 · 近邻正对照 → 同一块记忆，只差「只说 diskSpace DOWN，不说旋钮」→ exit 0
 *   R5 启动脚本面 · 负/正对照 → 启动脚本里写死旋钮 → exit 1；只写别的旋钮 → exit 0
 *   R6 真实靶子原样扫一遍     → 必须 exit 0（靶子自己的压缩资源含裸 R1 token，不能误报）
 *   R7 会话记录面             → 真实工作区残留 transcript → exit 1
 *   R8 Profile 面             → Profile 提示词里带本轮旋钮 → exit 1
 *
 * 用法：node incident/runs/leak-scan-control.mjs
 */
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '../..');
const SCAN = join(here, 'leak-scan.mjs');
const WORKSPACE_JID = 'web:8ff36e4b-e8da-4dfd-be0a-b55d70fd9edb';
const FIXTURE_FOLDER = 'flow-mvkttud1-ah1b';
const REAL_JID = 'web:b2cdce7e-ca92-4b3d-8ee8-b896f941b19a';
const REAL_FOLDER = 'flow-mwadjsxv-94da';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** 跑一次扫描，返回 {code, out}。 */
function runScan(env, args = []) {
  const r = spawnSync(process.execPath, [SCAN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 64 << 20,
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/**
 * 造一份**合成**的最小数据库：只含扫描器真正查得到的那几张表与列。
 *
 * 为什么不用真库的副本：
 *   - 真库里有用户的聊天内容，把它拷出去等于把数据带离它该在的地方；
 *   - 真库还在被服务写，只 copy 主库文件只能拿到已 checkpoint 的那部分
 *     （对照组里「副本里找不到工作区」就是这么来的）。
 * 合成库让这个对照**自足**：不碰任何真实数据，也不受线上状态影响。
 */
const SCHEMA = `
CREATE TABLE registered_groups (jid TEXT PRIMARY KEY, folder TEXT, name TEXT);
CREATE TABLE agents (id TEXT, chat_jid TEXT, group_folder TEXT);
CREATE TABLE workspace_memory_stores (id TEXT PRIMARY KEY, workspace_jid TEXT);
CREATE TABLE workspace_memory_items (
  id TEXT PRIMARY KEY, store_id TEXT, workspace_jid TEXT, kind TEXT,
  title TEXT, content TEXT, canonical_key TEXT, status TEXT,
  importance REAL, confidence REAL, revision INTEGER,
  created_at TEXT, updated_at TEXT, deleted_at TEXT);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, chat_jid TEXT, source_jid TEXT, sender TEXT,
  content TEXT, timestamp TEXT, is_from_me INTEGER);
CREATE TABLE agent_profiles (
  id TEXT PRIMARY KEY, name TEXT, identity_prompt TEXT, soul_prompt TEXT,
  agents_prompt TEXT, tools_prompt TEXT);
`;

let uniq = 0;
const uniqId = (prefix) => `${prefix}-${(uniq += 1)}`;

function syntheticDb(dir, name) {
  const dbPath = join(dir, `${name}.db`);
  rmSync(dbPath, { force: true });
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  db.prepare(
    'INSERT INTO registered_groups (jid, folder, name) VALUES (?, ?, ?)',
  ).run(WORKSPACE_JID, FIXTURE_FOLDER, 'incident-lab');
  db.prepare(
    'INSERT INTO registered_groups (jid, folder, name) VALUES (?, ?, ?)',
  ).run(REAL_JID, REAL_FOLDER, 'incident-lab-real');
  db.prepare(
    'INSERT INTO workspace_memory_stores (id, workspace_jid) VALUES (?, ?)',
  ).run('wms-fixture', WORKSPACE_JID);
  db.prepare(
    'INSERT INTO workspace_memory_stores (id, workspace_jid) VALUES (?, ?)',
  ).run('wms-real', REAL_JID);
  db.prepare(
    'INSERT INTO agents (id, chat_jid, group_folder) VALUES (?, ?, ?)',
  ).run('agent-fixture', WORKSPACE_JID, FIXTURE_FOLDER);
  db.prepare(
    'INSERT INTO agent_profiles (id, name, identity_prompt) VALUES (?, ?, ?)',
  ).run('profile-fixture', 'IncidentAgent', '你是实验室诊断 Agent。');
  db.close();
  return dbPath;
}

/** 塞一条聊天消息（模拟「上一轮还在」）。 */
function addMessage(dbPath, jid, content) {
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO messages (id, chat_jid, source_jid, sender, content, timestamp, is_from_me)
     VALUES (?, ?, ?, 'operator', ?, '2026-11-02T00:00:00.000Z', 0)`,
  ).run(uniqId('ctl-msg'), jid, jid, content);
  db.close();
}

/** 塞一条工作区记忆。status='deleted' 模拟「以为删了、正文还在」。 */
function addMemory(
  dbPath,
  jid,
  content,
  { status = 'active', title = 'ctl' } = {},
) {
  const db = new Database(dbPath);
  const store = db
    .prepare('SELECT id FROM workspace_memory_stores WHERE workspace_jid = ?')
    .get(jid)?.id;
  db.prepare(
    `INSERT INTO workspace_memory_items
       (id, store_id, workspace_jid, kind, title, content, canonical_key, status,
        importance, confidence, revision, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, 'lesson', ?, ?, NULL, ?, 0.5, 1.0, 1, ?, ?, ?)`,
  ).run(
    uniqId('ctl-mem'),
    store,
    jid,
    title,
    content,
    status,
    '2026-11-02T00:00:00.000Z',
    '2026-11-02T00:00:00.000Z',
    status === 'deleted' ? '2026-11-02T00:00:00.000Z' : null,
  );
  db.close();
}

/** 塞一份 Profile 提示词。 */
function addProfile(dbPath, name, prompt) {
  const db = new Database(dbPath);
  db.prepare(
    'INSERT INTO agent_profiles (id, name, identity_prompt) VALUES (?, ?, ?)',
  ).run(uniqId('ctl-profile'), name, prompt);
  db.close();
}

/** 造一份可控的会话目录：有就放一个 transcript，没有就空着。 */
function fixtureSessions(dir, dirty) {
  const root = join(dir, dirty ? 'sessions-dirty' : 'sessions-clean');
  const sessionDir = join(root, 'flow-mvkttud1-ah1b', '.claude', 'sessions');
  mkdirSync(sessionDir, { recursive: true });
  if (dirty) {
    writeFileSync(
      join(sessionDir, '2026-11-02T00-00-00-000Z_fixture.jsonl'),
      '{"type":"user","message":{"role":"user","content":"上一轮的提问"}}\n' +
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"上一轮写下的根因报告"}]}}\n',
      'utf8',
    );
  }
  return root;
}

/**
 * 造一份可控的源码面：一个**真的 git 仓库**。
 *
 * 必须是真仓库：扫描器要跑 `git log --all -p`，没有提交的话那一条会直接抛，
 * 对照自己先崩了，什么也证明不了。
 */
function syntheticRepo(dir, { leak }) {
  const repo = join(dir, leak ? 'repo-leak' : 'repo-clean');
  mkdirSync(join(repo, 'conf'), { recursive: true });
  mkdirSync(join(repo, 'web/static'), { recursive: true });
  // 压缩过的 web 资源：裸的 R1 / R2 token 是常事。
  // 真实靶子打包进去的资源里就有——所以真实那套词表**不能**拿裸编号去扫靶子产物，
  // 否则闸门常年红，红久了的闸门就没人再看它了。
  writeFileSync(
    join(repo, 'web/static/app.min.js'),
    'var a="R1",b="R2";function e(t,n){return t<1?n:e(t-1,n)}\n',
    'utf8',
  );
  // 只差一行：泄漏版写的是本轮的旋钮，干净版写的是一个**长得一样的别的旋钮**。
  writeFileSync(
    join(repo, 'conf/application.yml'),
    leak
      ? 'management:\n  health:\n    diskspace:\n      threshold: MANAGEMENT_HEALTH_DISKSPACE_THRESHOLD=50GB\n'
      : 'management:\n  health:\n    memspace:\n      threshold: MANAGEMENT_HEALTH_MEMSPACE_THRESHOLD=4GB\n',
    'utf8',
  );
  const git = (args) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
  git(['init', '-q']);
  git(['add', '-A']);
  git([
    '-c',
    'user.name=leak-scan-control',
    '-c',
    'user.email=control@example.invalid',
    'commit',
    '-qm',
    'synthetic snapshot',
  ]);
  return repo;
}

/** 造一份真实工作区的数据库：可选地在工作区记忆里放一行（泄漏或近邻）。 */
function realDb(dir, { memory } = {}) {
  const dbPath = syntheticDb(dir, `real-${memory ? 'dirty' : 'clean'}`);
  if (memory) {
    addMemory(dbPath, REAL_JID, memory, { title: '健康检查' });
  }
  return dbPath;
}

/** 造一份真实工作区的会话目录副本。 */
function realSessions(dir, { dirty }) {
  const root = join(dir, dirty ? 'real-sessions-dirty' : 'real-sessions-clean');
  const sessionDir = join(root, REAL_FOLDER, '.claude', 'sessions');
  mkdirSync(sessionDir, { recursive: true });
  if (dirty) {
    writeFileSync(
      join(sessionDir, '2026-11-10T00-00-00-000Z_fixture.jsonl'),
      '{"type":"user","message":{"role":"user","content":"上一轮的提问"}}\n',
      'utf8',
    );
  }
  return root;
}

/** 造一份真实靶子的启动脚本目录：可选地在启动脚本里写死本轮的旋钮。 */
function syntheticTargetDir(dir, { leak }) {
  const target = join(dir, leak ? 'target-leak' : 'target-clean');
  mkdirSync(target, { recursive: true });
  writeFileSync(
    join(target, 'start-ci-artifact-isolated.sh'),
    leak
      ? '#!/usr/bin/env bash\nexport MANAGEMENT_HEALTH_DISKSPACE_THRESHOLD=50GB\nexec java -jar app.jar\n'
      : '#!/usr/bin/env bash\nexport MANAGEMENT_HEALTH_MEMSPACE_THRESHOLD=4GB\nexec java -jar app.jar\n',
    'utf8',
  );
  return target;
}

const dir = mkdtempSync(join(tmpdir(), 'leak-scan-control-'));
try {
  const dirtyDb = syntheticDb(dir, 'messages-dirty');
  addMessage(
    dirtyDb,
    WORKSPACE_JID,
    'target-service 出现线上故障，Prometheus 的 HighServerErrorRate 告警已经 firing。',
  );
  const cleanDb = syntheticDb(dir, 'messages-clean');
  const dirtySessions = fixtureSessions(dir, true);
  const cleanSessions = fixtureSessions(dir, false);

  console.log('leak-scan 负对照：\n');

  // A 脏：两个面都要命中
  {
    const { code, out } = runScan({
      LEAK_SCAN_DB: dirtyDb,
      LEAK_SCAN_SESSIONS: dirtySessions,
    });
    const hitChat = out.includes('[聊天历史]');
    const hitSession = out.includes('[Pi 会话记录]');
    check(
      'A 脏状态 → exit 1，且聊天历史与会话记录两个面都命中',
      code === 1 && hitChat && hitSession,
      `exit=${code} 聊天历史=${hitChat} 会话记录=${hitSession}`,
    );
  }

  // B 净：必须放行
  {
    const { code, out } = runScan({
      LEAK_SCAN_DB: cleanDb,
      LEAK_SCAN_SESSIONS: cleanSessions,
    });
    check(
      'B 净状态 → exit 0，报 0 命中',
      code === 0 && out.includes('0 命中'),
      `exit=${code}`,
    );
  }

  // C 半脏：只清聊天，会话记录还在 → 只剩会话记录一个面
  {
    const { code, out } = runScan({
      LEAK_SCAN_DB: cleanDb,
      LEAK_SCAN_SESSIONS: dirtySessions,
    });
    const hitChat = out.includes('[聊天历史]');
    const hitSession = out.includes('[Pi 会话记录]');
    check(
      'C 只清聊天 → exit 1，且只剩会话记录一个面',
      code === 1 && !hitChat && hitSession,
      `exit=${code} 聊天历史=${hitChat} 会话记录=${hitSession}`,
    );
  }

  // D 扫不到：不能报 0 命中
  {
    const { code, out } = runScan({
      LEAK_SCAN_DB: join(dir, 'no-such.db'),
      LEAK_SCAN_SESSIONS: cleanSessions,
    });
    check(
      'D 数据库扫不到 → exit 1，报「不能报告 0 命中」',
      code === 1 && out.includes('不能报告 0 命中'),
      `exit=${code}`,
    );
  }

  // E 软删记忆：缺口 ① 的对照。
  // 这一行 status='deleted'，正文还在表里——旧扫描器只查 status='active'，
  // 所以它**扫不到**；补了直查表之后必须命中。
  // 如果这条又变回「exit 0」，说明缺口 ① 又回来了，而且没人发现。
  {
    const softDelDb = syntheticDb(dir, 'messages-softdel');
    addMemory(softDelDb, WORKSPACE_JID, 'Fault F2 的触发源是删掉判空兜底。', {
      status: 'deleted',
      title: '软删条目',
    });
    const { code, out } = runScan({
      LEAK_SCAN_DB: softDelDb,
      LEAK_SCAN_SESSIONS: cleanSessions,
    });
    const hitMemory = out.includes('[工作区记忆]');
    check(
      'E 软删记忆条目 → exit 1，且工作区记忆面命中',
      code === 1 && hitMemory,
      `exit=${code} 工作区记忆=${hitMemory}`,
    );
  }

  // F Profile 面：扫描器读的是 agent_profiles 的四段提示词，这一面也得有人看着。
  {
    const profileDb = syntheticDb(dir, 'messages-profile');
    addProfile(
      profileDb,
      'LeakyProfile',
      'Fault F2 defect deployed but dormant.',
    );
    const { code, out } = runScan({
      LEAK_SCAN_DB: profileDb,
      LEAK_SCAN_SESSIONS: cleanSessions,
    });
    const hitProfile = out.includes('[Agent Profile]');
    check(
      'F Profile 提示词里带故障标签 → exit 1，且 Agent Profile 面命中',
      code === 1 && hitProfile,
      `exit=${code} Profile=${hitProfile}`,
    );
  }

  // ---- R 组：真实靶子那一轮（--real）----
  {
    const cleanDb = realDb(dir, {});
    const dirtyDb = realDb(dir, {
      memory:
        '健康检查报 DOWN，原因是 MANAGEMENT_HEALTH_DISKSPACE_THRESHOLD=50GB 被写进了进程环境。',
    });
    const cleanSessions = realSessions(dir, { dirty: false });
    const dirtySessions = realSessions(dir, { dirty: true });
    const cleanRepo = syntheticRepo(dir, { leak: false });
    const leakRepo = syntheticRepo(dir, { leak: true });
    const cleanTarget = syntheticTargetDir(dir, { leak: false });
    const leakTarget = syntheticTargetDir(dir, { leak: true });
    const base = {
      LEAK_SCAN_DB: cleanDb,
      LEAK_SCAN_SESSIONS: cleanSessions,
      LEAK_SCAN_REPO: cleanRepo,
      LEAK_SCAN_REAL_TARGET_DIR: cleanTarget,
    };

    // R1 靶子产物面 · 负对照
    {
      const { code, out } = runScan({ ...base, LEAK_SCAN_REPO: leakRepo }, [
        '--real',
      ]);
      const hit = out.includes('[靶子源码快照工作树]');
      check(
        'R1 源码快照里出现本轮旋钮 → exit 1，且靶子源码快照面命中',
        code === 1 && hit,
        `exit=${code} 命中=${hit}`,
      );
    }

    // R2 靶子产物面 · 近邻正对照（同一份快照，只差旋钮名；还带裸 R1/R2 token）
    {
      const { code, out } = runScan(base, ['--real']);
      const clean = code === 0 && out.includes('0 命中');
      check(
        'R2 同一份快照只差旋钮名（且含裸 R1/R2 token）→ exit 0',
        clean,
        `exit=${code}`,
      );
    }

    // R3 实验室面（工作区记忆）· 负对照
    {
      const { code, out } = runScan({ ...base, LEAK_SCAN_DB: dirtyDb }, [
        '--real',
      ]);
      const hit = out.includes('[工作区记忆]');
      check(
        'R3 真实工作区记忆里出现本轮旋钮 → exit 1，且工作区记忆面命中',
        code === 1 && hit,
        `exit=${code} 命中=${hit}`,
      );
    }

    // R4 实验室面（工作区记忆）· 近邻正对照
    {
      const { code, out } = runScan(
        {
          ...base,
          LEAK_SCAN_DB: realDb(dir, {
            memory:
              '健康检查报过 diskSpace DOWN，free 26648506368，total 105241640960。',
          }),
        },
        ['--real'],
      );
      check(
        'R4 同一块记忆只差「不说旋钮」→ exit 0',
        code === 0,
        `exit=${code}`,
      );
    }

    // R5 启动脚本面 · 负对照与近邻正对照
    {
      const { code, out } = runScan(
        { ...base, LEAK_SCAN_REAL_TARGET_DIR: leakTarget },
        ['--real'],
      );
      const hit = out.includes('[旋钮/启动脚本]');
      check(
        'R5 启动脚本里写死本轮旋钮 → exit 1，且旋钮面命中',
        code === 1 && hit,
        `exit=${code} 命中=${hit}`,
      );
      const { code: code2 } = runScan(base, ['--real']);
      check('R5b 启动脚本只写别的旋钮 → exit 0', code2 === 0, `exit=${code2}`);
    }

    // R6 真实靶子原样扫一遍：靶子自己的压缩资源里含裸 R1 token，不能误报
    {
      const { code, out } = runScan({}, ['--real']);
      check(
        'R6 真实靶子原样扫 → exit 0，0 命中',
        code === 0 && out.includes('0 命中'),
        `exit=${code}`,
      );
    }

    // R7 会话记录面：真实工作区的会话必须为空
    {
      const { code, out } = runScan(
        { ...base, LEAK_SCAN_SESSIONS: dirtySessions },
        ['--real'],
      );
      const hit = out.includes('[Pi 会话记录]');
      check(
        'R7 真实工作区残留会话 transcript → exit 1，且会话记录面命中',
        code === 1 && hit,
        `exit=${code} 命中=${hit}`,
      );
    }

    // R8 Profile 面（真实模式）：Profile 提示词里出现本轮旋钮 → 必须命中
    {
      const profileDb = syntheticDb(dir, 'real-profile');
      addProfile(
        profileDb,
        'LeakyRealProfile',
        ' MANAGEMENT_HEALTH_DISKSPACE_THRESHOLD=50GB ',
      );
      const { code, out } = runScan({ ...base, LEAK_SCAN_DB: profileDb }, [
        '--real',
      ]);
      const hit = out.includes('[Agent Profile]');
      check(
        'R8 Profile 提示词里带本轮旋钮 → exit 1，且 Agent Profile 面命中',
        code === 1 && hit,
        `exit=${code} 命中=${hit}`,
      );
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(
  failed.length === 0
    ? `\nleak-scan 对照：${results.length}/${results.length} 通过`
    : `\nleak-scan 对照：${results.length - failed.length}/${results.length} 通过（${failed
        .map((f) => f.name)
        .join('；')}）`,
);
process.exit(failed.length === 0 ? 0 : 1);
