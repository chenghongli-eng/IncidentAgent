#!/usr/bin/env node
/**
 * 源码面量具的两条对照：
 *
 *   1. 读失败**不许**被当成「干净」——不许出现「量具读不到，却报没有外来
 *      提交」。这是假阴性：量具坏了，样本就被放行了。
 *   2. 对象清单大到超过 execFileSync 默认缓冲时，清库动作要能跑完。
 *      真实仓库的对象清单已经 1.3MB，超过默认的 1MB——这个坑让一整批 5 轮
 *      全灭（错误信息里混着几万行 git 输出，看起来像 git 自己坏了）。
 *
 * 正对照与负对照尽量近似：同一个函数、同一类输入，只差「读得到 / 读不到」。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const { measureSourceSurface } = await import(
  new URL('./independence-surfaces.mjs', import.meta.url).href
);
const { purgeLabCommits } = await import(
  new URL('./real-release.mjs', import.meta.url).href
);

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`✓ ${name}${detail ? `：${detail}` : ''}`);
  } else {
    fail += 1;
    console.log(`✗ ${name}${detail ? `：${detail}` : ''}`);
  }
}

const work = mkdtempSync(join(tmpdir(), 'source-surface-control-'));
try {
  // ── 对照 A（负）：源码快照目录存在但不是 git 仓库 ─────────────────────
  // 近似正对照在下面：同样的目录结构、同样的参数，只差「它是个真仓库」。
  const notARepo = join(work, 'not-a-repo');
  execFileSync('mkdir', ['-p', notARepo]);
  const broken = measureSourceSurface(notARepo, {
    head: null,
    injectedAt: new Date().toISOString(),
    pristineRepo: notARepo,
  });
  check(
    'A 负对照：源码快照读不出来时报「量不到」，不报「干净」',
    broken.status === 'not_measured',
    `status=${broken.status} why=${broken.why ?? '(无)'}（期望 not_measured）`,
  );
  check(
    'A 负对照：读失败的量具不给出「外来提交 0 条」这种干净结论',
    broken.status !== 'measured',
    `status=${broken.status}（若为 measured 就是假阴性）`,
  );

  // ── 对照 B（正，近似）：真仓库 + 真原始仓库 → 量得到，且没有外来提交 ──
  const repo = join(work, 'repo');
  const pristine = join(work, 'pristine');
  for (const dir of [repo, pristine]) {
    execFileSync('mkdir', ['-p', dir]);
    execFileSync('git', ['-C', dir, 'init', '-q']);
    execFileSync('git', ['-C', dir, 'config', 'user.email', 'c@lab.local']);
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'control']);
    writeFileSync(join(dir, 'a.txt'), 'hello\n');
    execFileSync('git', ['-C', dir, 'add', 'a.txt']);
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'base']);
  }
  const clean = measureSourceSurface(repo, {
    head: execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim(),
    injectedAt: new Date().toISOString(),
    pristineRepo: pristine,
  });
  check(
    'B 正对照（近似）：同样的调用，真仓库量得到且没有外来提交',
    clean.status === 'measured' && clean.foreign_count === 0,
    `status=${clean.status} foreign_count=${clean.foreign_count}`,
  );

  // ── 对照 C（负）：原始仓库不在 → 量不到，不是干净 ────────────────────
  const noPristine = measureSourceSurface(repo, {
    head: null,
    injectedAt: new Date().toISOString(),
    pristineRepo: join(work, 'missing'),
  });
  check(
    'C 负对照：没有原始仓库就分不出「实验留下的」和「项目自带的」，记量不到',
    noPristine.status === 'not_measured',
    `status=${noPristine.status}`,
  );

  // ── 对照 D（正，近似）：对象清单超过 1MB 时清库照样跑完 ───────────────
  // 清单的体积由**对象条数**决定（每行约 49 字节），不是由对象大小决定：
  // 一个 1.4MB 的大文件只占一行，撑不破缓冲。要越过 1MB 需要 2 万多条对象。
  const big = join(work, 'big-repo');
  execFileSync('mkdir', ['-p', big]);
  execFileSync('git', ['-C', big, 'init', '-q']);
  execFileSync('git', ['-C', big, 'config', 'user.email', 'c@lab.local']);
  execFileSync('git', ['-C', big, 'config', 'user.name', 'control']);
  const many = 26000;
  for (let i = 0; i < many; i += 1) {
    writeFileSync(join(big, `f${i}.txt`), `x${i}\n`);
  }
  execFileSync('git', ['-C', big, 'add', '.']);
  execFileSync('git', ['-C', big, 'commit', '-qm', 'many blobs']);
  const listingBytes = execFileSync(
    'git',
    [
      '-C',
      big,
      'cat-file',
      '--batch-all-objects',
      '--batch-check=%(objectname) %(objecttype)',
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  ).length;
  let purgeOk = false;
  let purgeErr = '';
  try {
    purgeLabCommits(big);
    purgeOk = true;
  } catch (err) {
    purgeErr = err.message.slice(0, 200);
  }
  check(
    'D 正对照（近似）：对象清单大于 1MB 时清库跑得完（不抛 ENOBUFS）',
    purgeOk && listingBytes > 1024 * 1024,
    purgeOk
      ? `清单 ${listingBytes} 字节（>1MB），清库完成`
      : `清单 ${listingBytes} 字节，清库抛错：${purgeErr}`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log('');
console.log(
  fail === 0
    ? `对照通过 ${pass}/${pass + fail}`
    : `对照通过 ${pass}/${pass + fail}`,
);
process.exit(fail === 0 ? 0 : 1);
