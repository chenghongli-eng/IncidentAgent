#!/usr/bin/env node
/**
 * 闸门 W：Agent 的工作区与答案键**不再相邻**。
 *
 * 背景：工作区原来放在仓库里的 `incident/workspace/`，也就是答案键所在目录的
 * **上一层**。Agent 一次 `ls ..` 或 `find .. -maxdepth 2` 就能看到
 * `ground-truth/`、`faults/`、`runs/agent-report-*.md`、`RESUME.md`——
 * 2026-11-04 那轮就真的做过 `find .. -maxdepth 2`。
 * 2026-11-04 起工作区搬到仓库外（路径真相源：`incident/lab-paths.json`）。
 *
 * **这条闸门只保证「不相邻」，不保证「不可达」**：
 *   - 外仓 git 历史里仍有旧副本（`git show HEAD~n:incident/runs/ground-truth/F2.json`）；
 *   - 家目录仍然可读（`~/.config/miniclaw-lab/lab.env` 那类旋钮文件）；
 *   - 底座（Bash 工具）没有沙箱，也没有 uid 隔离。
 * 所以边界仍然是「Agent 自觉 + 通道审计事后判污染」，只是邻接性没了。
 * 对外口径只能是「不再相邻 + 提示词里没有仓库路径」，不能说「不可达」。
 *
 * 检查三件事：
 *   W1 工作区根往上 2 层（含自己）以内，任何目录的条目里都不出现答案键文件；
 *   W2 工作区提示词（identity.json 四段）里不含仓库根路径，也不含旋钮目录；
 *   W3 仓库里的旧工作区路径 `incident/workspace` 已经不存在，且仓库根
 *      不在工作区根的祖先链上；
 *   W4 工作区根往上 2 层以内不出现实验室自己的记录（归档 bundle、注入台账）——
 *      这些文件里装着服务仓库的旧历史，也就是旧注入提交。
 *
 * 用法：node incident/runs/gate-w-workspace-isolation.mjs
 * 退出码：0 = 不变量成立；1 = 有违规项（逐条打印）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 答案键的形态：某些目录下的某些文件。
 * 目录名 + 文件名规则分开写，这样「工作区旁边有个 ground-truth 目录」
 * 和「工作区旁边有个叫 runs 的普通目录」能区分开。
 */
const ANSWER_KEY_DIRS = [
  {
    dir: 'ground-truth',
    file: /\.json$/,
    why: 'ground-truth/*.json = 打分判据（根因与归因标准）',
  },
  {
    dir: 'faults',
    file: /\.mjs$/,
    why: 'faults/*.mjs = 故障定义与注入脚本（出题方的答案键）',
  },
  {
    dir: 'runs',
    file: /^(agent-report-.*\.md|score-.*\.json)$/,
    why: 'runs/agent-report-*.md、runs/score-*.json = 既往轮次的报告原文与打分',
  },
];

/** 答案键的文件名（出现在任何被扫目录的条目里都算违规）。 */
const ANSWER_KEY_FILES = ['RESUME.md'];

/**
 * 实验室自己的记录：归档 bundle、注入台账、轮次原件压缩包。
 *
 * 为什么它们也算「答案键邻接」：这些文件里装着**服务仓库的旧历史**——
 * 上一轮的注入提交就在 bundle 里。放到工作区隔壁，Agent 一次 `ls ..`
 * 就能看到目录名，再 `git clone` 一下就把旧缺陷 diff 拿走了。
 * 仓库外不等于邻域外：闸门查的是「工作区往上 2 层」，
 * 所以归档必须落在 home 这种**另一棵树**里（见 incident/lab-paths.json）。
 */
const LAB_RECORD_FILES = [
  { file: /\.bundle$/, why: '服务仓库历史归档 bundle（含旧注入提交）' },
  { file: /^injections\.log$/, why: '注入台账（记录注入过什么、什么时候）' },
  { file: /\.tgz$/, why: '轮次原件压缩包' },
];

/** 实验室记录目录名：出现在邻域里就算违规（哪怕里面当前是空的）。 */
const LAB_RECORD_DIRS = ['archive', 'incident-lab-archive', 'pre-commit-raw'];

/** 工作区提示词里不许出现的路径片段：仓库根 = 答案键所在树；旋钮目录 = 绕过通道取生效值。 */
const FORBIDDEN_IN_PROMPT = [
  { token: 'miniclaw-main/miniclaw-main', why: '仓库根路径：答案键所在树' },
  {
    token: '.config/miniclaw-lab',
    why: '旋钮文件目录：生效值只应经 runtime env 取得',
  },
];

function isUnder(child, parent) {
  // 用 path.relative 判断「是不是在下面」：字符串前缀判断会把
  // /mnt/my-work/incident-lab 当成 /mnt/my-work/ai_coding 的子目录——
  // 这正是本闸门要抓的那类误判，不能自己犯一遍。
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * 扫一个目录的**直接条目**，看有没有答案键。
 * 目录条目会再往里看一层（只看一层）：`ground-truth/` 目录本身不算答案键，
 * `ground-truth/F2.json` 才算。
 */
function scanDir(dir, label, violations) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // 目录读不到（不存在/权限）不构成违规，但由调用方保证存在
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isFile()) {
      if (ANSWER_KEY_FILES.includes(e.name)) {
        violations.push(`${label} 下的 ${e.name}：答案键台账`);
      }
      for (const rule of LAB_RECORD_FILES) {
        if (rule.file.test(e.name)) {
          violations.push(`${label} 下的 ${e.name}：${rule.why}`);
        }
      }
      for (const rule of ANSWER_KEY_DIRS) {
        if (rule.file.test(e.name) && rule.dir === 'runs') {
          violations.push(`${label} 下的 ${e.name}：${rule.why}`);
        }
      }
      continue;
    }
    if (!e.isDirectory()) continue;
    if (LAB_RECORD_DIRS.includes(e.name)) {
      violations.push(
        `${label} 下的 ${e.name}/：实验室记录目录（归档 / 台账）`,
      );
      continue;
    }
    const rule = ANSWER_KEY_DIRS.find((r) => r.dir === e.name);
    if (!rule) continue;
    let children = [];
    try {
      children = readdirSync(full, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const c of children) {
      if (c.isFile() && rule.file.test(c.name)) {
        violations.push(`${label} 下的 ${e.name}/${c.name}：${rule.why}`);
      }
    }
  }
}

