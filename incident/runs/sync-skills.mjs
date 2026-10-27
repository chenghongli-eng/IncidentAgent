/**
 * 把 incident/skills/ 的 SKILL.md 同步到运行时 skill 目录。
 *
 * Agent 运行时加载的是 data/skills/<userId>/<skill-id>/SKILL.md，
 * incident/skills/ 只是源。改了源不同步，等于 Agent 还在用旧契约——
 * 上一轮 10-26 02:22Z 报告引用了带 Fault-F2 字样的 commit body，
 * 根子就在这里：源和运行时副本不是同一份。
 *
 * 幂等：内容一致就不写。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const SRC = join(ROOT, 'incident/skills');
const DST = join(ROOT, 'data/skills/68fcc7c5-f8ca-4265-acd5-f215f5aa24a4');

let changed = 0;
let same = 0;

for (const id of readdirSync(SRC)) {
  const src = join(SRC, id, 'SKILL.md');
  const dst = join(DST, id, 'SKILL.md');
  let content;
  try {
    content = readFileSync(src, 'utf8');
  } catch {
    continue;
  }
  let current = null;
  try {
    current = readFileSync(dst, 'utf8');
  } catch {}
  if (current === content) {
    same += 1;
    continue;
  }
  mkdirSync(join(DST, id), { recursive: true });
  writeFileSync(dst, content, 'utf8');
  changed += 1;
  console.log(`sync ${id}: 已更新运行时副本`);
}

console.log(`skills 同步完成：更新 ${changed} 个，一致 ${same} 个`);
