#!/usr/bin/env node
/**
 * validate-resume-package 的负对照：证明这个校验**该拦的拦得住、该放的放得过**。
 *
 * 为什么要有这个：校验脚本自己出错时，它报出来的一切都是假的。
 * 2026-11-02 通道审计口径改过一次之后，简历包里的「10 次越界」一度漏同步——
 * 当时没有任何机器检查，靠人肉同步才没贴出去。补了这个校验之后，
 * 「它到底会不会拦」就必须能被证明，而不是靠人记得跑一次。
 *
 * 做法：把真包复制到临时目录，逐个注入缺陷，看校验是否真的 exit 1；
 * 再跑一次没动过的真包，看它是否真的 exit 0。**全部用副本，不碰真包。**
 *
 * 用法：node incident/runs/validate-resume-package-control.mjs [包目录]
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const VALIDATOR = join(here, 'validate-resume-package.mjs');
const PKG =
  process.argv[2] ??
  '/home/fs-user/Desktop/文档/overleaf/miniclaw_incident相关';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function runValidator(dir) {
  const r = spawnSync(process.execPath, [VALIDATOR, dir], {
    encoding: 'utf8',
    maxBuffer: 16 << 20,
  });
  const out = r.stdout ?? '';
  const failedNames = [...out.matchAll(/^  ✗ (.+?) —/gm)].map((m) => m[1]);
  return { code: r.status, failedNames, out };
}

/** 复制一份包到临时目录，并在副本上做一次改动。 */
function brokenCopy(name, mutate) {
  const dir = mkdtempSync(join(tmpdir(), `resume-pkg-${name}-`));
  cpSync(PKG, dir, { recursive: true });
  mutate(dir);
  return dir;
}

function patchFile(dir, name, fn) {
  const p = join(dir, name);
  const s = readFileSync(p, 'utf8');
  writeFileSync(p, fn(s), 'utf8');
}

