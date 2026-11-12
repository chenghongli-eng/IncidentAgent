// 一轮之内的「证据面」必须只属于这一轮。
//
// 两条通道是**跨轮累积**的：跑完一轮之后，它写下的东西还留在下一轮的证据面里，
// 于是下一轮的 Agent 读到的不是「现在的现场」，而是「上一轮的答案 + 现在的现场」。
// 命中于是不能算独立样本——这个项目已经为这件事栽过一次（跨轮泄漏：源码快照
// 留着上一轮的注入提交）。
//
// 这里处理的两条通道：
//
//   1. 部署台账（JSONL，append-only）：
//      真实项目的发布史**是**这一轮该看见的证据（发布归因就靠它），
//      但**实验室自己**上一轮造出来的发布不是——那是夹具的产物，
//      真实项目历史上从来没有过它。留着它，Agent 就会看到「上一轮也是
//      发了新版本、然后就 503 了」，等于把答案的方向直接告诉它。
//      → 每轮开跑前把台账轮转成「真实发布史 + 本轮自己的记录」。
//
//   2. Prometheus 时序库：
//      指标是按时间累积的，上一轮的 503 突增还在序列里，
//      Agent 一次 range 查询就能把上一轮的曲线拉出来。
//      → 每轮开跑前重建 Prometheus 容器（TSDB 没有挂卷，重建即清零），
//      并**实测**清零了（查得到一条历史序列就说明没清干净）。
//
// 两处都只做「轮换」，不删历史：归档件留在仓库外，证据可追溯。

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * 台账轮转：把当前台账归档出去，再写入「基线种子」。
 *
 * 基线种子是一份**钉死的**文件（仓库外），内容是真实项目的发布史 +
 * 基线制品的身份记录。每轮都用同一份种子起头，于是：
 *   · 上一轮实验室自己造的发布记录不进这一轮；
 *   · 真实项目的发布史一直在（那本来就是这一轮该看见的证据）。
 *
 * 种子文件不存在 → 抛错。种子不存在时「这一轮没有台账」是一个**结论**，
 * 而不是一个可以顺手造出来的东西：没有种子就说明这一轮的环境没准备好。
 */
export function rotateLedger({ ledgerPath, seedPath, archiveDir, stamp }) {
  if (!existsSync(seedPath)) {
    throw new Error(
      `台账基线种子不存在：${seedPath}\n` +
        '  没有种子就没有「这一轮该看见的发布史」，先按 ledger-seed.mjs 生成一份。',
    );
  }
  mkdirSync(archiveDir, { recursive: true });
  let archived = null;
  if (existsSync(ledgerPath)) {
    const previous = readFileSync(ledgerPath, 'utf8');
    if (previous.trim()) {
      archived = join(archiveDir, `ledger-${stamp}.jsonl`);
      copyFileSync(ledgerPath, archived);
    }
  }
  const seed = readFileSync(seedPath, 'utf8');
  mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(ledgerPath, seed.endsWith('\n') ? seed : `${seed}\n`);
  const entries = seed
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean).length;
  return { archived, seeded_entries: entries, seed: seedPath };
}

/**
 * 台账里「这一轮之前就有的实验室自己的发布记录」有多少条。
 *
 * 轮转之后必须**实测**为 0，不能假设——seed 文件是人写的，
 * 它可能带进了上一轮的记录。实测项：台账里出现了「不是基线制品、
 * 也不是真实发布史」的实验室本地发布目录。
 */
export function countForeignLabEntries(
  ledgerPath,
  { baselineArtifactDir } = {},
) {
  if (!existsSync(ledgerPath)) return 0;
  const lines = readFileSync(ledgerPath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  let foreign = 0;
  for (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      foreign += 1;
      continue;
    }
    const ref = row.image_ref ?? '';
    if (!ref.startsWith('/')) continue; // 真实发布史是 registry 引用，不是本地路径
    if (baselineArtifactDir && ref === baselineArtifactDir) continue;
    foreign += 1;
  }
  return foreign;
}

/**
 * 重建 Prometheus 容器，让这一轮的指标面从零开始。
 *
 * 为什么是「重建」而不是「重启」：TSDB 是持久数据，重启不擦。
 *
 * 重建**还不等于**擦干净：prom/prometheus 镜像自己声明了 `VOLUME /prometheus`，
 * 于是 docker 给容器挂了一个**匿名卷**放时序库；而 compose 在重建容器时默认
 * **沿用**这个匿名卷——于是「容器换了，时序库还在」，上一轮的曲线照样查得到。
 * 所以这里带 `--renew-anon-volumes`：换一个新卷，时序库才真的从零开始。
 * （这是实测出来的，不是推断：docker inspect 显示 /prometheus 挂的是匿名卷。）
 *
 * 重建之后**实测清零**：查 Prometheus 里还有多少条序列。
 * 查到序列就说明没清干净（卷没换掉、或者抓取已经恢复），
 * 这时候必须判失败，不能继续跑——量具说「干净」而实际不干净，
 * 后面所有的命中率都是假的。
 */
