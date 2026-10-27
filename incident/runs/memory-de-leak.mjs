/**
 * 把工作区记忆里两行「带答案」的历史记录改成不带答案的形态。
 *
 * 背景：F4 对照组要考的是「Agent 从证据推出触发源」。工作区记忆里的
 * lesson / open_loop 两行把上一轮的结论原样写死了（失效机制、旋钮值、
 * 已死的 commit SHA），historical-incident-lookup 一召回就等于发答案。
 *
 * 处理：
 *   lesson     → 改写成只留方法（锚点口径、负证据、分层排查经验），去掉结论
 *   open_loop  → 状态已过期且同样带结论，整条 forget（软删 + 审计留痕）
 *
 * 走的是 Miniclaw 自己的 memory-service（版本、审计、FTS 索引同步更新），
 * 不是直接改 SQLite。
 */
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const distUrl = (name) => pathToFileURL(new URL(`../../dist/${name}`, import.meta.url).pathname).href;

const WORKSPACE_JID = 'web:8ff36e4b-e8da-4dfd-be0a-b55d70fd9edb';
const ACTOR = { id: '68fcc7c5-f8ca-4265-acd5-f215f5aa24a4', role: 'admin' };
const SOURCE_TYPE = 'web_user';

const LESSON_ID = 'wmi_f7d93ce7-8a80-4d91-a82e-3187a727646f';
const OPEN_LOOP_ID = 'wmi_c2530241-082b-4f32-bcdd-5dcc2d4c679d';

const LESSON_CONTENT = `target-service 过去多次出现 5xx。本条只留方法与症状词汇，不留任何一次故障的结论。

【症状词汇（用于按症状召回）】
这个服务过去的 5xx 表现为：NullPointerException、下游调用失败、下游调用异常、下游超时、订单接口报错、订单接口失败、HTTP 500、整体错误率抬升。

【锚点口径】
1. 「异常首次出现」要取首个导致 5xx 的异常，不是首个 ERROR 行——下游 404 的 ERROR 在故障前长期存在且无害。
2. 部署锚点用容器重建/应用就绪时刻，不要用 git commit 时间：commit 与实际生效可以差几分钟到几小时。
3. Prometheus v1 的 activeAt = 告警进入 pending 的时刻，不是 firing 时刻；firing = activeAt + for。
4. 5xx 比例表达式在没有 5xx 时整个序列不存在（分子序列缺失则表达式无值）。指标空洞本身就是「该期间无 500」的佐证；取负证据用 --count，不要自己数行数。

【分层排查的经验】
5. 只查 git 会漏掉运行时配置这一层：配置文件未必进版本库，容器实际生效的参数要以运行中容器的实际值为准。
6. 排除依赖类/资源类故障的依据：下游返回的是业务性 404 或超时异常（不是拒连）；连接池 active/pending/timeout 都在低位。
7. actuator 的 env / configprops 把值全掩码成 ******，只能证明配置项存在，不能证明生效值。

【怎么用这条记忆】
它描述的是过去怎么查，不是这次的结论。每次都要独立取证：把上一次的诱因套到这一次上，是最常见的误判。`;

const LESSON_PATCH = {
  title: 'target-service 5xx 定位方法：锚点口径与负证据怎么取',
  content: LESSON_CONTENT,
  canonicalKey: 'target-service.5xx.triage-method',
  status: 'active',
  importance: 0.7,
  confidence: 0.9,
};

const db = await import(distUrl('db.js'));
db.initDatabase();
const memory = await import(distUrl('memory-service.js'));

function forget(itemId, expectedRevision, reason) {
  const res = memory.forgetWorkspaceMemory({
    actor: ACTOR,
    workspaceJid: WORKSPACE_JID,
    sourceType: SOURCE_TYPE,
    itemId,
    expectedRevision,
    reason,
  });
  console.log(`forget ${itemId} -> status=${res.item.status} revision=${res.item.revision}`);
}

/**
 * forget 是软删：search 会按 status='active' 过滤掉它，
 * 但 getWorkspaceMemory 不看 status——拿着 id 仍能把原文整段取回来。
 * 10-26 那轮 Agent 正是 search 拿到 id、再 get 取全文的。
 * 所以 tombstone 的正文要一起清空，只留一条「为什么被作废」的说明。
 */
function scrubTombstone(itemId) {
  const Database = require('better-sqlite3');
  const raw = new Database(new URL('../../data/db/messages.db', import.meta.url).pathname);
  const row = raw
    .prepare(
      `SELECT title, content FROM workspace_memory_items WHERE id = ? AND status = 'deleted'`,
    )
    .get(itemId);
  if (!row) {
    raw.close();
    console.log(`scrub ${itemId} -> 没有已删条目，跳过`);
    return;
  }
  raw
    .prepare(
      `UPDATE workspace_memory_items
       SET title = ?, content = ?
       WHERE id = ? AND status = 'deleted'`,
    )
    .run(
      '[已作废的条目]',
      '本条在 2026-10-27 被作废：内容写死了当时故障的失效机制与运行时参数值，' +
        '召回它等于提前把答案发给诊断 Agent。作废原因与操作者见 workspace_memory_audit_events。',
      itemId,
    );
  raw.close();
  console.log(`scrub ${itemId} -> 正文已清空（原文 ${row.content.length} 字）`);
}

const lesson = memory
  .getWorkspaceMemory({ actor: ACTOR, workspaceJid: WORKSPACE_JID, itemId: LESSON_ID })
  .item;

if (lesson.content === LESSON_CONTENT) {
  console.log(`update ${LESSON_ID} -> 已是清理后的形态，跳过`);
} else {
  const updated = memory.updateWorkspaceMemory({
    actor: ACTOR,
    workspaceJid: WORKSPACE_JID,
    sourceType: SOURCE_TYPE,
    itemId: LESSON_ID,
    expectedRevision: lesson.revision,
    ...LESSON_PATCH,
  });
  console.log(
    `update ${LESSON_ID} -> title="${updated.item.title}" revision=${updated.item.revision}`,
  );
}

const openLoop = memory
  .getWorkspaceMemory({ actor: ACTOR, workspaceJid: WORKSPACE_JID, itemId: OPEN_LOOP_ID })
  .item;

if (openLoop.status === 'deleted') {
  console.log(`forget ${OPEN_LOOP_ID} -> 已作废，跳过`);
} else {
  forget(
    OPEN_LOOP_ID,
    openLoop.revision,
    '状态已过期（故障早已恢复）且内容写死了上一轮的失效机制与旋钮值，等于发答案；整条作废。',
  );
}

scrubTombstone(OPEN_LOOP_ID);
