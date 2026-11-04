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
 * 用法：node incident/runs/leak-scan-control.mjs
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '../..');
const SCAN = join(here, 'leak-scan.mjs');
const WORKSPACE_JID = 'web:8ff36e4b-e8da-4dfd-be0a-b55d70fd9edb';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** 跑一次扫描，返回 {code, out}。 */
function runScan(env) {
  const r = spawnSync(process.execPath, [SCAN], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 64 << 20,
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/**
 * 造一份可控的数据库副本：
 *   dirty=true  → 聊天历史里留一条消息（模拟「上一轮还在」）
 *   dirty=false → 把本工作区所有 chat 的消息删干净
 *   softDeleted=true → 留一条**软删**的工作区记忆（status='deleted'，正文还在）
 */
function fixtureDb(dir, dirty, softDeleted = false) {
  const dbPath = join(
    dir,
    `messages-${dirty ? 'dirty' : 'clean'}${softDeleted ? '-softdel' : ''}.db`,
  );
  copyFileSync(join(ROOT, 'data/db/messages.db'), dbPath);
  const db = new Database(dbPath);
  const folder = db
    .prepare('SELECT folder FROM registered_groups WHERE jid = ?')
    .get(WORKSPACE_JID)?.folder;
  if (!folder) throw new Error(`副本里找不到工作区 ${WORKSPACE_JID}`);
  const jids = [
    ...db
      .prepare('SELECT jid FROM registered_groups WHERE folder = ?')
      .all(folder)
      .map((r) => r.jid),
    ...db
      .prepare('SELECT chat_jid, id FROM agents WHERE group_folder = ?')
      .all(folder)
      .map((a) => `${a.chat_jid}#agent:${a.id}`),
  ];
  const placeholders = jids.map(() => '?').join(',');
  db.prepare(`DELETE FROM messages WHERE chat_jid IN (${placeholders})`).run(
    ...jids,
  );
  if (dirty) {
    db.prepare(
      `INSERT INTO messages (id, chat_jid, source_jid, sender, content, timestamp, is_from_me)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'ctl-fixture-1',
      WORKSPACE_JID,
      WORKSPACE_JID,
      'operator',
      'target-service 出现线上故障，Prometheus 的 HighServerErrorRate 告警已经 firing。',
      '2026-11-02T00:00:00.000Z',
      0,
    );
  }
  if (softDeleted) {
    // 底座的 forget 只把 status 置成 'deleted'，正文原样留在表里——
    // 这一行模拟的就是那种「调用方以为删掉了、其实正文还在」的状态。
    db.prepare(
      `INSERT INTO workspace_memory_items
         (id, store_id, workspace_jid, kind, title, content, canonical_key,
          status, importance, confidence, revision, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 'deleted', 0.5, 1.0, 1, ?, ?, ?)`,
    ).run(
      'ctl-softdel-1',
      db
        .prepare(
          'SELECT id FROM workspace_memory_stores WHERE workspace_jid = ?',
        )
        .get(WORKSPACE_JID)?.id ?? 'ctl-softdel-store',
      WORKSPACE_JID,
      'lesson',
      '软删条目',
      'Fault F2 的触发源是删掉判空兜底。',
      '2026-11-02T00:00:00.000Z',
      '2026-11-02T00:00:00.000Z',
      '2026-11-02T00:00:00.000Z',
    );
  }
  db.close();
  return dbPath;
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

const dir = mkdtempSync(join(tmpdir(), 'leak-scan-control-'));
try {
  const dirtyDb = fixtureDb(dir, true);
  const cleanDb = fixtureDb(dir, false);
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
    const softDelDb = fixtureDb(dir, false, true);
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
