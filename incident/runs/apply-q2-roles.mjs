#!/usr/bin/env node
/**
 * 把真值文件里的 Q2 换成「角色组」版（rubric v10）。
 *
 * 为什么是脚本而不是手抄 json：改判据这件事本身要能被复核。
 * 手抄会把「改了哪儿」变成一句口头描述；脚本每次都从源真值出发、
 * 按 `q2-roles.mjs` 里声明的唯一词表改，改完打印 diff 摘要。
 *
 * 用法：
 *   node incident/runs/apply-q2-roles.mjs <真值.json> [...]        # 就地改
 *   node incident/runs/apply-q2-roles.mjs <真值.json> --out <新文件>
 *   node incident/runs/apply-q2-roles.mjs <真值.json> --dry-run
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { q2Check } from './q2-roles.mjs';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const outIdx = argv.indexOf('--out');
const out = outIdx >= 0 ? argv[outIdx + 1] : null;
const files = argv.filter(
  (a, i) =>
    !a.startsWith('--') &&
    (outIdx < 0 || i !== outIdx + 1) &&
    a.endsWith('.json'),
);

if (!files.length) {
  console.error(
    '用法：apply-q2-roles.mjs <真值.json> [...] [--out <文件>] [--dry-run]',
  );
  process.exit(2);
}

for (const file of files) {
  const truth = JSON.parse(readFileSync(file, 'utf8'));
  const before = JSON.stringify(
    truth.quality?.find((q) => q.id === 'Q2') ?? null,
  );
  truth.quality = (truth.quality ?? []).map((q) =>
    q.id === 'Q2' ? q2Check() : q,
  );
  const after = JSON.stringify(truth.quality.find((q) => q.id === 'Q2'));
  const target = out ?? file;
  if (!dryRun) writeFileSync(target, JSON.stringify(truth, null, 2) + '\n');
  console.log(
    `${file} → ${target}\n` +
      `  改前：${before}\n` +
      `  改后：${after}\n` +
      `  其他 quality 判据：${truth.quality
        .filter((q) => q.id !== 'Q2')
        .map((q) => q.id)
        .join('、')}（未动）`,
  );
}
