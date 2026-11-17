#!/usr/bin/env node
// 给三个 incident 工作区装上沙箱配置。
//
// ── 为什么写脚本而不是手工改库 ──────────────────────────────────────────────
//
// 沙箱配置是**实验台的一部分**，不是随手敲进数据库的字符串：
//   · 放行路径来自 incident/sandbox/policy.json（唯一真相源）
//   · 三个工作区（夹具 / 真实靶 / 历史回放）必须用同一套策略
//   · 改策略要能重跑本脚本，而不是"记得去改一下数据库"
//
// 幂等：算出来的配置与库里的一样就不写。
//
// 用法：
//   node incident/sandbox/apply-sandbox.mjs            # 干跑，打印将要写入的内容
//   node incident/sandbox/apply-sandbox.mjs --apply    # 真写

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const POLICY = JSON.parse(readFileSync(join(HERE, 'policy.json'), 'utf8'));
const LAB_PATHS = JSON.parse(
  readFileSync(join(REPO_ROOT, 'incident/lab-paths.json'), 'utf8'),
);

const APPLY = process.argv.includes('--apply');
const DB_PATH = join(REPO_ROOT, 'data/db/messages.db');

/** 三个 incident 工作区。名字是识别依据，jid 只是给人看的。 */
const WORKSPACES = [
  { name: 'incident-lab', workspace: POLICY.workspaceRoots[0] },
  { name: 'incident-lab-real', workspace: POLICY.workspaceRoots[1] },
  { name: 'incident-replay-p1', workspace: POLICY.workspaceRoots[2] },
];

/**
 * 沙箱里的 PATH。
 *
 * 第一段是 docker shim 目录：沙箱里没有 docker socket，shim 是唯一入口，
 * 而它只能问靶子容器的两件事。其余是系统目录与 node 所在目录——PATH 里原来
 * 指向家目录的那些段（~/.pi/agent/bin 等）在沙箱里不存在，留着无害，但这里
 * 显式重写，免得"能不能跑起来"取决于家目录里碰巧有什么。
 */
const NODE_BIN_DIR = process.execPath.replace(/\/[^/]+$/, '');
const SANDBOX_PATH = [
  POLICY.shimBinDir,
  NODE_BIN_DIR,
  '/usr/local/sbin',
  '/usr/local/bin',
  '/usr/sbin',
  '/usr/bin',
  '/sbin',
  '/bin',
].join(':');

function sandboxSpec() {
  return {
    provider: 'bwrap',
    readablePaths: [POLICY.stateDir.replace(/\/run$/, '')],
    env: {
      PATH: SANDBOX_PATH,
      INCIDENT_FACTS_SOCKET: POLICY.factsSocket,
    },
  };
}

let Database = null;
try {
  Database = require('better-sqlite3');
} catch {
  console.error('better-sqlite3 不可用：装不了沙箱配置。');
  process.exit(1);
}

const db = new Database(DB_PATH);
const spec = sandboxSpec();

let changed = 0;
for (const target of WORKSPACES) {
  const row = db
    .prepare(
      'select jid, name, folder, execution_mode, custom_cwd, container_config from registered_groups where name = ?',
    )
    .get(target.name);
  if (!row) {
    console.error(`找不到工作区：${target.name}`);
    process.exit(1);
  }
  if (row.execution_mode !== 'host') {
    console.error(
      `工作区 ${target.name} 不是 host 模式（${row.execution_mode}）：沙箱配置只对 host 模式有意义`,
    );
    process.exit(1);
  }
  if (row.custom_cwd !== target.workspace) {
    console.error(
      `工作区 ${target.name} 的工作目录是 ${row.custom_cwd}，与策略里的 ${target.workspace} 不一致`,
    );
    process.exit(1);
  }

  let current = {};
  if (row.container_config) {
    try {
      current = JSON.parse(row.container_config);
    } catch {
      console.error(
        `工作区 ${target.name} 的 container_config 不是合法 JSON：先修好再装沙箱`,
      );
      process.exit(1);
    }
  }
  const next = { ...current, version: current.version ?? 1, hostSandbox: spec };
  const nextRaw = JSON.stringify(next);

  if (row.container_config === nextRaw) {
    console.log(`[skip] ${target.name}（${row.jid}）：已经是目标配置`);
    continue;
  }
  console.log(
    `[${APPLY ? 'write' : 'dry-run'}] ${target.name}（${row.jid} / folder=${row.folder}）`,
  );
  console.log(`  container_config → ${nextRaw}`);
  if (APPLY) {
    db.prepare(
      'update registered_groups set container_config = ? where jid = ?',
    ).run(nextRaw, row.jid);
    changed += 1;
  }
}

if (!APPLY) {
  console.log('\n干跑结束。加 --apply 真写。');
} else {
  console.log(`\n已写入 ${changed} 个工作区。`);
}
db.close();
