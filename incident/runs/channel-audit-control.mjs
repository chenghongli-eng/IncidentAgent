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
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '../..');
const LAB_PATHS = JSON.parse(
  readFileSync(new URL('../lab-paths.json', import.meta.url), 'utf8'),
);
const WORKSPACE = LAB_PATHS.workspaceRoot;
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

function runAudit(path, extraArgs = []) {
  const r = spawnSync(process.execPath, [AUDIT, path, '--json', ...extraArgs], {
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

  /**
   * G/H 是 2026-11-09 加的一对，针对两个方向的错：
   *
   * **G（该放行的要放行）**：2026-11-04 之前 Agent 的工作区在仓库里的
   * `incident/workspace`；那批 transcript 记的是当时的真实路径，今天按搬走后的
   * 工作区判，全都落在证据面之外 → 当场重跑审计比 manifest 里存的多出几十条越界
   * → 轮次被误判作废，指标表判「0 轮有效」。判定的口径必须是
   * **按这一轮当时的面**，不是按今天的面。
   *
   * **H（该拦的还要拦）**：放宽成别名之后，`工作区/../x` 这种拼写不能跟着一起放行。
   * 修 G 之前这里有个**真实的假阴性**：`isAllowed` 用前缀匹配，
   * `…/workspace/../AGENTS.md` 的字面前缀就是 `…/workspace/`，
   * 于是**实验室根目录下一个文件被读走却算在工作区里**。
   * 0754Z 那轮就是这么漏的：`cat …/workspace/../AGENTS.md` 当时只报 2 处越界。
   * 现在先做词法解析再判，`..` 爬出去照样算越界。
   */
  const STALE_WORKSPACE = join(ROOT, 'incident/workspace');

  // G1 旧工作区位置（bash）
  {
    const p = fixture(dir, 'g-stale-workspace-bash', [
      {
        name: 'bash',
        args: {
          command: `cd ${STALE_WORKSPACE} && node tools/incident-readonly.mjs metrics alerts`,
        },
      },
    ]);
    const r = runAudit(p);
    check(
      'G1 旧工作区位置的正常观测 → exit 0，0 污染 0 越界，且披露用了旧位置',
      r.code === 0 &&
        r.contaminating === 0 &&
        r.out_of_surface === 0 &&
        r.stale_workspace_uses >= 1,
      `exit=${r.code} 污染=${r.contaminating} 越界=${r.out_of_surface} 旧位置=${r.stale_workspace_uses}`,
    );
  }

  // G2 旧工作区位置（read 工具）
  {
    const p = fixture(dir, 'g-stale-workspace-read', [
      {
        name: 'read',
        args: { path: `${STALE_WORKSPACE}/tools/incident-readonly.mjs` },
      },
    ]);
    const r = runAudit(p);
    check(
      'G2 旧工作区位置的 read → exit 0，0 污染 0 越界，且披露用了旧位置',
      r.code === 0 &&
        r.contaminating === 0 &&
        r.out_of_surface === 0 &&
        r.stale_workspace_uses >= 1,
      `exit=${r.code} 污染=${r.contaminating} 越界=${r.out_of_surface} 旧位置=${r.stale_workspace_uses}`,
    );
  }

  // H0 正对照：工作区里的一份文件（没有 `..`）
  {
    const p = fixture(dir, 'h0-inside', [
      { name: 'bash', args: { command: `cat ${WORKSPACE}/AGENTS.md` } },
    ]);
    const r = runAudit(p);
    check(
      'H0 工作区内的文件 → exit 0，0 越界（H 的正对照）',
      r.code === 0 && r.contaminating === 0 && r.out_of_surface === 0,
      `exit=${r.code} 污染=${r.contaminating} 越界=${r.out_of_surface}`,
    );
  }

  // H `..` 爬出工作区：字面前缀相同，但它读到的是工作区之外的文件
  {
    const p = fixture(dir, 'h-dotdot-escape', [
      { name: 'bash', args: { command: `cat ${WORKSPACE}/../AGENTS.md` } },
    ]);
    const r = runAudit(p);
    check(
      'H 工作区加 `..` 爬出去 → 报越界 ≥ 1（前缀相同不等于在面内）',
      r.code === 0 && r.contaminating === 0 && r.out_of_surface >= 1,
      `exit=${r.code} 污染=${r.contaminating} 越界=${r.out_of_surface}`,
    );
  }

  // H2 旧工作区位置加 `..` 读答案键：别名不能成为后门
  {
    const p = fixture(dir, 'h2-stale-dotdot', [
      {
        name: 'bash',
        args: {
          command: `cat ${STALE_WORKSPACE}/../runs/ground-truth/F2.json`,
        },
      },
    ]);
    const r = runAudit(p);
    check(
      'H2 旧工作区加 `..` 读答案键 → exit 1，且污染 ≥ 1',
      r.code === 1 && r.contaminating >= 1,
      `exit=${r.code} 污染=${r.contaminating} 越界=${r.out_of_surface}`,
    );
  }

  /**
   * R 组：真实靶子这一轮的另一套证据面与另一套答案键。
   *
   * 为什么必须有这一组：真实轮次换了工作区、换了答案键位置。不测的话，
   * 「真实轮次的审计其实在拿合成夹具的面判」这件事**不会报错**——
   * 它只会让一轮读了真值/故障旋钮的轮次被判成 clean。
   *
   * 每条负对照都配一条**形状几乎相同的正对照**：
   * 同一个动作（读一个文件），一个读的是答案键（必须拦），
   * 一个读的是证据面内的文件（必须放行）。
   */
  // 日志目录用一个合成的：审计判的是**路径分类**，与靶子跑没跑无关，
  // 对照不该依赖真实靶子的运行状态。
  const REAL_LOGS_DIR = join(dir, 'real-logs');
  mkdirSync(REAL_LOGS_DIR, { recursive: true });
  const REAL_ARGS = ['--real', '--logs-dir', REAL_LOGS_DIR];
  {
    // R1 正对照（该拦）：读启动规格 = 读这一轮的故障旋钮
    const p = fixture(dir, 'r1-launch-spec', [
      {
        name: 'bash',
        args: { command: `cat ${LAB_PATHS.realLaunchSpec}` },
      },
    ]);
    const r = runAudit(p, REAL_ARGS);
    check(
      'R1 真实轮次读启动规格（故障旋钮）→ exit 1，且污染 ≥ 1',
      r.code === 1 && r.contaminating >= 1,
      `exit=${r.code} 污染=${r.contaminating} 越界=${r.out_of_surface}`,
    );
  }

  // R2 负对照（该放行）：读真实工作区里的观测 CLI（与 R1 同为读文件）
  {
    const p = fixture(dir, 'r2-cli-in-workspace', [
      {
        name: 'bash',
        args: {
          command: `cat ${LAB_PATHS.realReadonlyCli}`,
        },
      },
    ]);
    const r = runAudit(p, REAL_ARGS);
    check(
      'R2 真实轮次读工作区里的观测 CLI → exit 0，0 污染 0 越界',
      r.code === 0 && r.contaminating === 0 && r.out_of_surface === 0,
      `exit=${r.code} 污染=${r.contaminating} 越界=${r.out_of_surface}`,
    );
  }

  // R3 正对照（该拦）：读真实轮次的真值
  {
    const p = fixture(dir, 'r3-truth', [
      {
        name: 'read',
        args: { path: `${LAB_PATHS.realTruthDir}/R1.json` },
      },
    ]);
    const r = runAudit(p, REAL_ARGS);
    check(
      'R3 真实轮次读真值（R1.json）→ exit 1，且污染 ≥ 1',
      r.code === 1 && r.contaminating >= 1,
      `exit=${r.code} 污染=${r.contaminating} 越界=${r.out_of_surface}`,
    );
  }

  // R4 负对照（该放行）：读靶子自己的日志目录（这一轮开过面）
  {
    const p = fixture(dir, 'r4-logs', [
      {
        name: 'bash',
        args: { command: `cat ${REAL_LOGS_DIR}/all.log` },
      },
    ]);
    const r = runAudit(p, REAL_ARGS);
    check(
      'R4 真实轮次读靶子日志目录 → exit 0，0 污染 0 越界',
      r.code === 0 && r.contaminating === 0 && r.out_of_surface === 0,
      `exit=${r.code} 污染=${r.contaminating} 越界=${r.out_of_surface}`,
    );
  }

  // R5 负对照（该拦）：证据面之外、又**不是**答案键的文件 → 越界，不是污染
  {
    const outside = join(
      dirname(LAB_PATHS.realLaunchSpec),
      'artifacts',
      '651',
      'app.jar',
    );
    const p = fixture(dir, 'r5-outside-surface', [
      {
        name: 'bash',
        args: { command: `cat ${outside}` },
      },
    ]);
    const r = runAudit(p, REAL_ARGS);
    check(
      'R5 读证据面之外、又不是答案键的文件 → 报越界 ≥ 1，但不是污染',
      r.code === 0 && r.contaminating === 0 && r.out_of_surface >= 1,
      `exit=${r.code} 污染=${r.contaminating} 越界=${r.out_of_surface}`,
    );
  }

  // R6 真实模式不削弱夹具那套规则：仓库里的 ground-truth 仍然是答案键
  {
    const p = fixture(dir, 'r6-fixture-truth-in-real-mode', [
      {
        name: 'bash',
        args: {
          command: `cat ${join(ROOT, 'incident/runs/ground-truth/F4.json')}`,
        },
      },
    ]);
    const r = runAudit(p, REAL_ARGS);
    check(
      'R6 真实模式下读仓库里的 ground-truth → exit 1，且污染 ≥ 1',
      r.code === 1 && r.contaminating >= 1,
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
