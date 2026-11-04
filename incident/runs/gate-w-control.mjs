#!/usr/bin/env node
/**
 * 闸门 W 的负对照：证明它**该拦的拦得住、该放的放得过**。
 *
 * 为什么要有这个：闸门自己出错时，它报出来的一切都是假的。
 * 闸门 W 的第一版就犯过一个错——用字符串前缀判断「工作区是否在仓库内」，
 * 把 /mnt/my-work/incident-lab 误判成 /mnt/my-work/ai_coding 的子目录，
 * 结果新工作区被判成「还在仓库里」。这类错只有对照能抓住。
 *
 * 八条对照（全部用合成目录与合成提示词，不碰真实工作区）：
 *   A 干净布局                    → 0 违规
 *   B 上 1 层有 runs/agent-report → 违规（命中）
 *   C 上 2 层有 ground-truth/*.json → 违规（命中）
 *   D 工作区根自己含 RESUME.md    → 违规（命中）
 *   E 上 1 层有 faults/*.mjs      → 违规（命中）
 *   F 工作区仍在仓库内            → 违规（命中）
 *   G 提示词含仓库根路径          → 违规（命中）
 *   H 提示词含旋钮目录            → 违规（命中）
 *
 * 用法：node incident/runs/gate-w-control.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkIsolation } from './gate-w-workspace-isolation.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** 干净的提示词：不含仓库根路径，不含旋钮目录，且 LAB 指向本例的工作区。 */
const cleanIdentity = (ws) => ({
  identity_prompt: '你是实验室诊断 Agent。',
  soul_prompt: '',
  agents_prompt: '按流程诊断。',
  tools_prompt: `LAB="node ${ws}/tools/incident-readonly.mjs"`,
});

function write(dir, rel, content = 'x') {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, 'utf8');
}

const tmp = mkdtempSync(join(tmpdir(), 'gate-w-control-'));
try {
  // A 干净布局：工作区在 tmp/a/b/ws，祖先层什么都没有
  {
    const repo = join(tmp, 'A/repo');
    const ws = join(tmp, 'A/outside/ws');
    mkdirSync(ws, { recursive: true });
    mkdirSync(repo, { recursive: true });
    const v = checkIsolation({
      workspaceRoot: ws,
      repoRoot: repo,
      identity: cleanIdentity(ws),
    });
    check('A 干净布局 → 0 违规', v.length === 0, v.join(' | ') || '无');
  }

  // B 上 1 层有 runs/agent-report-*.md
  {
    const repo = join(tmp, 'B/repo');
    const ws = join(tmp, 'B/outside/ws');
    mkdirSync(ws, { recursive: true });
    mkdirSync(repo, { recursive: true });
    write(join(tmp, 'B/outside'), 'runs/agent-report-2026-01-01T0000Z.md');
    const v = checkIsolation({
      workspaceRoot: ws,
      repoRoot: repo,
      identity: cleanIdentity(ws),
    });
    check(
      'B 上 1 层有 runs/agent-report-*.md → 违规',
      v.some((x) => x.includes('agent-report')),
      v.join(' | ') || '没抓到',
    );
  }

  // C 上 2 层有 ground-truth/*.json
  {
    const repo = join(tmp, 'C/repo');
    const ws = join(tmp, 'C/outside/ws');
    mkdirSync(ws, { recursive: true });
    mkdirSync(repo, { recursive: true });
    write(join(tmp, 'C'), 'ground-truth/F2.json', '{}');
    const v = checkIsolation({
      workspaceRoot: ws,
      repoRoot: repo,
      identity: cleanIdentity(ws),
    });
    check(
      'C 上 2 层有 ground-truth/*.json → 违规',
      v.some((x) => x.includes('ground-truth')),
      v.join(' | ') || '没抓到',
    );
  }

  // D 工作区根自己含 RESUME.md
  {
    const repo = join(tmp, 'D/repo');
    const ws = join(tmp, 'D/outside/ws');
    mkdirSync(ws, { recursive: true });
    mkdirSync(repo, { recursive: true });
    write(ws, 'RESUME.md');
    const v = checkIsolation({
      workspaceRoot: ws,
      repoRoot: repo,
      identity: cleanIdentity(ws),
    });
    check(
      'D 工作区根含 RESUME.md → 违规',
      v.some((x) => x.includes('RESUME.md')),
      v.join(' | ') || '没抓到',
    );
  }

  // E 上 1 层有 faults/*.mjs
  {
    const repo = join(tmp, 'E/repo');
    const ws = join(tmp, 'E/outside/ws');
    mkdirSync(ws, { recursive: true });
    mkdirSync(repo, { recursive: true });
    write(join(tmp, 'E/outside'), 'faults/faults.mjs', '//');
    const v = checkIsolation({
      workspaceRoot: ws,
      repoRoot: repo,
      identity: cleanIdentity(ws),
    });
    check(
      'E 上 1 层有 faults/*.mjs → 违规',
      v.some((x) => x.includes('faults')),
      v.join(' | ') || '没抓到',
    );
  }

  // F 工作区仍在仓库内
  {
    const repo = join(tmp, 'F/repo');
    const ws = join(repo, 'incident/workspace');
    mkdirSync(ws, { recursive: true });
    const v = checkIsolation({
      workspaceRoot: ws,
      repoRoot: repo,
      identity: cleanIdentity(ws),
    });
    check(
      'F 工作区仍在仓库内 → 违规',
      v.some((x) => x.includes('仓库内')),
      v.join(' | ') || '没抓到',
    );
  }

  // G 提示词含仓库根路径
  {
    const repo = join(tmp, 'G/repo');
    const ws = join(tmp, 'G/outside/ws');
    mkdirSync(ws, { recursive: true });
    mkdirSync(repo, { recursive: true });
    const identity = {
      ...cleanIdentity(ws),
      tools_prompt:
        'LAB="node /mnt/my-work/ai_coding/study/miniclaw-main/miniclaw-main/incident/workspace/tools/incident-readonly.mjs"',
    };
    const v = checkIsolation({ workspaceRoot: ws, repoRoot: repo, identity });
    check(
      'G 提示词含仓库根路径 → 违规',
      v.some((x) => x.includes('仓库根路径')),
      v.join(' | ') || '没抓到',
    );
  }

  // H 提示词含旋钮目录
  {
    const repo = join(tmp, 'H/repo');
    const ws = join(tmp, 'H/outside/ws');
    mkdirSync(ws, { recursive: true });
    mkdirSync(repo, { recursive: true });
    const identity = {
      ...cleanIdentity(ws),
      agents_prompt: '旋钮在 ~/.config/miniclaw-lab/lab.env',
    };
    const v = checkIsolation({ workspaceRoot: ws, repoRoot: repo, identity });
    check(
      'H 提示词含旋钮目录 → 违规',
      v.some((x) => x.includes('旋钮文件目录')),
      v.join(' | ') || '没抓到',
    );
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} 项对照通过。`,
);
if (failed.length) {
  console.log('失败：' + failed.map((f) => f.name).join('；'));
  process.exit(1);
}
