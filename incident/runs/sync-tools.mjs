/**
 * 把 incident/tools/ 同步到 Agent 工作区。
 *
 * Agent 执行的是工作区里的那份只读 CLI（$INCIDENT_LAB 指向它），
 * incident/tools/ 只是源。改了源不同步，等于 Agent 还在用旧通道——
 * 和 skills 的源/副本分离是同一类问题。
 *
 * 路径真相源是 incident/lab-paths.json 的 readonlyCli。
 * 幂等：内容一致就不写。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const LAB_PATHS = JSON.parse(
  readFileSync(join(ROOT, 'incident/lab-paths.json'), 'utf8'),
);

const SRC_DIR = join(ROOT, 'incident/tools');
const DST = LAB_PATHS.readonlyCli;

const src = join(SRC_DIR, 'incident-readonly.mjs');
let content;
try {
  content = readFileSync(src, 'utf8');
} catch (err) {
  console.error(`读不到源文件 ${src}: ${err.message}`);
  process.exit(1);
}

let current = null;
try {
  current = readFileSync(DST, 'utf8');
} catch {}

if (current === content) {
  console.log(`tools 同步完成：工作区副本与源一致（${DST}）`);
} else {
  mkdirSync(dirname(DST), { recursive: true });
  writeFileSync(DST, content, 'utf8');
  console.log(`tools 同步完成：已更新工作区副本（${DST}）`);
}

// The collector is the only component that talks to the network and the only
// one that may hold credentials. It must stay outside the agent's reach: the
// agent runs the read-only CLI and nothing else. If a copy of the collector
// ever shows up next to it, the separation has been broken -- loudly, here,
// rather than quietly later.
const leaked = [
  join(dirname(DST), 'collect-registry.mjs'),
  join(dirname(DST), 'collector'),
  join(dirname(dirname(DST)), 'collector'),
];
const found = leaked.filter((p) => existsSync(p));
if (found.length > 0) {
  console.error(
    `采集器不该出现在 Agent 可达范围内：${found.join('、')}\n` +
      '  读侧 CLI 与联网采集器必须分开：Agent 只能读台账，不能写台账、不能联网。',
  );
  process.exit(1);
}
