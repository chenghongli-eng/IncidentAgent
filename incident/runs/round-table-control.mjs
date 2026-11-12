#!/usr/bin/env node
/**
 * round-table 的负对照：证明这张表**该判无效的判得出来、该判有效的判得出来**。
 *
 * 为什么要有这个：这张表出过三次「数字与证据不一致」的亏，而且形态一次比一次隐蔽：
 *   ① 读不了脱敏后的路径 → 12 轮全判成「未跑完」（全假）
 *   ② 审计脚本在管道里被截断 → 下游把「审计没跑成」当成「干净」
 *   ③ transcript 解析不出来 + 审计 not_run → **有分数的轮次照样判成有效**（2026-11-02 复现）
 * ③ 是 0350Z 那条无效轮的病根：它当时就是「没有审计记录 = 没有污染」。
 * 它后来作废，靠的是后来手工补跑审计，不是表自己发现的。
 *
 * 做法：在临时目录里造合成 manifest（不碰真实证据件），逐个断言表的判定；
 * 再跑一次没动过的真表，看它还认那 3 轮有效轮。
 *
 * 用法：node incident/runs/round-table-control.mjs
 */
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  writeFileSync,
  copyFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const TABLE = join(here, 'round-table.mjs');
const RUNS = here;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** 在临时目录里造一批合成 manifest，返回目录。 */
function synthDir(name, manifests) {
  const dir = mkdtempSync(join(tmpdir(), `round-table-${name}-`));
  for (const [file, body] of Object.entries(manifests)) {
    writeFileSync(join(dir, file), JSON.stringify(body, null, 2), 'utf8');
  }
  return dir;
}

/** 从输出里抠出 JSON 数组——`--json` 之后还会接着打 markdown 表。 */
function extractJson(out) {
  const start = out.indexOf('[');
  if (start < 0) throw new Error('输出里没有 JSON 数组');
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < out.length; i++) {
    const c = out[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (c === '\\') {
      esc = true;
      continue;
    }
    if (c === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return out.slice(start, i + 1);
    }
  }
  throw new Error('JSON 数组没闭合');
}

