#!/usr/bin/env node
/**
 * 真实靶子那一轮的 Agent 侧准备：Agent Profile、工作区、只读 CLI。
 *
 * 合成夹具那一套是「先手工建好，再由 sync-agent-profile.mjs 改提示词」。
 * 真实靶子这边多两件事：
 *
 *   1. **工作区是另一个目录**（workspace-real），里面装的是靶子源码的快照，
 *      不是合成夹具。两个工作区混用的话，Agent 诊断的就不是被诊断的那个东西。
 *   2. **提示词里的路径不一样**：观测 CLI 在真实工作区里，PromQL 的应用标签
 *      用 {{APP}} 占位（CLI 会换成靶子真实的标签值，仓库里不留内部名字）。
 *
 * 幂等：按名字找现有的 Profile / 工作区，找到就更新，找不到才建。
 * 跑第二遍不会造出第二个同名工作区。
 *
 * 用法：node incident/runs/setup-real-workspace.mjs
 * 打印：JSON（profile id / group jid / folder / custom_cwd）
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LAB_PATHS = JSON.parse(
  readFileSync(join(ROOT, 'incident/lab-paths.json'), 'utf8'),
);
const IDENTITY = JSON.parse(
  readFileSync(join(ROOT, 'incident/agent-profile/identity-real.json'), 'utf8'),
);
const MINICLAW = 'http://127.0.0.1:3000';

const WORKSPACE = LAB_PATHS.realWorkspaceRoot;
const CLI_DST = LAB_PATHS.realReadonlyCli;
const CLI_SRC = join(ROOT, 'incident/tools/incident-readonly.mjs');

function cookie() {
  return execFileSync(
    process.execPath,
    [join(ROOT, 'incident/runs/mc-auth.mjs')],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

async function api(path, { method = 'GET', body = null, auth } = {}) {
  const res = await fetch(`${MINICLAW}${path}`, {
    method,
    headers: {
      ...(auth ? { Cookie: auth } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应留给调用方看原文 */
  }
  if (!res.ok) {
    throw new Error(
      `${method} ${path} → HTTP ${res.status}：${text.slice(0, 400)}`,
    );
  }
  return json;
}

function syncCli() {
  mkdirSync(dirname(CLI_DST), { recursive: true });
  const src = readFileSync(CLI_SRC, 'utf8');
  const cur = existsSync(CLI_DST) ? readFileSync(CLI_DST, 'utf8') : null;
  if (cur === src) return '一致';
  copyFileSync(CLI_SRC, CLI_DST);
  return '已更新';
}

async function main() {
  const auth = cookie();

  // ── 工作区 ──────────────────────────────────────────────────────
  mkdirSync(WORKSPACE, { recursive: true });
  mkdirSync(join(WORKSPACE, 'tools'), { recursive: true });
  const cliState = syncCli();

  // ── Agent Profile ───────────────────────────────────────────────
  const profiles = await api('/api/agent-profiles', { auth });
  const existing = profiles.profiles?.find((p) => p.name === IDENTITY.name);
  const payload = {
    name: IDENTITY.name,
    prompt_schema_version: 2,
    identity_prompt: IDENTITY.identity_prompt,
    soul_prompt: IDENTITY.soul_prompt,
    agents_prompt: IDENTITY.agents_prompt,
    tools_prompt: IDENTITY.tools_prompt,
    prompt_mode: 'replace',
    avatar_emoji: IDENTITY.avatar_emoji,
    avatar_color: IDENTITY.avatar_color,
    runtime_policy: IDENTITY.runtime_policy,
  };
  let profileId;
  let profileAction;
  if (existing) {
    await api(`/api/agent-profiles/${existing.id}`, {
      method: 'PATCH',
      body: payload,
      auth,
    });
    profileId = existing.id;
    profileAction = 'updated';
  } else {
    const created = await api('/api/agent-profiles', {
      method: 'POST',
      body: payload,
      auth,
    });
    profileId = created.profile?.id ?? created.id;
    profileAction = 'created';
  }

  // ── 工作区（host 模式 + custom_cwd）─────────────────────────────
  const groups = await api('/api/groups', { auth });
  const existingGroup = Object.entries(groups.groups ?? {}).find(
    ([, g]) => g.custom_cwd === WORKSPACE,
  );
  let jid;
  let folder;
  let groupAction;
  if (existingGroup) {
    const [j, g] = existingGroup;
    // 绑到真实 Profile 上：工作区与 Agent 绑定是**一步**的事（产品语义如此），
    // 这里只补绑，不新建。
    if (g.agent_profile_id !== profileId) {
      await api(`/api/groups/${encodeURIComponent(j)}/agent-profile`, {
        method: 'PATCH',
        body: { agent_profile_id: profileId },
        auth,
      });
    }
    jid = j;
    folder = g.folder;
    groupAction = 'reused';
  } else {
    const created = await api('/api/groups', {
      method: 'POST',
      body: {
        name: 'incident-lab-real',
        execution_mode: 'host',
        custom_cwd: WORKSPACE,
        agent_profile_id: profileId,
      },
      auth,
    });
    jid = created.jid ?? created.group?.jid;
    folder = created.folder ?? created.group?.folder;
    groupAction = 'created';
  }

  console.log(
    JSON.stringify(
      {
        profile: { id: profileId, name: IDENTITY.name, action: profileAction },
        group: { jid, folder, custom_cwd: WORKSPACE, action: groupAction },
        cli: { path: CLI_DST, state: cliState },
        workspace: WORKSPACE,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(`✗ 准备失败：${err.message}`);
  process.exit(1);
});
