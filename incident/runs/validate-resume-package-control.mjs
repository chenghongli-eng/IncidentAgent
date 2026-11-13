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

  // 0 真包：要么全绿，要么只差**已知的待授权更新项**。
  //
  // 已知项：claim-incident-103 那条 claim 还是 2026-11-11 的口径
  // （写着「重跑未执行」），而重跑批次在 2026-11-13 已经跑完。
  // 更新内容需要动**仓库外**的简历包，得用户点头，所以这里只断言
  // 「失败项不超出已知集合」——多出任何一项都算负对照失败。
  const KNOWN_PENDING = new Set(['B3', 'B6', 'C6', 'C7']);
  {
    const r = runValidator(PKG);
    const codes = [...new Set(r.failedNames.map((n) => n.split(' ')[0]))];
    const unknown = codes.filter((c) => !KNOWN_PENDING.has(c));
    const ok =
      (r.code === 0 && codes.length === 0) ||
      (r.code === 1 && codes.length > 0 && unknown.length === 0);
    check(
      '0 真包原样 → 要么 exit 0 全绿，要么只差已知的待授权更新项（B3/B6/C6/C7）',
      ok,
      `exit=${r.code} 失败项：${codes.join('、') || '（无）'}` +
        (unknown.length ? `　← 出现未知失败项：${unknown.join('、')}` : ''),
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
  // ── 合成绿色基线 ────────────────────────────────────────────────
  //
  // 真包在仓库外，而且此刻挂着**待授权的更新项**（103 那条 claim 还没按
  // 2026-11-13 的重跑批次改写），拿它当「该放过的要放过」的基线是不成立的。
  // 所以这里现造一个合成包：数字口径取自仓库内的机器可读总表
  // （incident/runs/real-target-rounds.json），措辞是占位文字。
  // 它必须全绿——否则后面 C6/C7 的负对照证明不了任何事。
  //
  // 口径**从总表里读**，不写死：写死的数字下一次改判据就会过期，
  // 而过期的合成基线会让所有负对照变成空转（它们都建立在「基线全绿」之上）。
  const TABLE = JSON.parse(
    readFileSync(join(here, 'real-target-rounds.json'), 'utf8'),
  );
  const Q2_RATIO = TABLE.ratios.q2_layered_attribution;
  const SYN_FULL = `**样本独立性审计（合成对照件）** 用合成靶子跑批：两臂合计 10 个独立样本、根因命中 10/10、发布归因 10/10、分层归因 ${Q2_RATIO}（口径：按不同层级角色计）；另有 10 次越界读取与 5 处数字问题待披露。`;
  const SYN_COMPACT = `**样本独立性（合成对照件）**：两臂合计 10 个独立样本、根因命中 10/10、发布归因 10/10、分层归因 ${Q2_RATIO}，其余问题另计。`;

  function makeSyntheticPackage(mutate) {
    const dir = mkdtempSync(join(tmpdir(), 'resume-pkg-synthetic-'));
    const ledger = {
      schema_version: 1,
      profile: {
        candidate_id: 'synthetic-control',
        target_roles: ['AI 应用工程师（Agent 方向）'],
        updated_at: '2026-11-13',
      },
      claims: [
        {
          id: 'claim-synthetic-001',
          project: 'miniclaw',
          artifact_refs: ['artifact-synthetic-001'],
          support_points: ['R25'],
          claim_types: ['metric', 'result'],
          claim_basis: 'user_attested',
          source_fact: '合成对照件：数字口径取自仓库内的机器可读总表。',
          candidate_wording: SYN_FULL,
          candidate_wording_compact: SYN_COMPACT,
          sources: [
            {
              type: 'run-evidence',
              location: 'incident/runs/real-target-rounds.json',
              public: true,
              note: '合成对照件',
            },
          ],
          attribution_scope: 'personal',
          responsibility_level: 'module_owner',
          result_type: 'phase_result',
          verification_status: 'confirmed',
          allowed_uses: ['audit', 'resume_draft', 'resume_final', 'interview'],
          interview_details: {
            decisions: ['合成对照件'],
            difficulties: ['合成对照件'],
            verification: ['合成对照件'],
            result: '合成对照件',
          },
          boundary: '合成对照件，不对外。',
          risk_notes: ['合成对照件。'],
          last_verified: '2026-11-13',
          compact_dropped: '合成对照件，细节已删。',
          compact_review_note: 'B5 把关：未引入原文没有的数字。',
        },
      ],
    };
    const files = {
      'claim-ledger.json': JSON.stringify(ledger, null, 2) + '\n',
      'paste-ready-当前可贴.md': `# 合成对照件\n\n- ${SYN_FULL}\n`,
      'paste-ready-最终版.md': `# 合成对照件\n\n- ${SYN_FULL}\n`,
      'paste-ready-精简版.md': `# 合成对照件\n\n- ${SYN_COMPACT}\n`,
      'paste-ready-审计区.md':
        '# 合成对照件审计区\n\n数字口径取自 incident/runs/real-target-rounds.json。\n',
    };
    if (mutate) mutate(files);
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content, 'utf8');
    }
    return dir;
  }

  // P0 合成包必须全绿（该放过的要放过）
  {
    const dir = makeSyntheticPackage();
    dirs.push(dir);
    const r = runValidator(dir);
    check(
      'P0 合成包原样 → exit 0，0 项失败',
      r.code === 0 && r.failedNames.length === 0,
      `exit=${r.code} 失败：${r.failedNames.join('；') || '（无）'}`,
    );
  }

  // N11 独立样本数与总表对不上
  {
    const dir = makeSyntheticPackage((files) => {
      for (const [name, content] of Object.entries(files)) {
        files[name] = content.replaceAll('10 个独立样本', '12 个独立样本');
      }
    });
    dirs.push(dir);
    const r = runValidator(dir);
    check(
      'N11 独立样本数漂成 12（总表是 10）→ exit 1，且 C6 必须报错',
      r.code === 1 && r.failedNames.some((n) => n.startsWith('C6')),
      `exit=${r.code} 失败：${r.failedNames.join('；') || '（无）'}`,
    );
  }

  // N12 简历包还写着旧口径（重跑未执行）
  {
    const dir = makeSyntheticPackage((files) => {
      const led = JSON.parse(files['claim-ledger.json']);
      led.claims[0].interview_details.result =
        '修复后重跑未执行，发布类命中率暂缺。';
      files['claim-ledger.json'] = JSON.stringify(led, null, 2) + '\n';
    });
    dirs.push(dir);
    const r = runValidator(dir);
    check(
      'N12 简历包仍写「重跑未执行」→ exit 1，且 C7 必须报错',
      r.code === 1 && r.failedNames.some((n) => n.startsWith('C7')),
      `exit=${r.code} 失败：${r.failedNames.join('；') || '（无）'}`,
    );
  }

  // N13 抬头里引用旧措辞是合法的（历史说明），不能被当成过期
  {
    const dir = makeSyntheticPackage((files) => {
      files['paste-ready-审计区.md'] +=
        '\n已把原来的「重跑未执行」披露换成实测后的披露。\n';
    });
    dirs.push(dir);
    const r = runValidator(dir);
    check(
      'N13 抬头里引用旧措辞不算过期 → exit 0',
      r.code === 0,
      `exit=${r.code} 失败：${r.failedNames.join('；') || '（无）'}`,
    );
  }

  // P1 近似阳性：把 Q2 那句换个说法（数字不变、仍写明新口径）→ 必须照样放行。
  //
  // 为什么要有它：N14 靠的是「旧口径那几句话」。如果校验其实是靠**别的**
  // 巧合拦住的（比如整个包都挂了），那 N14 的绿灯就毫无意义。
  // 所以先证明「只改措辞不改口径」是放得过的，再证明「退回旧口径」拦得住。
  {
    const dir = makeSyntheticPackage((files) => {
      for (const [name, content] of Object.entries(files)) {
        files[name] = content.replaceAll(
          `分层归因 ${Q2_RATIO}（口径：按不同层级角色计）`,
          `分层归因 ${Q2_RATIO}（按不同层级角色计）`,
        );
      }
    });
    dirs.push(dir);
    const r = runValidator(dir);
    check(
      `P1 Q2 那句换措辞、数字不变 → exit 0（${Q2_RATIO} 仍与总表一致）`,
      r.code === 0,
      `exit=${r.code} 失败：${r.failedNames.join('；') || '（无）'}`,
    );
  }

  // N14 简历包还写着旧的 Q2 口径（命中数是旧的，还声称「未改判据迁就」）
  {
    const dir = makeSyntheticPackage((files) => {
      for (const [name, content] of Object.entries(files)) {
        files[name] = content.replaceAll(
          `分层归因 ${Q2_RATIO}（口径：按不同层级角色计）`,
          '分层归因只命中 5/10，属能力缺口，未改判据迁就。',
        );
      }
    });
    dirs.push(dir);
    const r = runValidator(dir);
    check(
      'N14 简历包退回旧的 Q2 口径 → exit 1，且 C7 必须报错',
      r.code === 1 && r.failedNames.some((n) => n.startsWith('C7')),
      `exit=${r.code} 失败：${r.failedNames.join('；') || '（无）'}`,
    );
  }

  // N15 数字是对的，但把「判据改过」这件事悄悄抹掉 → C8 必须报错。
  //
  // 披露义务随数字一起走：命中数从 5/10 变成 7/10 的原因（判据口径改了）
  // 不能只存在于仓库的提交记录里，简历包里也要写明。
  {
    const dir = makeSyntheticPackage((files) => {
      for (const [name, content] of Object.entries(files)) {
        files[name] = content.replaceAll(`（口径：按不同层级角色计）`, '');
      }
    });
    dirs.push(dir);
    const r = runValidator(dir);
    check(
      'N15 命中数对、但抹掉了口径变更的披露 → exit 1，且 C8 必须报错',
      r.code === 1 && r.failedNames.some((n) => n.startsWith('C8')),
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