const dirs = [];
try {
  console.log('简历包校验 负对照：\n');

  // 0 真包必须通过（该放过的要放过）
  {
    const r = runValidator(PKG);
    check(
      '0 真包原样 → exit 0，0 项失败',
      r.code === 0 && r.failedNames.length === 0,
      `exit=${r.code} 失败 ${r.failedNames.length} 项`,
    );
  }

  // 1 数字漂移：越界数退回 9
  {
    const dir = brokenCopy('stale-oos', (d) => {
      for (const f of ['paste-ready-当前可贴.md', 'paste-ready-最终版.md']) {
        patchFile(d, f, (s) => s.replaceAll('10 次越界读取', '9 次越界读取'));
      }
    });
    dirs.push(dir);
    const r = runValidator(dir);
    check(
      '1 越界数漂回 9 → exit 1，且 C1 必须报错',
      r.code === 1 && r.failedNames.some((n) => n.startsWith('C1')),
      `exit=${r.code} 失败：${r.failedNames.join('；') || '（无）'}`,
    );
  }

  // 2 禁写词混进正文
  {
    const dir = brokenCopy('forbidden', (d) => {
      patchFile(d, 'paste-ready-当前可贴.md', (s) =>
        s.replace(
          '- **故障 Case Memory**',
          '- **故障 Case Memory**（已搭建 MCP Server 与向量知识库）',
        ),
      );
    });
    dirs.push(dir);
    const r = runValidator(dir);
    check(
      '2 正文混入禁写词（MCP Server / 向量库）→ exit 1，且 D1 必须报错',
      r.code === 1 && r.failedNames.some((n) => n.startsWith('D1')),
      `exit=${r.code} 失败：${r.failedNames.join('；') || '（无）'}`,
    );
  }

  // 3 正文把已作废轮次当证据
  {
    const dir = brokenCopy('void-round', (d) => {
      patchFile(d, 'paste-ready-最终版.md', (s) =>
        s.replace(
          '- **故障 Case Memory**',
          '- **故障 Case Memory**（证据来自 2026-10-30T0350Z）',
        ),
      );
    });
    dirs.push(dir);
    const r = runValidator(dir);
    check(
      '3 正文引用已作废轮次 0350Z → exit 1，且 E2 必须报错',
      r.code === 1 && r.failedNames.some((n) => n.startsWith('E2')),
      `exit=${r.code} 失败：${r.failedNames.join('；') || '（无）'}`,
    );
  }

  // 4 必备文件缺失
  {
    const dir = brokenCopy('missing-file', (d) => {
      rmSync(join(d, 'claim-ledger.json'));
    });
    dirs.push(dir);
    const r = runValidator(dir);
    check(
      '4 缺 claim-ledger.json → exit 1，且 A1 必须报错',
      r.code === 1 && r.failedNames.some((n) => n.startsWith('A1')),
      `exit=${r.code} 失败：${r.failedNames.join('；') || '（无）'}`,
    );
  }

  // 5 台账里抹掉 resume_final 放行（正文就没有依据了）
  {
    const dir = brokenCopy('no-release', (d) => {
      const p = join(d, 'claim-ledger.json');
      const led = JSON.parse(readFileSync(p, 'utf8'));
      for (const c of led.claims) {
        if (Array.isArray(c.allowed_uses))
          c.allowed_uses = c.allowed_uses.filter((u) => u !== 'resume_final');
      }
      writeFileSync(p, JSON.stringify(led, null, 2), 'utf8');
    });
    dirs.push(dir);
    const r = runValidator(dir);
    check(
      '5 台账里没有 resume_final 放行 → exit 1，且 B3 必须报错',
      r.code === 1 && r.failedNames.some((n) => n.startsWith('B3')),
      `exit=${r.code} 失败：${r.failedNames.join('；') || '（无）'}`,
    );
  }

  // 6 台账引用不存在的仓库文件
  {
    const dir = brokenCopy('bad-source', (d) => {
      const p = join(d, 'claim-ledger.json');
      const led = JSON.parse(readFileSync(p, 'utf8'));
      led.claims[0].sources = [
        {
          type: 'run-evidence',
          location: 'incident/runs/does-not-exist-9999.md',
        },
      ];
      writeFileSync(p, JSON.stringify(led, null, 2), 'utf8');
    });
    dirs.push(dir);
    const r = runValidator(dir);
    check(
      '6 台账引用不存在的仓库文件 → exit 1，且 E1 必须报错',
      r.code === 1 && r.failedNames.some((n) => n.startsWith('E1')),
      `exit=${r.code} 失败：${r.failedNames.join('；') || '（无）'}`,
    );
  }

  // 7 「处数字问题」条数与复核件对不上
  {
    const dir = brokenCopy('defect-count', (d) => {
      for (const f of ['paste-ready-当前可贴.md', 'paste-ready-最终版.md']) {
        patchFile(d, f, (s) => s.replaceAll('5 处数字问题', '4 处数字问题'));
      }
    });
    dirs.push(dir);
    const r = runValidator(dir);
    check(
      '7 「4 处数字问题」与复核件 §3 的 5 条对不上 → exit 1，且 C3 必须报错',
      r.code === 1 && r.failedNames.some((n) => n.startsWith('C3')),
      `exit=${r.code} 失败：${r.failedNames.join('；') || '（无）'}`,
    );
  }
  // 8 精简措辞里塞一个原文没有的数字（语义夸大最常见的形态）
  {
    const dir = brokenCopy('compact-number', (d) => {
      const p = join(d, 'claim-ledger.json');
      const led = JSON.parse(readFileSync(p, 'utf8'));
      for (const c of led.claims) {
        if (c.candidate_wording_compact) {
          c.candidate_wording_compact = c.candidate_wording_compact.replace(
            '四类通道',
            '8 类通道',
          );
        }
      }
      writeFileSync(p, JSON.stringify(led, null, 2), 'utf8');
    });
    dirs.push(dir);
    const r = runValidator(dir);
    check(
      '8 精简措辞引入原文没有的数字 → exit 1，且 B5 必须报错',
      r.code === 1 && r.failedNames.some((n) => n.startsWith('B5')),
      `exit=${r.code} 失败：${r.failedNames.join('；') || '（无）'}`,
    );
  }

  // 9 精简版里放一条改写过的 bullet（不是逐字回指任何 claim）
  {
    const dir = brokenCopy('slim-paraphrase', (d) => {
      patchFile(d, 'paste-ready-精简版.md', (s) =>
        s.replace(
          '- **过度归因防护的对照评测**',
          '- **过度归因防护的对照评测** 额外验证了多轮重复实验的稳定性',
        ),
      );
    });
    dirs.push(dir);
    const r = runValidator(dir);
    check(
      '9 精简版 bullet 被改写 → exit 1，且 B3 必须报错',
      r.code === 1 && r.failedNames.some((n) => n.startsWith('B3')),
      `exit=${r.code} 失败：${r.failedNames.join('；') || '（无）'}`,
    );
  }

  // 10 精简措辞没有人工复核说明
  {
    const dir = brokenCopy('compact-no-review', (d) => {
      const p = join(d, 'claim-ledger.json');
      const led = JSON.parse(readFileSync(p, 'utf8'));
      for (const c of led.claims) {
        if (c.candidate_wording_compact) delete c.compact_review_note;
      }
      writeFileSync(p, JSON.stringify(led, null, 2), 'utf8');
    });
    dirs.push(dir);
    const r = runValidator(dir);
    check(
      '10 精简措辞缺人工复核说明 → exit 1，且 B5 必须报错',
      r.code === 1 && r.failedNames.some((n) => n.startsWith('B5')),
      `exit=${r.code} 失败：${r.failedNames.join('；') || '（无）'}`,
    );
  }
} finally {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(
  failed.length === 0
    ? `\n简历包校验对照：${results.length}/${results.length} 通过`
    : `\n简历包校验对照：${results.length - failed.length}/${results.length} 通过（${failed
        .map((f) => f.name)
        .join('；')}）`,
);
process.exitCode = failed.length === 0 ? 0 : 1;
