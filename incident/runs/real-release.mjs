#!/usr/bin/env node
/**
 * 为真实靶子构建一个**新发布**的部署单元。
 *
 * 为什么需要这个模块：真实靶子的第一轮故障走的是「运行时环境变量」——
 * 制品一行没动，进程带着一个环境变量重启，症状是健康检查 503。
 * 第二轮要换机制：故障随**新发布**进入制品（配置写进打包进去的
 * application.yaml），运行期进程环境是干净的。症状同形，触发源不同。
 *
 * 这个模块只做三件事：
 *   1. 在工作区的源码快照里落一次提交（这是「这次发布」在源码侧的样子）；
 *   2. 把当前制品复制成一个**新**的部署单元，并把它打包进去的
 *      application.yaml 改掉（这是「这次发布」在制品侧的样子）；
 *   3. 把源码侧的提交交出去，让轮次编排写台账（commit 的来源是构建记录）。
 *
 * 两件事必须同时成立，否则「这次发布带进来的配置」就不是真的：
 *   - 源码里那份配置与制品里那份配置是**同一处改动**（同一段 YAML、同一段值）；
 *   - 制品是从基线单元**复制**出来的，不是就地改的（基线单元必须保持原样，
 *     它是这一轮的「上一个版本」）。
 *
 * 不做的事：不删任何东西、不改写任何历史。基线制品目录只读；工作区源码
 * 用 `git checkout --detach` 回到基线提交（移动 HEAD 与工作树，不重写提交链）。
 * 每轮的新提交是悬空的（detached HEAD 上的提交），下一轮回到基线时它不再
 * 出现在 `git log` 里——上一轮不会漏进这一轮的证据面。
 */

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

/** 制品里那份配置在 jar 里的位置。 */
const DEFAULT_JAR_ENTRY = 'BOOT-INF/classes/application.yaml';

class ReleaseError extends Error {}

function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    }).trim();
  } catch (err) {
    const detail = (err.stderr || err.stdout || err.message).trim();
    throw new ReleaseError(`${cmd} ${args.join(' ')} 失败：${detail}`);
  }
}

function git(repo, args) {
  return run('git', ['-C', repo, ...args]);
}

/**
 * 把磁盘阈值插进 `management:` 块里。
 *
 * 幂等：已经有阈值了就原样返回。插入点是 `management:` 下一行的同缩进层，
 * 所以两份内容不同的 YAML 都能落到同一段结构上。
 */
export function injectDiskThreshold(yamlText, threshold) {
  if (/diskspace:/i.test(yamlText)) return yamlText;
  const lines = yamlText.split('\n');
  const idx = lines.findIndex((l) => /^management:\s*$/.test(l));
  if (idx === -1) {
    throw new ReleaseError('这份 YAML 里没有 management: 块，插不进去。');
  }
  const insert = [
    '  health:',
    '    diskspace:',
    `      threshold: ${threshold}`,
  ];
  lines.splice(idx + 1, 0, ...insert);
  return lines.join('\n');
}

/**
 * 在配置里追加一行构建标记。
 *
 * 用途只有一个：让每一轮打出来的制品**字节不同**，于是每一轮的部署单元
 * tree hash（台账的主键）不同。真实的 CI 重构产物本来也不字节可复现；
 * 若两轮 digest 相同，台账里就分不出「这是又一次发布」，样本就不独立了。
 */
export function stampBuild(yamlText, buildId) {
  return yamlText.replace(/^(management:\s*)$/m, `$1\n  # build ${buildId}`);
}

/** 复制目录：文件用真拷贝（会被改写），其余用硬链接（省空间、内容不变）。 */
function copyUnit(baseDir, unitDir) {
  mkdirSync(unitDir, { recursive: true });
  for (const name of readdirSync(baseDir)) {
    const from = join(baseDir, name);
    const to = join(unitDir, name);
    if (statSync(from).isDirectory()) {
      copyUnit(from, to);
      continue;
    }
    if (name.endsWith('.jar')) {
      copyFileSync(from, to);
      continue;
    }
    try {
      linkSync(from, to);
    } catch {
      copyFileSync(from, to);
    }
  }
}

/** jar 里的条目清单（构建前后比对：不能因为改一个条目而丢条目）。 */
function jarEntries(jarPath) {
  return run('jar', ['tf', jarPath]).split('\n').filter(Boolean).sort();
}

/**
 * 把 jar 里的那一份配置替换掉。
 *
 * 用 `jar uf`（update）：只换掉一个条目，不重打包整个归档。
 */