/**
 * 核心检查。纯函数式：吃路径和提示词，吐违规清单——这样负对照可以用合成目录来测它。
 *
 * @param {object} p
 * @param {string} p.workspaceRoot 工作区根
 * @param {string} p.repoRoot      仓库根（答案键所在树）
 * @param {object} p.identity      identity.json 的四段 prompt
 * @returns {string[]} 违规项；空数组 = 不变量成立
 */
export function checkIsolation({ workspaceRoot, repoRoot, identity }) {
  const violations = [];
  const ws = resolve(workspaceRoot);

  if (!existsSync(ws)) {
    violations.push(`工作区根不存在：${ws}`);
    return violations;
  }

  // W1：工作区根往上 2 层（含自己）以内不许出现答案键。
  const ancestors = [ws, dirname(ws), dirname(dirname(ws))];
  for (const a of ancestors) {
    scanDir(
      a,
      a === ws ? '工作区根' : `工作区根上 ${a === dirname(ws) ? 1 : 2} 层`,
      violations,
    );
  }

  // W2：提示词里不许出现仓库根路径或旋钮目录。
  const prompts = {
    identity: identity?.identity_prompt ?? '',
    soul: identity?.soul_prompt ?? '',
    agents: identity?.agents_prompt ?? '',
    tools: identity?.tools_prompt ?? '',
  };
  for (const [name, text] of Object.entries(prompts)) {
    for (const f of FORBIDDEN_IN_PROMPT) {
      if (text.includes(f.token)) {
        violations.push(
          `identity.json 的 ${name} 段含「${f.token}」：${f.why}`,
        );
      }
    }
    if (repoRoot && text.includes(repoRoot)) {
      violations.push(
        `identity.json 的 ${name} 段含仓库根绝对路径：${repoRoot}`,
      );
    }
  }
  // 提示词里的观测 CLI 必须指向**新工作区**：搬家后如果还指着旧路径，
  // Agent 会去一个不存在的目录找 CLI——那不是污染，是断链，同样要红。
  if (prompts.tools && !prompts.tools.includes(ws)) {
    violations.push(
      `identity.json 的 tools 段没有指向工作区 ${ws}：观测 CLI 路径与实际工作区不一致`,
    );
  }

  // W3：仓库里的旧工作区路径必须已经消失；仓库根不得在工作区根的祖先链上。
  const old = join(repoRoot, 'incident/workspace');
  if (existsSync(old)) {
    violations.push(`仓库里还留着旧工作区路径：${old}`);
  }
  if (isUnder(ws, repoRoot)) {
    violations.push(`工作区根仍在仓库内（相邻未解除）：${ws}`);
  }

  return violations;
}

function loadIdentity(real = false) {
  const p = join(
    here,
    real
      ? '../agent-profile/identity-real.json'
      : '../agent-profile/identity.json',
  );
  return JSON.parse(readFileSync(p, 'utf8'));
}

function main() {
  const paths = JSON.parse(
    readFileSync(join(here, '../lab-paths.json'), 'utf8'),
  );
  // 真实靶子那一轮换的是**另一套工作区与另一份提示词**：
  // 工作区是靶子源码快照（不是合成夹具），提示词是 identity-real.json。
  // 不换的话，这条闸门量的是合成夹具那一套，对真实轮次什么也没说。
  const real = process.argv.includes('--real');
  const workspaceRoot = real ? paths.realWorkspaceRoot : paths.workspaceRoot;
  const violations = checkIsolation({
    workspaceRoot,
    repoRoot: paths.repoRoot,
    identity: loadIdentity(real),
  });
  console.log(
    `闸门 W${real ? '（真实靶子）' : ''}：工作区 ${workspaceRoot}\n` +
      `        仓库根 ${paths.repoRoot}\n`,
  );
  if (violations.length) {
    console.log(`✗ 不变量不成立，${violations.length} 项违规：`);
    for (const v of violations) console.log(`  - ${v}`);
    process.exit(1);
  }
  console.log('✓ W1 工作区根往上 2 层没有答案键文件');
  console.log(
    `✓ W2 ${real ? 'identity-real.json' : 'identity.json'} 四段提示词不含仓库根路径 / 旋钮目录`,
  );
  console.log('✓ W3 仓库内旧工作区路径已清空，仓库根不在工作区祖先链上');
  console.log(
    '✓ W4 工作区往上 2 层没有实验室记录（bundle / injections.log / 归档目录）',
  );
  console.log(
    '\n口径提醒：本闸门保证的是「不相邻」，不是「不可达」——\n' +
      '  外仓 git 历史里的旧副本、家目录、以及无沙箱的 Bash 工具仍然可达。',
  );
}

// 仅在被直接执行时跑 main；被 import 时只导出函数（负对照要这么用）。
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main();
}
