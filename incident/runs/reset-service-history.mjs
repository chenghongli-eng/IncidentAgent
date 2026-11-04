#!/usr/bin/env node
// 把服务仓库复位成「干净基线」，给下一轮开跑用。
//
//   node incident/runs/reset-service-history.mjs --dry-run
//   node incident/runs/reset-service-history.mjs
//
// 为什么需要它（复核件 audit-2026-11-04T0324Z.md §4 的 L3）：
// 服务仓库的 HEAD 上还留着上一轮的缺陷提交（af73f23「feat(order): enrich
// response with downstream shipping address」）。下一轮若直接开跑，会出现两件事：
//   ① 上一轮的缺陷提交**在窗口内**，Agent 会看到「缺陷代码一直在 HEAD 上」，
//      「发布把缺陷带上去」这条叙事就被污染了；
//   ② 上一轮还留着一次注入 + 一次恢复（3ca923c / 7bb726a），git log 里会出现
//      「缺陷引入 → 缺陷修复 → 缺陷又引入」三条提交，看起来像来回摇摆的历史，
//      而其实只是实验室自己在反复开跑。
//
// 这个脚本做的事：
//   1. 找出**所有改动过缺陷文件**的提交（注入 / 恢复），把它们从链条里去掉；
//   2. 把保留下来的每个提交的树重新算一遍：缺陷文件一律换成**基线版本**，
//      于是保留下来的提交（工具类修复、初始化类提交）的 diff 里只剩它们
//      真正做过的事——提交说明与 diff 重新对齐；
//   3. 作者、提交者、日期、提交说明**逐字保留**（只换 tree 与 parent）；
//   4. 老链条先 bundle 到**仓库外**再改引用，避免旧对象还能被 `git log --all` 看到；
//   5. 工作区里的缺陷文件恢复成基线，下一轮的 `faults.mjs inject F2`
//      才会成功（它要求基线文本在位）。
//
// 关键不变量（脚本自己会验，验不过就不写）：
//   · 新链条里**没有任何提交**的 diff 涉及缺陷文件
//     —— 下一轮的注入提交将是链条里唯一一个碰它的提交；
//   · 除缺陷文件外，每个保留下来的提交改动的文件集合与改前**完全一致**；
//   · 新 HEAD 的树 = 老 HEAD 的树，但缺陷文件换成基线版本；
//   · 老链条已 bundle 到仓库外，且仓库内不再有指向它的 ref。
//
// 与 rebuild-service-history.mjs 的分工：
//   rebuild-*  负责「把某一类文件的历史 blob 重新基线化」，用于泄漏扫描归零；
//   reset-*    负责「把缺陷提交从链条里摘掉，并把链条重新对齐」，用于新一轮开跑。
// 两者都会先 bundle 老链条到仓库外。

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LAB_PATHS = JSON.parse(
  readFileSync(new URL('../lab-paths.json', import.meta.url), 'utf8'),
);
const REPO = process.env.TARGET_REPO ?? LAB_PATHS.workspaceRoot;
const ARCHIVE_DIR =
  process.env.INCIDENT_HISTORY_ARCHIVE ?? LAB_PATHS.archiveDir;
/**
 * 归档文件名带时间戳，不能用固定名。
 *
 * 2026-11-04 踩过：第一次复位归档成 `service-repo-pre-reset.bundle`，
 * 第二次复位（对照实验之后）**用同一个文件名覆盖了它**，
 * 于是 11-04 那轮的缺陷提交对象连同第一次的归档一起没了。
 * 归档是「实验室改过历史」的证据（D3 教训：不能靠剪历史来藏注入），
 * 一次复位覆盖掉上一次的归档，等于把证据剪掉了——比不改还糟。
 */
const STAMP = new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace(/\..+$/, 'Z');
const ARCHIVE = join(ARCHIVE_DIR, `service-repo-pre-reset-${STAMP}.bundle`);
const ARCHIVE_README = join(ARCHIVE_DIR, `README-reset-${STAMP}.txt`);
const DRY_RUN = process.argv.includes('--dry-run');

// 缺陷文件：F2 注入改的就是它（与 incident/faults/faults.mjs 的 FAULTS[0].file 一致）。
const FAULT_FILE =
  'target-service/src/main/java/com/example/target/OrderService.java';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function git(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 << 20,
    ...opts,
  }).trim();
}

function gitRaw(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 << 20,
    ...opts,
  });
}

function fail(msg) {
  process.stderr.write(`reset aborted: ${msg}\n`);
  process.exit(1);
}