function patchJarEntry(jarPath, entry, newContent) {
  const before = jarEntries(jarPath);
  const tmp = mkdtempSync(join(tmpdir(), 'release-jar-'));
  try {
    const target = join(tmp, entry);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, newContent);
    run('jar', ['uf', jarPath, '-C', tmp, entry]);
    const after = jarEntries(jarPath);
    const lost = before.filter((e) => !after.includes(e));
    if (lost.length > 0) {
      throw new ReleaseError(
        `改完 jar 之后少了 ${lost.length} 个条目（${lost.slice(0, 5).join(', ')}）——` +
          '打包坏了，这一轮不能跑。',
      );
    }
    return { entries_before: before.length, entries_after: after.length };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * 构建一个新发布的部署单元。
 *
 * @param {object} opts
 * @param {string} opts.repo        工作区的源码快照（git 仓库）
 * @param {string} opts.baseUnitDir 基线部署单元（只读）
 * @param {string} opts.unitDir     新部署单元的目录（必须不存在）
 * @param {string} opts.baseCommit  基线提交（新提交建在它上面）
 * @param {string} opts.sourceFile  源码里那份配置的相对路径
 * @param {string} opts.jarEntry    制品里那份配置在 jar 里的位置
 * @param {string} opts.threshold   阈值
 * @param {string} opts.buildId     构建标记（每轮不同 → digest 不同）
 * @param {string} opts.message     提交说明
 */
export function buildRelease(opts) {
  const {
    repo,
    baseUnitDir,
    unitDir,
    baseCommit,
    sourceFile,
    jarEntry = DEFAULT_JAR_ENTRY,
    threshold,
    buildId,
    message,
  } = opts;

  if (existsSync(unitDir)) {
    throw new ReleaseError(
      `新部署单元的目录已经存在：${unitDir}。每一轮的单元目录必须是新的——` +
        '目录复用会让这一轮的 digest 跟上一轮一样，样本就不独立了。',
    );
  }
  if (!existsSync(join(baseUnitDir, 'app.jar'))) {
    throw new ReleaseError(`基线部署单元里没有 app.jar：${baseUnitDir}`);
  }

  // 1. 源码侧：回到基线提交 → 落改动 → 提交。
  git(repo, ['checkout', '--detach', baseCommit]);
  const srcPath = join(repo, sourceFile);
  if (!existsSync(srcPath)) {
    throw new ReleaseError(`源码里没有 ${sourceFile}：${srcPath}`);
  }
  const original = readFileSync(srcPath, 'utf8');
  const patchedSource = stampBuild(
    injectDiskThreshold(original, threshold),
    buildId,
  );
  writeFileSync(srcPath, patchedSource);
  git(repo, ['add', sourceFile]);
  git(repo, ['commit', '-m', message]);
  const commit = git(repo, ['rev-parse', 'HEAD']);
  const commitShort = git(repo, ['log', '-1', '--format=%h %aI %s']);

  // 2. 制品侧：复制基线单元 → 改打包进去的那份配置。
  copyUnit(baseUnitDir, unitDir);
  const jarPath = join(unitDir, 'app.jar');
  const jar = jarEntries(jarPath);
  const entry = jar.find((e) => e === jarEntry);
  if (!entry) {
    throw new ReleaseError(`制品里没有 ${jarEntry}，改不了。`);
  }
  const tmp = mkdtempSync(join(tmpdir(), 'release-entry-'));
  let jarYaml;
  try {
    run('jar', ['xf', jarPath, entry], { cwd: tmp });
    jarYaml = readFileSync(join(tmp, entry), 'utf8');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const patchedJar = stampBuild(
    injectDiskThreshold(jarYaml, threshold),
    buildId,
  );
  const entryStats = patchJarEntry(jarPath, jarEntry, patchedJar);

  return {
    unitDir: resolve(unitDir),
    commit,
    commit_short: commitShort,
    source_file: sourceFile,
    jar_entry: jarEntry,
    threshold,
    build_id: buildId,
    jar_bytes: statSync(jarPath).size,
    ...entryStats,
  };
}

/**
 * 把工作区源码快照收回基线。
 *
 * 用 `git checkout --detach`：HEAD 与工作树回到基线提交，提交链不动。
 * 每轮的新提交因此不再出现在 `git log` 里——上一轮的发布不会漏进这一轮。
 */
export function revertRelease({ repo, baseCommit }) {
  git(repo, ['checkout', '--detach', baseCommit]);
  const head = git(repo, ['rev-parse', 'HEAD']);
  if (head !== baseCommit) {
    throw new ReleaseError(`回到基线失败：HEAD 还在 ${head}`);
  }
  const dirty = git(repo, ['status', '--porcelain']);
  if (dirty.length > 0) {
    throw new ReleaseError(
      `回到基线之后工作树还是脏的：\n${dirty}\n` +
        '下一轮会在脏工作树上建发布，证据面就不干净了。',
    );
  }
  return { head, clean: true };
}

// ---------------------------------------------------------------------------
// CLI
//
//   node incident/runs/real-release.mjs build   --repo … --base-unit … --unit …
//                                            --base-commit … --source-file …
//                                            --threshold … --build-id …
//   node incident/runs/real-release.mjs revert --repo … --base-commit …
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    opts[key] = argv[i + 1];
  }
  return opts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  try {
    if (cmd === 'build') {
      const out = buildRelease({
        repo: opts.repo,
        baseUnitDir: opts['base-unit'],
        unitDir: opts.unit,
        baseCommit: opts['base-commit'],
        sourceFile: opts['source-file'],
        jarEntry: opts['jar-entry'] ?? DEFAULT_JAR_ENTRY,
        threshold: opts.threshold,
        buildId: opts['build-id'],
        message: opts.message ?? 'chore(config): 调整健康检查的磁盘空间阈值',
      });
      console.log(JSON.stringify(out, null, 2));
    } else if (cmd === 'revert') {
      console.log(
        JSON.stringify(
          revertRelease({ repo: opts.repo, baseCommit: opts['base-commit'] }),
          null,
          2,
        ),
      );
    } else {
      console.error('用法：build | revert');
      process.exitCode = 2;
    }
  } catch (err) {
    console.error(String(err.message ?? err));
    process.exitCode = 1;
  }
}
