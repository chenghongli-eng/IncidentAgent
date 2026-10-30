#!/usr/bin/env node
// Rebuild the service repo history so that no commit diff leaks the answer.
//
//   node incident/runs/rebuild-service-history.mjs --dry-run
//   node incident/runs/rebuild-service-history.mjs
//
// Why this exists: the leak scan (leak-scan.mjs) treats any commit diff as
// agent-readable evidence, so removing a leaky comment from the working tree
// is not enough -- the comment survives inside the diff of the commit that
// introduced it and the diff of the commit that removed it. The only way to
// get the scan to 0 hits is to rebuild the chain so the comment never existed.
//
// What it preserves, and why that matters:
//   - The raw commit object is copied byte for byte except for the tree line
//     and the parent line. Author, committer, dates and message body survive
//     exactly. The deployment-window story depends on the author timestamps
//     being what they are; the F4 round reasoned about "no code change inside
//     the window" using those timestamps.
//   - The final tree is byte-identical to the old final tree, so the deployed
//     image and the working tree keep matching the repo.
//   - Commits that become empty (the diff was only the cleanup we just
//     re-baselined) are dropped instead of being kept as no-op noise.
//
// The old chain is bundled OUTSIDE the repository first: the audit file and the
// claim ledger cite its SHAs, and keeping a ref inside the repo would keep the
// leak reachable through `git log --all`.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const REPO = join(ROOT, 'incident/workspace');
const ARCHIVE_DIR = process.env.INCIDENT_HISTORY_ARCHIVE ?? join(process.env.HOME, 'incident-lab-archive');
const ARCHIVE = join(ARCHIVE_DIR, 'service-repo-pre-rebuild.bundle');
const DRY_RUN = process.argv.includes('--dry-run');

// Files whose historical blobs are re-baselined to the working-tree version.
// The working tree is the authority: the source was cleaned there first, so
// rebuilding from it produces blobs that match it byte for byte.
const REBASELINE = ['target-service/src/main/resources/data.sql'];

function git(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 << 20,
    ...opts,
  }).trim();
}

function gitRaw(args, opts = {}) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 << 20, ...opts });
}

function blobOfWorkingTree(path) {
  const content = readFileSync(join(REPO, path));
  return git(['hash-object', '-w', '--stdin'], { input: content }).trim();
}