export async function resetPrometheus({
  containerName = 'incident-prometheus-real',
  promUrl = 'http://127.0.0.1:9094',
  composeFile,
  envFile,
  service = 'prometheus-real',
  // 靶子的应用标签从**仓库外的描述文件**取（它是真实项目的东西，不进公开仓库）。
  appLabel = null,
  timeoutMs = 300000,
} = {}) {
  const inspect = (fmt) =>
    execFileSync('docker', ['inspect', containerName, '--format', fmt], {
      encoding: 'utf8',
    }).trim();

  const before = inspect('{{.Id}}');
  const beforeStarted = inspect('{{.State.StartedAt}}');
  const volumes = inspect(
    '{{range .Mounts}}{{if eq .Destination "/prometheus"}}{{.Type}} {{.Name}} {{.Source}}{{end}}{{end}}',
  );

  if (!composeFile || !envFile) {
    throw new Error(
      'resetPrometheus 需要 composeFile 与 envFile（compose 不能靠猜）。',
    );
  }
  if (!appLabel) {
    throw new Error(
      'resetPrometheus 需要 appLabel（靶子的指标标签）：它决定「量的是不是靶子自己的序列」。',
    );
  }
  // 换掉容器 + 换掉匿名卷：时序库随之清零。容器 id 与卷名由下面**实测**。
  execFileSync(
    'docker',
    [
      'compose',
      '--env-file',
      envFile,
      '-f',
      composeFile,
      'up',
      '-d',
      '--force-recreate',
      '--renew-anon-volumes',
      '--no-deps',
      service,
    ],
    { stdio: 'ignore' },
  );

  const deadline = Date.now() + timeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      // await 不能少：少了它 res 是 Promise，res.ok 恒为 undefined，
      // 就绪检查会永远不通过（这个 bug 真的发生过一次）。
      const res = await fetch(`${promUrl}/-/ready`);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      /* 还没起来，接着等 */
    }
    execFileSync('sleep', ['1']);
  }
  if (!ready) {
    // 说清「是没起来」还是「起来了但没就绪」：容器状态与日志尾巴一起带上，
    // 否则只留一句「没就绪」，下一轮又要从头猜。
    let state = '(容器不存在)';
    try {
      state = inspect('{{.State.Status}} {{.State.ExitCode}}');
    } catch {
      /* 容器没了也算一种状态 */
    }
    let tail = '';
    try {
      tail = execFileSync('docker', ['logs', '--tail', '5', containerName], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      /* 拉不到日志就留空 */
    }
    throw new Error(
      `重建后的 Prometheus 在 ${timeoutMs / 1000} 秒内没就绪：${promUrl}/-/ready\n` +
        `  容器状态：${state}\n  日志尾巴：\n${tail}`,
    );
  }

  const after = inspect('{{.Id}}');
  const afterStarted = inspect('{{.State.StartedAt}}');
  const volumesAfter = inspect(
    '{{range .Mounts}}{{if eq .Destination "/prometheus"}}{{.Type}} {{.Name}} {{.Source}}{{end}}{{end}}',
  );
  const series = await countAppSeries(promUrl, appLabel);
  if (series > 0) {
    throw new Error(
      `重建后的 Prometheus 里还有 ${series} 条序列——指标面没清干净，这一轮不能跑。\n` +
        `  容器 ${before.slice(0, 12)} → ${after.slice(0, 12)}；` +
        `时序库卷 ${volumes} → ${volumesAfter}`,
    );
  }
  return {
    container: containerName,
    container_before: before,
    container_after: after,
    recreated: before !== after,
    started_before: beforeStarted,
    started_after: afterStarted,
    volume_before: volumes,
    volume_after: volumesAfter,
    volume_renewed: volumes !== volumesAfter,
    series_after: series,
  };
}

/**
 * Prometheus 里现在有多少条序列（实测，不是推断）。
 *
 * 用 /api/v1/series 而不是 count(...)：count() 返回的是**样本数**，
 * 它自己的结果是一条标量（0 或 1），拿它当「序列条数」会把
 * 「有序列」读成「序列数 = 1」。这里要的是条数。
 */
export async function countSeries(promUrl) {
  const res = await fetch(
    `${promUrl}/api/v1/series?match[]=${encodeURIComponent('{__name__=~".+"}')}`,
  );
  if (!res.ok) {
    throw new Error(`查 Prometheus 序列数失败：${res.status}`);
  }
  const body = JSON.parse(await res.text());
  return Array.isArray(body?.data) ? body.data.length : 0;
}

/**
 * Prometheus 里**靶子自己的**序列有多少条。
 *
 * 为什么不用「全部序列数」：抓取本身就会产生序列——`up`、`scrape_duration_seconds`
 * 这些记的是「Prometheus 在抓」，跟靶子的历史无关。靶子没在跑的时候它们照样
 * 有几条，于是「全部序列数 = 0」这个判据永远不成立。而真正要问的是
 * 「靶子的指标历史还在不在」。
 *
 * 判据：带靶子应用标签（application="<靶子的标签>"）的序列条数。
 */
export async function countAppSeries(promUrl, appLabel) {
  const res = await fetch(
    `${promUrl}/api/v1/series?match[]=${encodeURIComponent(
      `{application="${appLabel}"}`,
    )}`,
  );
  if (!res.ok) {
    throw new Error(`查 Prometheus 靶子序列数失败：${res.status}`);
  }
  const body = JSON.parse(await res.text());
  return Array.isArray(body?.data) ? body.data.length : 0;
}