/** 跑表并解析出某一轮的有效判定。 */
function verdicts(dir, env = {}) {
  const r = spawnSync(process.execPath, [TABLE, dir, '--json'], {
    encoding: 'utf8',
    maxBuffer: 32 << 20,
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) {
    throw new Error(
      `表没跑出来（exit ${r.status}）：\n${r.stderr || r.stdout}`,
    );
  }
  const rows = JSON.parse(extractJson(r.stdout));
  return new Map(rows.map((x) => [x.stamp, x]));
}

/**
 * 合成一份独立性审计产物。
 *
 * 为什么要能喂假的审计：合成轮次跑不出真的审计结果（真审计量的是真日志面、
 * 真源码面），而「污染的轮次要剔出分母」这条判据恰恰只能在合成轮次上断言。
 * 四条对照用**同一份**合成 manifest，只换审计判定——差别只在这一个变量。
 */
function synthAudit(dir, rounds) {
  const file = join(dir, 'independence-audit.json');
  writeFileSync(
    file,
    JSON.stringify(
      {
        generated_at: '2026-11-12T00:00:00.000Z',
        rounds,
        independent: rounds
          .filter((r) => r.verdict === 'independent')
          .map((r) => r.stamp),
        contaminated: rounds
          .filter((r) => r.verdict === 'contaminated')
          .map((r) => r.stamp),
        unknown: rounds
          .filter((r) => r.verdict === 'unknown')
          .map((r) => r.stamp),
      },
      null,
      2,
    ),
    'utf8',
  );
  return file;
}

const real = verdicts(RUNS);
const REAL_VALID = ['2026-10-30T0423Z', '2026-10-30T0431Z', '2026-10-30T0738Z'];
const REAL_INVALID = ['2026-10-30T0350Z'];

const dirs = [];
try {
  console.log('round-table 负对照：\n');

  // 0 真表必须还认那 3 轮
  {
    const stillValid = REAL_VALID.filter((s) => real.get(s)?.valid);
    const stillInvalid = REAL_INVALID.filter((s) => !real.get(s)?.valid);
    check(
      '0 真表：3 轮有效 + 0350Z 无效',
      stillValid.length === 3 && stillInvalid.length === 1,
      `有效 ${stillValid.join('、') || '无'} / 无效 ${stillInvalid.join('、') || '无'}`,
    );
  }

  // A 有分数 + 无 transcript + 审计 not_run → 必须判无效（0350Z 的病根）
  {
    const dir = synthDir('audit-unknown', {
      'round-manifest-2026-11-02T9999Z.json': {
        stamp: '2026-11-02T9999Z',
        fault: 'F2',
        agent: {
          report: '<repo>/incident/runs/agent-report-2026-10-30T0738Z.md',
          chars: 100,
        },
        score: { path: '<repo>/incident/runs/score-2026-10-30T0738Z.json' },
        channel_audit: {
          verdict: 'not_run',
          why: '审计脚本没产出可解析的结果',
        },
      },
    });
    dirs.push(dir);
    const v = verdicts(dir);
    const row = v.get('2026-11-02T9999Z');
    check(
      'A 有分数 + 审计 not_run + 无 transcript → 判无效',
      row && row.valid === false,
      `valid=${row?.valid} 原因=${(row?.invalid_reason ?? '').split('\n')[0]}`,
    );
  }

  // B 有分数 + 审计判污染 → 判无效
  {
    const dir = synthDir('contaminated', {
      'round-manifest-2026-11-02T9998Z.json': {
        stamp: '2026-11-02T9998Z',
        fault: 'F2',
        agent: {
          report: '<repo>/incident/runs/agent-report-2026-10-30T0738Z.md',
          chars: 100,
        },
        score: { path: '<repo>/incident/runs/score-2026-10-30T0738Z.json' },
        channel_audit: {
          verdict: 'contaminated',
          contaminating: 1,
          out_of_surface: 4,
        },
      },
    });
    dirs.push(dir);
    const v = verdicts(dir);
    check(
      'B 有分数 + 审计判污染 → 判无效',
      v.get('2026-11-02T9998Z')?.valid === false,
      `valid=${v.get('2026-11-02T9998Z')?.valid}`,
    );
  }

  // C 有分数 + manifest 标了无效 → 判无效
  {
    const dir = synthDir('flagged', {
      'round-manifest-2026-11-02T9997Z.json': {
        stamp: '2026-11-02T9997Z',
        fault: 'F2',
        agent: {
          report: '<repo>/incident/runs/agent-report-2026-10-30T0738Z.md',
          chars: 100,
        },
        score: { path: '<repo>/incident/runs/score-2026-10-30T0738Z.json' },
        round_valid: false,
        invalid_reason: '本轮中止',
      },
    });
    dirs.push(dir);
    const v = verdicts(dir);
    check(
      'C manifest 自己标了无效 → 判无效',
      v.get('2026-11-02T9997Z')?.valid === false,
      `valid=${v.get('2026-11-02T9997Z')?.valid}`,
    );
  }

  // D 有分数 + 审计记录与当场审计不一致 → 判无效（口径变更或证据被动过）
  {
    const dir = synthDir('mismatch', {
      'round-manifest-2026-11-02T9996Z.json': {
        stamp: '2026-11-02T9996Z',
        fault: 'F2',
        agent: {
          report: '<repo>/incident/runs/agent-report-2026-10-30T0738Z.md',
          chars: 100,
          transcript:
            '<repo>/incident/runs/session-transcripts/2026-10-30T07-55-36-536Z_01a18bce-9ed8-7f57-b14b-2adcfdad5a03.jsonl',
        },
        score: { path: '<repo>/incident/runs/score-2026-10-30T0738Z.json' },
        channel_audit: {
          verdict: 'out_of_surface',
          contaminating: 0,
          out_of_surface: 999,
        },
      },
    });
    dirs.push(dir);
    const v = verdicts(dir);
    check(
      'D 审计记录与当场审计对不上 → 判无效',
      v.get('2026-11-02T9996Z')?.valid === false,
      `valid=${v.get('2026-11-02T9996Z')?.valid} 原因=${(v.get('2026-11-02T9996Z')?.invalid_reason ?? '').split('\n')[0]}`,
    );
  }

  // E 什么都没跑完（没有分数）→ 判无效
  {
    const dir = synthDir('no-score', {
      'round-manifest-2026-11-02T9995Z.json': {
        stamp: '2026-11-02T9995Z',
        fault: 'F2',
        agent: {
          report: '<repo>/incident/runs/agent-report-2026-10-30T0738Z.md',
          chars: 100,
        },
      },
    });
    dirs.push(dir);
    const v = verdicts(dir);
    check(
      'E 没有分数 → 判无效',
      v.get('2026-11-02T9995Z')?.valid === false,
      `valid=${v.get('2026-11-02T9995Z')?.valid}`,
    );
  }

  // F 全都合法 → 判有效（该放过的要放过）
  {
    const dir = synthDir('clean', {
      'round-manifest-2026-11-02T9994Z.json': {
        stamp: '2026-11-02T9994Z',
        fault: 'F2',
        agent: {
          report: '<repo>/incident/runs/agent-report-2026-10-30T0738Z.md',
          chars: 100,
          transcript:
            '<repo>/incident/runs/session-transcripts/2026-10-30T07-55-36-536Z_01a18bce-9ed8-7f57-b14b-2adcfdad5a03.jsonl',
        },
        score: { path: '<repo>/incident/runs/score-2026-10-30T0738Z.json' },
        channel_audit: {
          verdict: 'out_of_surface',
          contaminating: 0,
          out_of_surface: 10,
        },
      },
    });
    dirs.push(dir);
    const v = verdicts(dir);
    check(
      'F 分数齐全 + 审计干净 + 记录与当场一致 → 判有效',
      v.get('2026-11-02T9994Z')?.valid === true,
      `valid=${v.get('2026-11-02T9994Z')?.valid}`,
    );
  }

  // ── 样本独立性判据（G/H/I/J）───────────────────────────────────────
  //
  // 这一组是「同一份 manifest，只换审计判定」：分数、报告、transcript 全一样，
  // 唯一变量是独立性审计怎么说。四条一起断言，才不会出现「判据形同虚设」。
  //
  // 判据本身踩过的坑：表读的字段名（`independent`）与审计产出的字段名
  // （`verdict`）对不上，于是污染的轮次从来没被剔出过分母，而表里那一列
  // 还在显示「否（陈旧 null）」——列在、汇总在、判据不生效。
  {
    const dir = synthDir('independence', {
      'round-manifest-2026-11-02T9993Z.json': {
        stamp: '2026-11-02T9993Z',
        fault: 'R2',
        target: { mode: 'descriptor' },
        agent: {
          report: '<repo>/incident/runs/agent-report-2026-10-30T0738Z.md',
          chars: 100,
          transcript:
            '<repo>/incident/runs/session-transcripts/2026-10-30T07-55-36-536Z_01a18bce-9ed8-7f57-b14b-2adcfdad5a03.jsonl',
        },
        score: { path: '<repo>/incident/runs/score-2026-10-30T0738Z.json' },
        channel_audit: {
          verdict: 'out_of_surface',
          contaminating: 0,
          out_of_surface: 10,
        },
      },
    });
    dirs.push(dir);
    const stamp = '2026-11-02T9993Z';
    const base = {
      stamp,
      injected_at: '2026-11-02T09:00:00.000Z',
      measured_surfaces: 5,
      unmeasured_surfaces: 0,
      surfaces: [],
    };

    // G 负：审计判污染 → 剔出分母
    {
      const audit = synthAudit(dir, [
        {
          ...base,
          verdict: 'contaminated',
          surfaces: [
            {
              surface: 'logs_channel',
              status: 'measured',
              traces_before_injection: 7,
            },
          ],
        },
      ]);
      const v = verdicts(dir, { INDEPENDENCE_AUDIT_JSON: audit });
      const row = v.get(stamp);
      check(
        'G 负对照：审计判污染 → 判无效（剔出分母）',
        row?.valid === false && /污染/.test(row?.invalid_reason ?? ''),
        `valid=${row?.valid} 原因=${(row?.invalid_reason ?? '').split('\n')[0]}`,
      );
    }

    // H 负：审计判未知（有一张面量不到）→ 同样剔出分母
    {
      const audit = synthAudit(dir, [
        { ...base, verdict: 'unknown', unmeasured_surfaces: 2 },
      ]);
      const v = verdicts(dir, { INDEPENDENCE_AUDIT_JSON: audit });
      const row = v.get(stamp);
      check(
        'H 负对照：审计判未知（量不到的面）→ 判无效（未知不等于干净）',
        row?.valid === false && /未知/.test(row?.invalid_reason ?? ''),
        `valid=${row?.valid} 原因=${(row?.invalid_reason ?? '').split('\n')[0]}`,
      );
    }

    // I 负：审计里根本没有这一轮 → 判未知 → 剔出分母
    {
      const audit = synthAudit(dir, []);
      const v = verdicts(dir, { INDEPENDENCE_AUDIT_JSON: audit });
      const row = v.get(stamp);
      check(
        'I 负对照：审计里没有这一轮 → 判无效（不是「干净」）',
        row?.valid === false && /未知/.test(row?.invalid_reason ?? ''),
        `valid=${row?.valid} 原因=${(row?.invalid_reason ?? '').split('\n')[0]}`,
      );
    }

    // J 正（近似）：审计判独立 → 判有效（其余条件与上面三条完全一样）
    {
      const audit = synthAudit(dir, [{ ...base, verdict: 'independent' }]);
      const v = verdicts(dir, { INDEPENDENCE_AUDIT_JSON: audit });
      const row = v.get(stamp);
      check(
        'J 正对照（近似）：审计判独立 → 判有效',
        row?.valid === true,
        `valid=${row?.valid} 原因=${(row?.invalid_reason ?? '').split('\n')[0]}`,
      );
    }
  }
} finally {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(
  failed.length === 0
    ? `\nround-table 对照：${results.length}/${results.length} 通过`
    : `\nround-table 对照：${results.length - failed.length}/${results.length} 通过（${failed
        .map((f) => f.name)
        .join('；')}）`,
);
process.exitCode = failed.length === 0 ? 0 : 1;