// The root commit has no parent; diff it against the empty tree.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
function parentOrEmpty(sha) {
  try {
    // The root commit has no parent; keep git's complaint off stderr.
    return git(['rev-parse', '--verify', `${sha}^`], { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    return EMPTY_TREE;
  }
}

function changedFiles(sha) {
  return git(['diff', '--name-only', parentOrEmpty(sha), sha]).split('\n').filter(Boolean);
}

function treeWithRebaselinedBlobs(commit) {
  const index = join(tmpdir(), `rebuild-index-${process.pid}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  git(['read-tree', commit], { env });
  for (const path of REBASELINE) {
    const blob = blobOfWorkingTree(path);
    git(['update-index', '--cacheinfo', `100644,${blob},${path}`], { env });
  }
  const tree = git(['write-tree'], { env });
  return tree;
}

// Copy a commit object verbatim, swapping in a new tree and a new parent.
function commitWithTree(oldCommit, newTree, newParent) {
  const raw = gitRaw(['cat-file', 'commit', oldCommit]);
  const split = raw.indexOf('\n\n');
  const header = raw.slice(0, split);
  const message = raw.slice(split + 2);
  let newHeader = header;
  const origTree = header.match(/^tree (.+)$/m)?.[1];
  if (origTree === undefined) throw new Error(`no tree line in ${oldCommit}`);
  // A commit whose tree is already the re-baselined one keeps its tree line;
  // it becomes a no-op and is dropped by the caller.
  if (origTree !== newTree) {
    newHeader = header.replace(/^tree .*$/m, `tree ${newTree}`);
    if (newHeader === header) throw new Error(`could not rewrite tree line of ${oldCommit}`);
  }
  if (newParent) {
    const before = newHeader;
    newHeader = newHeader.replace(/^parent .*$/m, `parent ${newParent}`);
    if (newHeader === before) throw new Error(`could not rewrite parent line of ${oldCommit}`);
  }
  return git(['hash-object', '-t', 'commit', '-w', '--stdin'], {
    input: newHeader + '\n\n' + message,
  }).trim();
}

function fail(msg) {
  process.stderr.write(`rebuild aborted: ${msg}\n`);
  process.exit(1);
}

// ---- preflight -------------------------------------------------------------
const oldChain = git(['rev-list', '--reverse', 'HEAD']).split('\n').filter(Boolean);
if (!oldChain.length) fail('no commits in the service repo');
const oldHead = oldChain[oldChain.length - 1];

// Every listed file must be tracked and must currently match the working tree
// at HEAD, otherwise the working tree is not the authority we think it is.
for (const path of REBASELINE) {
  const headBlob = git(['rev-parse', `HEAD:${path}`]);
  const workBlob = blobOfWorkingTree(path);
  if (headBlob !== workBlob) {
    fail(`${path} differs between HEAD (${headBlob.slice(0, 7)}) and the working tree (${workBlob.slice(0, 7)}); `
      + 'the working tree must hold the cleaned content');
  }
}

// Nothing outside the re-baselined files may differ between HEAD and the
// working tree, or the rebuild would silently change agent-visible content.
const dirty = git(['status', '--porcelain']).split('\n').filter(Boolean);
const unexpected = dirty.filter((l) => !REBASELINE.some((p) => l.slice(3).endsWith(p)));
if (unexpected.length) {
  fail(`the working tree has changes outside ${REBASELINE.join(', ')}:\n  ${unexpected.join('\n  ')}`);
}

// ---- rebuild ---------------------------------------------------------------
const newChain = [];
const dropped = [];
let parent = null;

for (const old of oldChain) {
  const newTree = treeWithRebaselinedBlobs(old);
  const newSha = commitWithTree(old, newTree, parent);

  // A commit whose tree equals its parent's tree carries no information.
  if (parent) {
    const parentTree = git(['rev-parse', `${parent}^{tree}`]);
    if (newTree === parentTree) {
      dropped.push({ old, new: newSha, subject: git(['log', '-1', '--format=%s', old]) });
      continue;
    }
  }
  newChain.push({ old, renamed: newSha });
  parent = newSha;
}

if (!newChain.length) fail('the rebuild produced an empty chain');

// ---- invariants ------------------------------------------------------------
// 1. The final tree must be byte-identical to the old final tree.
const finalTreeOld = git(['rev-parse', `${oldHead}^{tree}`]);
const finalTreeNew = git(['rev-parse', `${newChain[newChain.length - 1].renamed}^{tree}`]);
if (finalTreeOld !== finalTreeNew) fail('the rebuilt HEAD tree differs from the old HEAD tree');

// 2. Each rebuilt commit may differ from its old counterpart only in the
//    re-baselined files.
for (const { old, renamed } of newChain) {
  const changed = git(['diff', '--name-only', old, renamed]).split('\n').filter(Boolean);
  const outside = changed.filter((p) => !REBASELINE.includes(p));
  if (outside.length) {
    fail(`commit ${renamed} differs from ${old} outside the re-baselined files: ${outside.join(', ')}`);
  }
}

// 3. Every commit must introduce exactly the same change it introduced before,
//    except for the re-baselined files. Compare per file, not as patch text:
//    the re-baselined file legitimately drops out of the diff of the commits
//    that used to touch it.
for (const { old, renamed } of newChain) {
  const oldFiles = changedFiles(old);
  const newFiles = changedFiles(renamed);
  const extra = newFiles.filter((f) => !oldFiles.includes(f));
  if (extra.length) {
    fail(`commit ${renamed} touches files its counterpart ${old} did not: ${extra.join(', ')}`);
  }
  for (const f of oldFiles) {
    if (REBASELINE.includes(f)) continue;
    const blobOld = git(['rev-parse', `${old}:${f}`]);
    const blobNew = git(['rev-parse', `${renamed}:${f}`]);
    if (blobOld !== blobNew) {
      fail(`commit ${renamed} carries a different version of ${f} than ${old}`);
    }
  }
}

// ---- apply -----------------------------------------------------------------
if (DRY_RUN) {
  process.stdout.write('dry run, nothing written\n');
} else {
  mkdirSync(ARCHIVE_DIR, { recursive: true });
  writeFileSync(join(ARCHIVE_DIR, 'README.txt'),
    'service-repo-pre-rebuild.bundle holds the service repo history as it was before the\n'
    + '2026-10-30 rebuild. The audit file and the claim ledger cite those SHAs.\n'
    + 'Read it without touching the lab repo:\n'
    + '  git bundle verify service-repo-pre-rebuild.bundle\n'
    + '  git clone service-repo-pre-rebuild.bundle /tmp/old-service-repo\n');
  git(['bundle', 'create', ARCHIVE, '--all']);
  git(['bundle', 'verify', ARCHIVE]);

  git(['update-ref', 'refs/heads/main', newChain[newChain.length - 1].renamed]);
  git(['reset', '--mixed']);
  // The old objects must not stay reachable from inside the repo, otherwise
  // `git log --all` keeps seeing the leaky diffs.
  git(['reflog', 'expire', '--expire=now', '--all']);
  git(['gc', '--prune=now', '--quiet']);
}

process.stdout.write(`${DRY_RUN ? 'planned' : 'rebuilt'} service history\n`);
process.stdout.write(`  old chain: ${oldChain.map((c) => c.slice(0, 7)).join(' / ')}\n`);
process.stdout.write(`  new chain: ${newChain.map((c) => c.renamed.slice(0, 7)).join(' / ')}\n`);
for (const d of dropped) {
  process.stdout.write(`  dropped (became empty): ${d.old.slice(0, 7)} ${d.subject}\n`);
}
if (!DRY_RUN) process.stdout.write(`  old chain archived at: ${ARCHIVE}\n`);
