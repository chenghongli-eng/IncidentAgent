/**
 * 把 incident/sandbox/ 部署到沙箱目录（仓库外）。
 *
 * 为什么在仓库外：沙箱里 bind 进 Agent 的是**部署副本**，不是仓库里的源。
 * 仓库的 incident/ 目录整体对 Agent 不可见（答案键、故障注入脚本都在那里），
 * 只有这一个子目录例外——例外越小越好。
 *
 * 幂等：内容一致就不写。
 */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  chmodSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const LAB_PATHS = JSON.parse(
  readFileSync(join(ROOT, 'incident/lab-paths.json'), 'utf8'),
);

const POLICY = JSON.parse(
  readFileSync(join(ROOT, 'incident/sandbox/policy.json'), 'utf8'),
);

const SRC_DIR = join(ROOT, 'incident/sandbox');
const DST_DIR = POLICY.stateDir.replace(/\/run$/, '');
const DST_BIN = join(DST_DIR, 'bin');

const files = [
  {
    src: join(SRC_DIR, 'policy.json'),
    dst: join(DST_DIR, 'policy.json'),
    mode: 0o644,
  },
  {
    src: join(SRC_DIR, 'bin/docker'),
    dst: join(DST_BIN, 'docker'),
    mode: 0o755,
  },
];

for (const file of files) {
  const content = readFileSync(file.src, 'utf8');
  let current = null;
  try {
    current = readFileSync(file.dst, 'utf8');
  } catch {
    /* 不存在就写 */
  }
  mkdirSync(dirname(file.dst), { recursive: true });
  if (current === content) {
    console.log(`sandbox 同步：已是最新（${file.dst}）`);
  } else {
    writeFileSync(file.dst, content, 'utf8');
    chmodSync(file.dst, file.mode);
    console.log(`sandbox 同步：已更新（${file.dst}）`);
  }
}

// 部署目录必须在仓库外。放进仓库就等于把沙箱的入口放回答案键旁边。
if (DST_DIR.startsWith(ROOT.replace(/\/$/, ''))) {
  console.error(
    `沙箱部署目录必须在仓库外：${DST_DIR}\n` +
      '  仓库里的 incident/ 是答案键所在，Agent 可见范围不能包含它。',
  );
  process.exit(1);
}

if (!existsSync(join(DST_DIR, 'policy.json'))) {
  console.error('沙箱部署失败：policy.json 未落地');
  process.exit(1);
}
console.log(`sandbox 同步完成：${DST_DIR}`);
