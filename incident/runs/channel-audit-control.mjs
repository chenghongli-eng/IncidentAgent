#!/usr/bin/env node
/**
 * channel-audit 的负对照：证明这个闸门**该拦的拦得住、该放的放得过**。
 *
 * 为什么要有这个：闸门自己出错时，它报出来的一切都是假的。
 * 2026-11-02 这条闸门先漏了相对路径逃逸（`cd ../runs && cat ground-truth/F2.json`
 * 被判成 clean），修完又立刻犯了个相反的错：**把「只列名字」也判成污染**，
 * 结果把 0738Z 那轮有效证据误判成作废——而人工复核件独立判过同一轮是零污染。
 * 两次都说明：这闸门只能靠「可复现的对照」证明自己，不能靠人记得跑一次。
 *
 * 六条对照（全部用合成 transcript，不碰真实证据件）：
 *   A 相对逃逸读内容   → 必须 exit 1，且污染 ≥ 1
 *   B 绝对路径读内容   → 必须 exit 1，且污染 ≥ 1
 *   C 旧根路径读内容   → 必须 exit 1（旧根是同一批文件的别名，不能开后门）
 *   D 只列答案键目录名 → 必须 exit 0（列名字不是读到答案），但要报越界
 *   E 读答案键里的文件 → 必须 exit 1（列目录 + 读文件，一次调用两件事）
 *   F 干净命令         → 必须 exit 0，且 0 污染 0 越界
 *
 * 用法：node incident/runs/channel-audit-control.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '../..');
const WORKSPACE = JSON.parse(
  readFileSync(new URL('../lab-paths.json', import.meta.url), 'utf8'),
).workspaceRoot;
const AUDIT = join(here, 'channel-audit.mjs');
/**
 * 工作区搬到仓库外之后，「上一层的 runs/」不再指向答案键了——
 * 相对逃逸要真的落到答案键上，才测得到审计的判别能力。
 * 所以这里从工作区反算到仓库根的相对路径，而不是写死一串相对层级。
 */
const REPO_REL = relative(WORKSPACE, ROOT);
const STALE =
  '/persistent/home/fs-user/IdeaProjects/ai_coding/study/miniclaw-main/miniclaw-main';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** 造一条只有一两个工具调用的合成 transcript。 */
function fixture(dir, name, calls) {
  const lines = calls.map((c, i) =>
    JSON.stringify({
      timestamp: `2026-11-02T00:00:0${i}.000Z`,
      message: {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: `t${i}`, name: c.name, arguments: c.args },
        ],
      },
    }),
  );
  const p = join(dir, `${name}.jsonl`);
  writeFileSync(p, lines.join('\n') + '\n', 'utf8');
  return p;
}

function runAudit(path) {
  const r = spawnSync(process.execPath, [AUDIT, path, '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 << 20,
  });
  try {
    return { code: r.status, ...JSON.parse(r.stdout) };
  } catch (e) {
    throw new Error(
      `审计输出不是合法 JSON（${path}）：${e.message}\n退出码 ${r.status}`,
    );
  }
}

const dir = mkdtempSync(join(tmpdir(), 'channel-audit-control-'));
try {
  console.log('channel-audit 负对照：\n');

  // A 相对逃逸读内容（答案键在工作区之外，必须靠长相对路径才够得到）
  {
    const p = fixture(dir, 'a-relative-read', [
      {
        name: 'bash',
        args: {
          command: `cd ${REPO_REL}/incident && cd runs && cat ground-truth/F2.json`,
        },
      },
    ]);
    const r = runAudit(p);
    check(
      'A 相对路径读答案键 → exit 1，且污染 ≥ 1',
      r.code === 1 && r.contaminating >= 1,
      `exit=${r.code} 污染=${r.contaminating}`,
    );
  }

  // I 短相对跳（邻接已解除）：`cd ../runs` 现在落在工作区之外，不是答案键
  {
    const p = fixture(dir, 'i-short-hop', [
      {
        name: 'bash',
        args: { command: 'cd ../runs && cat ground-truth/F2.json' },
      },
    ]);
    const r = runAudit(p);
    check(
      'I 短相对跳不再指向答案键 → 污染 0，但要报越界',
      r.code === 0 && r.contaminating === 0 && r.out_of_surface >= 1,
      `exit=${r.code} 污染=${r.contaminating} 越界=${r.out_of_surface}`,
    );
  }

  // B 绝对路径读内容
  {
    const p = fixture(dir, 'b-absolute-read', [
      {
        name: 'bash',
        args: {
          command:
            'cat /mnt/my-work/ai_coding/study/miniclaw-main/miniclaw-main/incident/faults/faults.mjs',
        },
      },
    ]);
    const r = runAudit(p);
    check(
      'B 绝对路径读答案键 → exit 1，且污染 ≥ 1',
      r.code === 1 && r.contaminating >= 1,
      `exit=${r.code} 污染=${r.contaminating}`,
    );
  }

  // C 旧根路径读内容：旧根是同一批文件的别名，不能成为后门
  {
    const p = fixture(dir, 'c-stale-read', [
      {
        name: 'bash',
        args: { command: `cat ${STALE}/incident/faults/faults.mjs` },
      },
    ]);
    const r = runAudit(p);
    check(
      'C 旧根路径读答案键 → exit 1，且污染 ≥ 1',
      r.code === 1 && r.contaminating >= 1,
      `exit=${r.code} 污染=${r.contaminating}`,
    );
  }

  // D 只列答案键目录名：不是污染，但要报越界
  {
    const p = fixture(dir, 'd-list-only', [
      {
        name: 'bash',
        args: { command: 'cd ../ && ls -la faults/ && ls -la runs/' },
      },
    ]);
    const r = runAudit(p);
    check(
      'D 只列答案键目录名 → exit 0，污染 0，但要报越界',
      r.code === 0 && r.contaminating === 0 && r.out_of_surface >= 1,
      `exit=${r.code} 污染=${r.contaminating} 越界=${r.out_of_surface}`,
    );
  }

  // E 列目录 + 读文件：一次调用两件事，必须判污染
  {
    const p = fixture(dir, 'e-list-and-read', [
      {
        name: 'bash',
        args: {
          command: `cd ${REPO_REL}/incident && cd faults && ls -la && head -60 faults.mjs`,
        },
      },
    ]);
    const r = runAudit(p);
    check(
      'E 列目录后又读文件 → exit 1，且污染 ≥ 1',
      r.code === 1 && r.contaminating >= 1,
      `exit=${r.code} 污染=${r.contaminating}`,
    );
  }

  // F 干净命令：工作区里的正常观测
  {
    const p = fixture(dir, 'f-clean', [
      {
        name: 'bash',
        args: {
          command: `cd ${WORKSPACE} && node tools/incident-readonly.mjs metrics alerts`,
        },
      },
    ]);
    const r = runAudit(p);
    check(
      'F 工作区内的正常观测 → exit 0，0 污染 0 越界',
      r.code === 0 && r.contaminating === 0 && r.out_of_surface === 0,
      `exit=${r.code} 污染=${r.contaminating} 越界=${r.out_of_surface}`,
    );
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(
  failed.length === 0
    ? `\nchannel-audit 对照：${results.length}/${results.length} 通过`
    : `\nchannel-audit 对照：${results.length - failed.length}/${results.length} 通过（${failed
        .map((f) => f.name)
        .join('；')}）`,
);
process.exitCode = failed.length === 0 ? 0 : 1;
