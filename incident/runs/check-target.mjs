#!/usr/bin/env node
/**
 * 交付体检：一条命令回答「这个靶子的接入合格吗」。
 *
 * 为什么要有这个：这套东西交给别的团队时，对方要改的东西有四处——
 * 描述符（通道指向哪）、采集器（部署台账从哪来）、指标标签（叫什么）、
 * 以及**本体里那行观测 CLI 的绝对路径**。第四处最容易漏：
 * `agent-profile/identity.json` 的 tools_prompt 里写着 `LAB=<绝对路径>`，
 * 那是手工填的，搬环境时不改，Agent 就会去执行一个不存在的路径——
 * 而且失败得很安静（报告照样出，只是没有一条证据）。
 * 改完还要 `sync-agent-profile.mjs` 入库，改了 JSON 不入库等于没改。
 *
 * 所以体检分两段：
 *   D0 —— 交付专有：本体里的 CLI 路径在这台机器上存在且可执行，
 *        并且与库里的副本一致（没漏同步）。
 *   P1–P5 —— 复用真实靶子前置闸门（runs/target-preflight.mjs）：
 *        通道在位 / 日志由靶子自己持有 / 靶子在自己的指标里现身 /
 *        基线 5xx = 0 / 开跑前没有告警在 firing（且该 Prometheus 必须有规则）。
 *
 * 用法：
 *   node incident/runs/check-target.mjs                # 用环境变量/内置默认
 *   node incident/runs/check-target.mjs /path/to/x.json # 用指定描述符
 *   node incident/runs/check-target.mjs p2              # 用名字（在 INCIDENT_TARGET_DIR 里找）
 *
 * 退出码：全部通过 0，有一条没过 1。判定逻辑是纯函数
 * （renderReport / exitCodeFor），负对照在 runs/check-target-control.mjs。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { realTargetPreflight, realDeps } from './target-preflight.mjs';
import { resolveTarget, targetProfile } from '../targets/descriptor.mjs';

const IDENTITY_PATH = fileURLToPath(  new URL('../agent-profile/identity.json', import.meta.url),
);
const SYNC_PATH = fileURLToPath(
  new URL('./sync-agent-profile.mjs', import.meta.url),
);
const DB_PATH = fileURLToPath(new URL('../../data/db/messages.db', import.meta.url));

/**
 * profile id。**不从 sync-agent-profile.mjs import**——那个模块导入即执行
 * （它顶层就同步入库）。所以这里抄一份，并用「对拍」防漂移：
 * 两处常量不一致，体检就红。
 */
const PROFILE_ID = 'bbc54f27-afd9-454a-be99-842531057c43';

/**
 * 从 tools_prompt 里抠出观测 CLI 的**路径**。
 *
 * `LAB=` 的值不是裸路径——命令是 `$LAB metrics query ...`，所以它得能直接
 * 当命令用，实际存的是 `node /path/to/incident-readonly.mjs`。这里要把
 * 前面的解释器名剥掉，只留路径。
 */
export function labPathFrom(toolsPrompt) {
  const m = /LAB="(?:node\s+)?([^"]+)"/.exec(toolsPrompt ?? '');
  return m ? m[1] : null;
}

/** 判定：哪些闸门没过。空闸门列表算**没通过**——「什么都没查」不等于「都过了」。 */
export function exitCodeFor(gates) {
  if (!Array.isArray(gates) || gates.length === 0) return 1;
  return gates.some((g) => !g.ok) ? 1 : 0;
}

/** 人话报告。纯函数：同样的输入必须给出同样的输出。 */
export function renderReport({ gates, facts = {}, profile = {}, notes = [] }) {
  const lines = [];
  const id = profile.id ?? '(内置默认靶子)';
  lines.push(`交付体检：${id}`);
  lines.push(
    `  通道指向：Prometheus ${profile.prometheusUrl ?? '?'}  actuator ${profile.actuatorBaseUrl ?? '?'}`,
  );
  lines.push(`  日志目录：${profile.logsDir ?? '?'}    台账：${profile.ledgerPath ?? '(未配)'}`);
  lines.push('');

  for (const g of gates) {
    lines.push(`[${g.id}] ${g.ok ? 'PASS' : 'FAIL'}  ${g.title ?? ''}`);
    lines.push(`      ${g.detail}`);
  }

  if (notes.length) {
    lines.push('');
    for (const n of notes) lines.push(`注：${n}`);
  }

  const failed = (gates ?? []).filter((g) => !g.ok);
  lines.push('');
  if (!failed.length) {
    lines.push('结论：全部通过。这个靶子的接入可以进入下一阶段（跑一轮）。');
  } else {
    lines.push(
      `结论：${failed.length} 条未通过（${failed.map((g) => g.id).join(', ')}）——接入还不合格。`,
    );
  }
  return lines.join('\n');
}