function parentOrEmpty(sha) {
  try {
    return git(['rev-parse', '--verify', `${sha}^`], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return EMPTY_TREE;
  }
}

function changedFiles(sha) {
  return git(['diff', '--name-only', parentOrEmpty(sha), sha])
    .split('\n')
    .filter(Boolean);
}

/** 用给定 tree 与父提交重建一个提交（作者/日期/说明逐字保留）。 */
function commitWithTree(oldCommit, tree, parent) {
  const raw = gitRaw(['cat-file', 'commit', oldCommit]);
  const split = raw.indexOf('\n\n');
  const message = raw.slice(split + 2);
  const [an, ae, aI, cn, ce, cI] = git([
    'show',
    '-s',
    '--format=%an%n%ae%n%aI%n%cn%n%ce%n%cI',
    oldCommit,
  ]).split('\n');
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: an,
    GIT_AUTHOR_EMAIL: ae,
    GIT_AUTHOR_DATE: aI,
    GIT_COMMITTER_NAME: cn,
    GIT_COMMITTER_EMAIL: ce,
    GIT_COMMITTER_DATE: cI,
  };
  const args = ['commit-tree', tree];
  if (parent) args.push('-p', parent);
  return execFileSync('git', args, {
    cwd: REPO,
    input: message,
    encoding: 'utf8',
    env,
  }).trim();
}

