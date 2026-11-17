#!/usr/bin/env node
/**
 * 沙箱就位检查（run-round.mjs 的 P13 闸门）。
 *
 * 为什么单独成文件：
 *   这条闸门问的是「这一轮**敢不敢开跑**」，判据只有两条：
 *     1. 这个工作区确实开了沙箱（container_config.hostSandbox 在，且 provider 是 bwrap）；
 *     2. 沙箱里那条窄通道是活的（docker shim → 靶子事实服务）。
 *
 *   第 2 条不是形式检查：事实服务挂了以后，`runtime env` 会在轮次**中途**静默失效，
 *   Agent 只会说「证据不足」，没人看得出那是台子的问题，不是诊断的问题。
 *   把它做成可单独运行的模块，是为了能直接验证它，而不是只能靠跑一整轮来撞。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * @param {string} jid 工作区 JID（web:...）
 * @param {{root?: string, policyPath?: string}} options
 * @returns {Promise<{ok: boolean, why?: string, detail?: string}>}
 */
export async function checkSandboxReady(jid, options = {}) {
  const root = options.root ?? ROOT;
  const require = createRequire(import.meta.url);
  const Database = require('better-sqlite3');

  let row;
  try {
    const db = new Database(join(root, 'data/db/messages.db'), {
      readonly: true,
    });
    try {
      row = db
        .prepare('SELECT container_config FROM registered_groups WHERE jid = ?')
        .get(jid);
    } finally {
      db.close();
    }
  } catch (err) {
    return { ok: false, why: `读不到工作区配置：${err.message}` };
  }
  if (!row) return { ok: false, why: `DB 里没有工作区 ${jid}` };

  // /api/groups 的响应体里没有 container_config（读接口不下发写字段），
  // 所以直接读 DB——与闸门 W、记忆面核对同一口径。
  let config = {};
  if (row.container_config) {
    try {
      config = JSON.parse(row.container_config);
    } catch {
      return { ok: false, why: 'container_config 不是合法 JSON' };
    }
  }

  const sandbox = config.hostSandbox;
  if (!sandbox || sandbox.provider !== 'bwrap') {
    return {
      ok: false,
      why:
        '这个工作区没有开沙箱（container_config.hostSandbox 缺失）。\n' +
        '    先跑：node incident/sandbox/apply-sandbox.mjs --apply',
    };
  }

  const policyPath =
    options.policyPath ?? join(root, 'incident/sandbox/policy.json');
  let policy;
  try {
    policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  } catch (err) {
    return { ok: false, why: `读不到沙箱策略 ${policyPath}: ${err.message}` };
  }
  const socketPath = sandbox.env?.INCIDENT_FACTS_SOCKET || policy.factsSocket;

  const alive = await new Promise((resolvePromise) => {
    const socket = net.createConnection(socketPath);
    const done = (value) => {
      socket.destroy();
      resolvePromise(value);
    };
    const timer = setTimeout(() => done(false), 5000);
    socket.on('connect', () => {
      socket.write(
        `${JSON.stringify({
          op: 'inspect',
          container: (policy.allowedContainers ?? [])[0],
          format: '{{.State.StartedAt}}',
        })}\n`,
      );
    });
    socket.on('data', (chunk) => {
      clearTimeout(timer);
      try {
        const response = JSON.parse(chunk.toString('utf8').split('\n')[0]);
        done(response.ok === true);
      } catch {
        done(false);
      }
    });
    socket.on('error', () => {
      clearTimeout(timer);
      done(false);
    });
  });

  if (!alive) {
    return {
      ok: false,
      why:
        `靶子事实服务不通（${socketPath}）。\n` +
        '    它是沙箱里 docker shim 的后端；没有它 runtime env 会在轮次中途静默失效。\n' +
        '    起它：incident/lab.sh facts start',
    };
  }
  return {
    ok: true,
    detail: `沙箱已开启（provider=bwrap），靶子事实服务在线（${socketPath}）`,
  };
}

// 直接运行时：检查默认工作区（`node incident/runs/sandbox-preflight.mjs <jid>`）。
if (import.meta.url === `file://${process.argv[1]}`) {
  const jid = process.argv[2] ?? 'web:8ff36e4b-e8da-4dfd-be0a-b55d70fd9edb';
  const result = await checkSandboxReady(jid);
  if (result.ok) {
    console.log(`[PASS] ${jid} ${result.detail}`);
  } else {
    console.error(`[FAIL] ${jid} ${result.why}`);
    process.exitCode = 1;
  }
}