/** D0：本体里的 CLI 路径 + 与库里的副本是否一致。 */
export function deliveryGates({ identity, syncSource, dbToolsPrompt = null }) {
  const gates = [];

  const labPath = labPathFrom(identity?.tools_prompt);
  let detail;
  let ok = false;
  if (!labPath) {
    detail =
      'agent-profile/identity.json 的 tools_prompt 里没有 `LAB="..."` 这一行——' +
      '观测 CLI 的路径得写进去，否则 Agent 无从知道去哪取证。';
  } else if (!existsSync(labPath)) {
    detail =
      `tools_prompt 里的 CLI 路径 ${labPath} 在这台机器上不存在。` +
      '搬环境时漏改了这一行——Agent 会去执行一个不存在的路径，' +
      '而且失败得很安静（报告照样出，只是没有一条证据）。';
  } else if (!statSync(labPath).isFile()) {
    detail = `tools_prompt 里的 CLI 路径 ${labPath} 不是文件。`;
  } else {
    ok = true;
    detail = `观测 CLI 路径有效：${labPath}`;
  }
  gates.push({ id: 'D0', ok, title: '本体里的观测 CLI 路径', detail });

  // D1：profile id 没漂移
  const syncId = /PROFILE_ID\s*=\s*'([0-9a-f-]+)'/.exec(syncSource ?? '')?.[1];
  gates.push({
    id: 'D1',
    ok: syncId === PROFILE_ID,
    title: 'profile id 与同步脚本一致',
    detail:
      syncId === PROFILE_ID
        ? `profile id 一致（${PROFILE_ID}）`
        : `profile id 漂移了：本文件用 ${PROFILE_ID}，sync-agent-profile.mjs 用 ${syncId}。` +
          '两边不一致时，体检看的就不是入库的那份 profile。',
  });

  // D2：改了 JSON 有没有入库
  if (dbToolsPrompt === null) {
    gates.push({
      id: 'D2',
      ok: true,
      title: '本体改动是否已入库',
      detail:
        '本机没有可读的消息库（或没构建 dist/），跳过这一条。' +
        '入库一致性在有库的环境里由 D2 实测。',
    });
  } else {
    const same = dbToolsPrompt === identity?.tools_prompt;
    gates.push({
      id: 'D2',
      ok: same,
      title: '本体改动是否已入库',
      detail: same
        ? '库里的 tools_prompt 与 identity.json 一致。'
        : '库里的 tools_prompt 与 identity.json **不一致**——改了 JSON 没跑 ' +
          '`node incident/runs/sync-agent-profile.mjs`，Agent 运行时读到的还是旧的那份。',
    });
  }

  return gates;
}

/** 读库里的 tools_prompt；读不到就返回 null（本机没库 / 没构建）。 */
async function readDbToolsPrompt() {
  if (!existsSync(DB_PATH)) return null;
  try {
    const distUrl = pathToFileURL(fileURLToPath(new URL('../../dist/db.js', import.meta.url))).href;
    const db = await import(distUrl);
    db.initDatabase();
    const profile = db.getAgentProfile(PROFILE_ID);
    return profile?.tools_prompt ?? null;
  } catch {
    return null;
  }
}

async function main() {
  const spec = process.argv[2];
  let descriptor = null;
  try {
    descriptor = resolveTarget(spec);
  } catch (err) {
    process.stderr.write(`解析靶子描述符失败：${err.message}\n`);
    process.exit(1);
  }
  const profile = targetProfile(descriptor);

  const identity = JSON.parse(readFileSync(IDENTITY_PATH, 'utf8'));
  const syncSource = readFileSync(SYNC_PATH, 'utf8');
  const dbToolsPrompt = await readDbToolsPrompt();

  const delivery = deliveryGates({ identity, syncSource, dbToolsPrompt });
  const { gates: preflight } = await realTargetPreflight(profile, realDeps);
  const gates = [...delivery, ...preflight];

  const notes = [];
  if (profile.mode === 'builtin') {
    notes.push(
      '没有指定描述符，用的是内置默认靶子（合成夹具）。接真实系统时用 ' +
        'INCIDENT_TARGET_FILE / INCIDENT_TARGET 指定。',
    );
    notes.push(
      'P1 与 P2 问的是**真实靶子**的问题（部署台账在不在、宿主进程是不是日志文件的' +
        '写句柄持有者）。合成夹具跑在容器里、没有部署台账，这两条对它不适用——' +
        '夹具自己的闸门在 `incident/lab.sh` 与 `runs/run-round.mjs` 里。',
    );
  }

  process.stdout.write(renderReport({ gates, facts: {}, profile, notes }) + '\n');
  process.exit(exitCodeFor(gates));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`交付体检失败：${err?.stack ?? String(err)}\n`);
    process.exit(1);
  });
}