/** 取某个 tree 里指定路径的 blob（不存在则 null）。 */
function blobInTree(tree, path) {
  try {
    // 空树里没有这个路径时 git 会往 stderr 写一行「路径在磁盘上但不在该树中」，
    // 那不是错误，只是「不存在」。把 stderr 收掉，别让预检看起来像崩了。
    return git(['rev-parse', `${tree}:${path}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

/** 造一个 tree：把 path 换成 blob（blob 为 null 表示删除该路径）。 */
function treeWithFile(tree, path, blob) {
  const index = join(
    process.env.TMPDIR ?? '/tmp',
    `reset-index-${process.pid}`,
  );
  const env = { ...process.env, GIT_INDEX_FILE: index };
  git(['read-tree', tree], { env });
  if (blob === null) {
    git(['update-index', '--force-remove', path], { env });
  } else {
    git(['update-index', '--cacheinfo', `100644,${blob},${path}`], { env });
  }
  const out = git(['write-tree'], { env });
  return out;
}

// ---- 读取现状 --------------------------------------------------------------
const oldChain = git(['rev-list', '--reverse', 'HEAD'])
  .split('\n')
  .filter(Boolean);
if (!oldChain.length) fail('no commits in the service repo');
const oldHead = oldChain[oldChain.length - 1];

/**
 * 哪些提交**改过**缺陷文件。
 *
 * 注意不能直接用 `git diff --name-only`：根提交对空树的 diff 会列出它创建的
 * 每一个文件，于是「服务初始化提交」也会被当成缺陷提交——根提交只是**新增**
 * 了这个文件，并没有改动它。判据用 blob 比较：父提交里存在该文件、且内容不同，
 * 才算「改过」。
 */
function modifiedFaultFile(sha) {
  const parent = parentOrEmpty(sha);
  const before = blobInTree(parent, FAULT_FILE);
  const after = blobInTree(git(['rev-parse', `${sha}^{tree}`]), FAULT_FILE);
  return before !== null && after !== null && before !== after;
}

const faultCommits = oldChain.filter((c) => modifiedFaultFile(c));
if (!faultCommits.length) {
  process.stdout.write(
    'nothing to reset: no commit in the chain touches the fault file\n',
  );
  process.exit(0);
}

// 基线版本 = 第一个缺陷提交**之前**那个提交里的缺陷文件。
const firstFaultIdx = oldChain.indexOf(faultCommits[0]);
const baselineSource = firstFaultIdx > 0 ? oldChain[firstFaultIdx - 1] : null;
if (!baselineSource) fail('the first fault commit is the root commit');
const baselineBlob = blobInTree(
  git(['rev-parse', `${baselineSource}^{tree}`]),
  FAULT_FILE,
);
if (!baselineBlob) fail(`the fault file does not exist at ${baselineSource}`);

// ---- 重建链条 --------------------------------------------------------------
const newChain = [];
const dropped = [];
let parent = null;

for (const old of oldChain) {
  if (faultCommits.includes(old)) {
    dropped.push({
      old,
      subject: git(['log', '-1', '--format=%s', old]),
    });
    continue;
  }
  const oldTree = git(['rev-parse', `${old}^{tree}`]);
  const currentBlob = blobInTree(oldTree, FAULT_FILE);
  const newTree =
    currentBlob === baselineBlob
      ? oldTree
      : treeWithFile(oldTree, FAULT_FILE, baselineBlob);
  const newSha = commitWithTree(old, newTree, parent);
  newChain.push({ old, renamed: newSha });
  parent = newSha;
}

if (!newChain.length) fail('the reset produced an empty chain');

// ---- 不变量 ----------------------------------------------------------------
// 1. 新链条里没有任何提交的 diff 涉及缺陷文件。
for (const { renamed } of newChain) {
  // 用「改过」而不是「出现在 diff 里」：根提交新增该文件时 diff 里也会有它。
  if (modifiedFaultFile(renamed)) {
    fail(`commit ${renamed} still modifies ${FAULT_FILE}`);
  }
}

// 2. 除缺陷文件外，改动的文件集合与改前一致。
for (const { old, renamed } of newChain) {
  const oldFiles = changedFiles(old).filter((f) => f !== FAULT_FILE);
  const newFiles = changedFiles(renamed).filter((f) => f !== FAULT_FILE);
  const missing = oldFiles.filter((f) => !newFiles.includes(f));
  const extra = newFiles.filter((f) => !oldFiles.includes(f));
  if (missing.length || extra.length) {
    fail(
      `commit ${renamed} changed a different set of files than ${old}: ` +
        `missing=${missing.join(',') || '-'} extra=${extra.join(',') || '-'}`,
    );
  }
}

// 3. 新 HEAD 的树 = 老 HEAD 的树，但缺陷文件换成基线版本。
const oldHeadTree = git(['rev-parse', `${oldHead}^{tree}`]);
const expectedHeadTree = treeWithFile(oldHeadTree, FAULT_FILE, baselineBlob);
const newHead = newChain[newChain.length - 1].renamed;
const newHeadTree = git(['rev-parse', `${newHead}^{tree}`]);
if (newHeadTree !== expectedHeadTree) {
  fail('the reset HEAD tree differs from the expected tree');
}

// 4. 每个保留下来的提交，提交说明逐字未变。
for (const { old, renamed } of newChain) {
  const a = git(['show', '-s', '--format=%B', old]);
  const b = git(['show', '-s', '--format=%B', renamed]);
  if (a !== b) fail(`commit ${renamed} has a different message than ${old}`);
  const da = git(['show', '-s', '--format=%aI', old]);
  const db = git(['show', '-s', '--format=%aI', renamed]);
  if (da !== db) fail(`commit ${renamed} has a different author date`);
}

// ---- 落盘 ------------------------------------------------------------------
if (DRY_RUN) {
  process.stdout.write('dry run, nothing written\n');
} else {
  mkdirSync(ARCHIVE_DIR, { recursive: true });
  writeFileSync(
    ARCHIVE_README,
    `service-repo-pre-reset-${STAMP}.bundle holds the service repo history as it was\n` +
      `before the ${STAMP} baseline reset. It contains the previous rounds' fault commits\n` +
      '(injection / restore). The lab ledger (injections.log, same directory) records\n' +
      'what was injected and when. Read them without touching the lab repo:\n' +
      `  git bundle verify service-repo-pre-reset-${STAMP}.bundle\n` +
      `  git clone service-repo-pre-reset-${STAMP}.bundle /tmp/old-service-repo\n`,
  );
  git(['bundle', 'create', ARCHIVE, '--all']);
  git(['bundle', 'verify', ARCHIVE]);

  git(['update-ref', 'refs/heads/main', newHead]);
  git(['reset', '--mixed']);
  // 工作区里的缺陷文件恢复成基线：下一轮的 faults.mjs inject 要求基线文本在位。
  git(['checkout', 'HEAD', '--', FAULT_FILE]);
  git(['reflog', 'expire', '--expire=now', '--all']);
  git(['gc', '--prune=now', '--quiet']);
}

process.stdout.write(`${DRY_RUN ? 'planned' : 'reset'} service history\n`);
process.stdout.write(
  `  dropped fault commits: ${dropped
    .map((d) => `${d.old.slice(0, 7)} ${d.subject}`)
    .join(' / ')}\n`,
);
process.stdout.write(
  `  new chain: ${newChain.map((c) => c.renamed.slice(0, 7)).join(' / ')}\n`,
);
if (!DRY_RUN) {
  process.stdout.write(`  old chain archived at: ${ARCHIVE}\n`);
  process.stdout.write(
    `  working tree ${FAULT_FILE} restored to baseline (${baselineBlob.slice(0, 7)})\n`,
  );
}
