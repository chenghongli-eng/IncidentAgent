#!/usr/bin/env node
/**
 * 样本独立性审计：每一轮开跑时，它的**每一个证据面**上有没有**早于本轮注入**的痕迹。
 *
 * 为什么要有这个审计：
 *
 *   通道审计（channel-audit）只管「Agent 有没有越界」——日志目录本来就是
 *   合法证据面，它按定义放行。可它管不了另一件事：**这一轮的证据面上，
 *   有没有前几轮留下的痕迹**。真实靶子的日志目录跨轮累积，前一轮注入时
 *   打的阈值就躺在日志里，后一轮的 Agent 读到了，命中是被提示过的命中。
 *
 *   那种命中不是「越界」，是**样本不独立**：命中率不能拿它当分母。
 *
 * 这个脚本量三张面（每一面都是「本轮 Agent 读得到、且装着答案的地方」）：
 *
 *   1. logs_channel —— Agent 的日志通道（`LOG_DIR` 指向的那个目录）。
 *      轮次之间靠「归档」清干净：每轮开跑前把上一轮的内容挪走。
 *      量法：通道面里有没有**时间戳早于本轮注入**的痕迹行。
 *
 *   2. logs_fault —— **运行中那个实例**的日志目录。分相规格（发布类故障）
 *      下它和通道面**不是同一个目录**：故障相跑在自己的 run 目录里，
 *      而通道面还指着基线相的旧实例。量法同上。
 *
 *   3. source_repo —— 工作区里的源码快照（git 仓库）。发布类故障的答案
 *      （阈值写进了哪份配置、哪个提交引入的）就写在这份快照里，
 *      而「每一轮回到基线提交重新注入」**并不会**把上一轮的注入提交
 *      从对象库里抹掉：它还躺在 .git 里，reflog 与台账都指着它的 sha，
 *      `git show <sha>` 照样读得到。量法：
 *
 *        外来的提交 = 提交时间早于本轮注入，且**不是**本轮 HEAD 的祖先；
 *        其中「带着答案的」= 增删行与本轮注入提交的签名一致（注释行不算）。
 *
 *        签名一致这个判据是**答案无关**的：它拿本轮自己的注入提交当尺子，
 *        脚本里不写任何关于故障机制的字眼。
 *
 * 另外两张面（2026-11-12 补）：
 *
 *   4. deploy_ledger —— 部署台账。append-only 的台账把实验室自己每一轮造出来
 *      的发布记录留在里面，下一轮的 Agent 读得到。现在每轮开跑前轮转成
 *      「真实发布史 + 本轮自己的记录」，并实测实验室自己的记录条数。
 *
 *   5. metrics_history —— Prometheus 的时序库。上一轮的 503 突增还在序列里，
 *      一次 range 查询就能拉出来。现在每轮开跑前重建 Prometheus（换掉匿名卷），
 *      并实测重建后的序列数。
 *
 * 五张面都量到、且都是 0 痕迹，这一轮才算独立。
 * **量不到的（目录没了、仓库没了）一律记 unknown，不许当成干净**——
 * 一个空面和一个干净面长得一模一样，正是本项目栽过的跟头。
 *
 * 用法：
 *   node incident/runs/independence-audit.mjs <rounds目录> [--json]
 *   node incident/runs/independence-audit.mjs <rounds目录> --source-repo <源码快照目录>
 *   node incident/runs/independence-audit.mjs <rounds目录> --surface-map <映射.json>
 *
 *   --surface-map：给**已经跑完**、当时没把证据面记进 manifest 的轮次补一份
 *   映射（{"<轮次戳>": "<日志面目录>"}）。这是补录，不是推断——映射里写什么，
 *   审计就量什么；写错的映射给出错的数（所以映射本身要有出处）。
 *
 *   --out <文件>：产物写到别处。默认写 <rounds目录>/independence-audit.json
 *   （指标表读它）；改判据前后要并排比对时，用它另存一份，不覆盖旧的。
 *
 * 产物：<rounds目录>/independence-audit.json（指标表会读它）。
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  TRACE_RE,
  LOG_TZ_OFFSET_MINUTES,
  countTraces,
  measureSourceSurface,
} from './independence-surfaces.mjs';

const args = process.argv.slice(2);
const DIR = resolve(args.find((a) => !a.startsWith('-')) ?? '.');
const AS_JSON = args.includes('--json');

function optValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('-')
    ? args[i + 1]
    : null;
}

const SOURCE_REPO = optValue('--source-repo');
const PRISTINE_REPO = optValue('--pristine-repo');
const SURFACE_MAP_PATH = optValue('--surface-map');
const OUT_PATH = optValue('--out');
const SURFACE_MAP = SURFACE_MAP_PATH
  ? JSON.parse(readFileSync(resolve(SURFACE_MAP_PATH), 'utf8'))
  : {};

if (!existsSync(DIR)) {
  process.stderr.write(`轮次目录不存在：${DIR}\n`);
  process.exit(1);
}

function parseUtc(value) {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

// ── 轮次与证据面 ─────────────────────────────────────────────────────────

const manifests = readdirSync(DIR)
  .filter((f) => /^round-manifest-.*\.json$/.test(f))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(DIR, f), 'utf8')))
  .sort((a, b) =>
    String(a.started_at ?? '').localeCompare(String(b.started_at ?? '')),
  );

/**
 * 日志通道面的快照：下一轮基线时归档出去的那一批。
 * 没有下一轮就用现在的日志目录。
 */
function channelSurfaceFor(index) {
  for (let i = index + 1; i < manifests.length; i += 1) {
    const dest = manifests[i]?.target?.baseline?.log_archive?.dest ?? null;
    if (dest && existsSync(dest))
      return {
        dir: dest,
        from: '下一轮基线归档',
        fromStamp: manifests[i].stamp,
      };
  }
  const logsDir = manifests[index]?.target?.facts?.measured_logs_dir ?? null;
  if (logsDir && existsSync(logsDir)) {
    return { dir: logsDir, from: '当前日志目录', fromStamp: null };
  }
  return null;
}

/**
 * 运行中那个实例的日志面（故障相）。
 *
 * 三种来源，优先级从高到低：
 *   · manifest 里记的 evidence_surface（分相规格：故障相跑在自己的目录里）；
 *   · --surface-map 补录（当时没记进 manifest 的轮次）；
 *   · `same-as-channel`（未分相的轮次：跑的就是通道面那个目录）。
 *
 * 「未分相」不是猜的：那一批的启动规格只有一个 run 目录，靶子的工作目录
 * 就是它，日志落在它下面，而通道面指向的正是那个目录。映射文件里写
 * `same-as-channel` 就是这句话的书面形式，出处随映射一起存。
 */
function faultSurfaceFor(m, channelSurface) {
  const recorded = m.injection?.evidence_surface?.dir ?? null;
  if (recorded) return { dir: recorded, from: 'manifest 记录的证据面' };
  const mapped = SURFACE_MAP[m.stamp] ?? null;
  if (mapped === 'same-as-channel') {
    if (!channelSurface) return null;
    return {
      dir: channelSurface.dir,
      from: '与通道面同目录（--surface-map 标注）',
    };
  }
  if (mapped) return { dir: resolve(mapped), from: '--surface-map 补录' };
  return null;
}

const rows = [];
const skipped = [];
for (let i = 0; i < manifests.length; i += 1) {
  const m = manifests[i];
  const injectedAt = parseUtc(m.injection?.at ?? null);
  // 没有注入时刻的轮次（dry-run、起跑就中止的）根本不是一轮样本。
  // 让它们进分母，等于把「没跑」当成「跑了而且干净」。
  if (injectedAt === null) {
    skipped.push({
      stamp: m.stamp ?? null,
      why: 'manifest 里没有注入时刻（这一轮没有真正注入故障）',
    });
    continue;
  }
  const surfaces = [];

  // 1. 日志通道面
  const channel = channelSurfaceFor(i);
  if (!channel) {
    surfaces.push({
      surface: 'logs_channel',
      status: 'not_measured',
      why: '找不到这一轮通道面的快照（既没有下一轮归档，也没有当前日志目录）',
      traces_total: null,
      traces_before_injection: null,
    });
  } else {
    const counted = countTraces(channel.dir, injectedAt);
    surfaces.push({
      surface: 'logs_channel',
      // 目录在、但一个 .log 都没有 = 空面，不是干净面。空面和干净面长得
      // 一模一样，正是本项目反复栽的那一跤——这里按「量不到」记。
      ...(counted.log_files === 0
        ? {
            status: 'not_measured',
            why: `${channel.dir} 里一个 .log 文件都没有——空面不是干净面`,
          }
        : { status: 'measured' }),
      dir: channel.dir,
      from: channel.from,
      from_stamp: channel.fromStamp,
      traces_total: counted.total,
      traces_before_injection: counted.stale,
      first_trace: counted.firstStamp,
      log_files: counted.log_files,
    });
  }

  // 2. 运行实例的日志面（故障相）
  const fault = faultSurfaceFor(m, channel);
  if (!fault) {
    surfaces.push({
      surface: 'logs_fault',
      status: 'not_measured',
      why: '找不到运行实例的日志目录（manifest 没记 evidence_surface，也没有 --surface-map 补录）',
      traces_total: null,
      traces_before_injection: null,
    });
  } else {
    const counted = countTraces(fault.dir, injectedAt);
    surfaces.push({
      surface: 'logs_fault',
      ...(counted.log_files === 0
        ? {
            status: 'not_measured',
            why: `${fault.dir} 里一个 .log 文件都没有——空面不是干净面`,
          }
        : { status: 'measured' }),
      dir: fault.dir,
      from: fault.from,
      traces_total: counted.total,
      traces_before_injection: counted.stale,
      first_trace: counted.firstStamp,
      log_files: counted.log_files,
    });
  }

  // 3. 源码面（git）
  //
  // 优先用 **manifest 里记的本轮实测**（开跑时量的那份）。
  //
  // 为什么不能一律事后重测：源码快照是**共用且会变的**——下一轮开跑时会把
  // 上一轮的注入提交清掉。事后量到的是「批次结束时那个仓库」，不是「Agent
  // 当时看到的那个仓库」，量的东西和要判的东西不是一回事。
  //
  // 事后重测只作为**补录**（老轮次没有记实测值时用），而且必须在产物里
  // 标明它是事后重测——读的人得知道这一行的证据是哪种。
  const recorded = m.injection?.source_surface ?? null;
  if (recorded && recorded.foreign_count !== undefined) {
    surfaces.push({
      surface: 'source_repo',
      status: 'measured',
      from: 'manifest 记录的本轮实测（开跑时量的）',
      measured_at: recorded.measured_at ?? null,
      head: recorded.head ?? null,
      foreign_count: recorded.foreign_count,
      answering_count: recorded.answering_count ?? null,
      foreign: (recorded.foreign_shas ?? []).map((sha) => ({ sha })),
      answering: [],
      note: '这一轮的源码面状态以开跑时的实测为准（开跑后源码快照会被下一轮清理）',
    });
  } else {
    const repo = m.injection?.source_repo ?? SOURCE_REPO ?? null;
    surfaces.push({
      surface: 'source_repo',
      ...measureSourceSurface(repo ? resolve(repo) : null, {
        head: m.injection?.release_commit ?? null,
        injectedAt,
        pristineRepo: PRISTINE_REPO ? resolve(PRISTINE_REPO) : null,
      }),
      from: '事后重测（这一轮没记开跑时的实测值）',
      note:
        '事后重测量的是「批次结束时那个仓库」的状态，不是开跑时的状态；' +
        '对共用快照的批次，只能当补录看。',
    });
  }

  // 4. 部署台账面
  //
  // 这一面是 2026-11-12 才被隔离的：台账是 append-only 的，实验室自己每一轮
  // 造出来的发布记录都留在里面，下一轮的 Agent 读得到（「上一轮也发了新版本、
  // 然后就 503 了」= 方向上的答案摆在证据面上）。
  //
  // 现在的台账在每轮开跑前被轮转成「真实发布史 + 本轮自己的记录」，
  // 并且**实测**「实验室自己造的发布记录」条数——真实发布史不算痕迹，
  // 它本来就是这一轮该看见的证据。
  //
  // 老轮次没有这个实测值（那时这两条通道还没被隔离）→ 记 unknown，
  // 不许当成干净：一个量不到的面和一个干净面长得一模一样。
  const ledgerIsolation = m.target?.isolation?.ledger ?? null;
  if (ledgerIsolation && ledgerIsolation.foreign_entries !== undefined) {
    surfaces.push({
      surface: 'deploy_ledger',
      status: 'measured',
      from: 'manifest 记录的本轮实测（开跑时量的）',
      measured_at: ledgerIsolation.measured_at ?? m.started_at ?? null,
      traces_total: ledgerIsolation.foreign_entries,
      traces_before_injection: ledgerIsolation.foreign_entries,
      note: '台账里实验室自己造的发布记录条数（真实发布史不算痕迹）',
    });
  } else {
    surfaces.push({
      surface: 'deploy_ledger',
      status: 'not_measured',
      why: '这一轮开跑时没有台账隔离的实测值（这条通道当时还没被隔离）',
      traces_total: null,
      traces_before_injection: null,
    });
  }

  // 5. 指标历史面
  //
  // Prometheus 的时序库跨轮累积：上一轮的 503 突增还在序列里，一次 range
  // 查询就能把上一轮的曲线拉出来。现在每轮开跑前重建 Prometheus（换掉
  // 匿名卷），并**实测**重建后的序列数。
  const promIsolation = m.target?.isolation?.prometheus ?? null;
  if (promIsolation && promIsolation.series_after !== undefined) {
    surfaces.push({
      surface: 'metrics_history',
      status: 'measured',
      from: 'manifest 记录的本轮实测（开跑时量的）',
      measured_at: promIsolation.measured_at ?? m.started_at ?? null,
      traces_total: promIsolation.series_after,
      traces_before_injection: promIsolation.series_after,
      container_recreated: promIsolation.recreated ?? null,
      volume_renewed: promIsolation.volume_renewed ?? null,
      note: '重建后的 Prometheus 里残留的序列数（0 = 指标面从零开始）',
    });
  } else {
    surfaces.push({
      surface: 'metrics_history',
      status: 'not_measured',
      why: '这一轮开跑时没有指标面隔离的实测值（这条通道当时还没被隔离）',
      traces_total: null,
      traces_before_injection: null,
    });
  }

  const measured = surfaces.filter((s) => s.status === 'measured');
  const notMeasured = surfaces.filter((s) => s.status === 'not_measured');
  const staleTraces = measured.reduce(
    (acc, s) =>
      acc +
      (s.surface === 'source_repo'
        ? (s.foreign_count ?? 0)
        : (s.traces_before_injection ?? 0)),
    0,
  );
  // 顺序：(1) 有一张面**量到**了脏东西 → 污染；(2) 都干净但有一张面量不到
  // → 未知；(3) 全量到且全干净 → 独立。
  //
  // 为什么污染优先于未知：污染是**已量到的阳性发现**，未知只是「这一面没量
  // 到」。把已知的脏藏进 unknown 等于把证据降级；但两者都不能记成独立。
  const verdict =
    staleTraces > 0
      ? 'contaminated'
      : notMeasured.length > 0
        ? 'unknown'
        : 'independent';

  rows.push({
    stamp: m.stamp,
    injected_at: m.injection?.at ?? null,
    surfaces,
    verdict,
    measured_surfaces: measured.length,
    unmeasured_surfaces: notMeasured.length,
  });
}

/**
 * 自检：最后一轮自己的痕迹必须全部晚于它的注入时刻。
 * 换算错了（时区差 8 小时搞反）会让这一条不成立——那就别给数。
 */
const last = rows[rows.length - 1];
if (last) {
  const chan = last.surfaces.find((s) => s.surface === 'logs_channel');
  const fault = last.surfaces.find((s) => s.surface === 'logs_fault');
  for (const s of [chan, fault]) {
    if (
      s &&
      s.status === 'measured' &&
      s.traces_total > 0 &&
      s.traces_before_injection > 0
    ) {
      process.stderr.write(
        `自检没过：最后一轮 ${last.stamp} 的 ${s.surface} 有 ${s.traces_before_injection}/${s.traces_total} ` +
          '条痕迹早于它的注入时刻。日志时间戳的时区换算多半错了，这个数不能用。\n',
      );
      process.exit(1);
    }
  }
}

const out = {
  $comment:
    '样本独立性审计：每一轮开跑时，它的每一个证据面（日志通道面、运行实例日志面、源码快照、' +
    '部署台账、指标历史）上有没有早于本轮注入的痕迹。指标表据此把被污染的轮次剔出分母。' +
    '量不到的面记 unknown，不当成干净。',
  generated_at: new Date().toISOString(),
  trace_pattern: TRACE_RE.source,
  log_tz_offset_minutes: LOG_TZ_OFFSET_MINUTES,
  source_repo_arg: SOURCE_REPO ? resolve(SOURCE_REPO) : null,
  pristine_repo_arg: PRISTINE_REPO ? resolve(PRISTINE_REPO) : null,
  surface_map: SURFACE_MAP_PATH ? resolve(SURFACE_MAP_PATH) : null,
  rounds: rows,
  independent: rows
    .filter((r) => r.verdict === 'independent')
    .map((r) => r.stamp),
  contaminated: rows
    .filter((r) => r.verdict === 'contaminated')
    .map((r) => r.stamp),
  unknown: rows.filter((r) => r.verdict === 'unknown').map((r) => r.stamp),
};
// 一轮都没量到（夹具轮次没有真实日志面）就不留空产物——
// 一个内容为空的审计文件会被误读成「审过了」。
if (rows.length > 0) {
  const outPath = OUT_PATH
    ? resolve(OUT_PATH)
    : join(DIR, 'independence-audit.json');
  out.product = outPath;
  writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
}

if (AS_JSON) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`独立性审计：扫的目录 ${DIR}\n`);
  console.log(
    '| 轮次 | 通道面痕迹 | 故障面痕迹 | 源码面外来提交（带答案的） | 量到的面 | 判定 |',
  );
  console.log('| --- | --- | --- | --- | --- | --- |');
  for (const r of rows) {
    const chan = r.surfaces.find((s) => s.surface === 'logs_channel');
    const fault = r.surfaces.find((s) => s.surface === 'logs_fault');
    const src = r.surfaces.find((s) => s.surface === 'source_repo');
    const cell = (s, kind) =>
      s.status !== 'measured'
        ? `（${s.status === 'not_applicable' ? '不适用' : '量不到'}）`
        : kind === 'src'
          ? `${s.foreign_count}（${s.answering_count}）`
          : `${s.traces_before_injection}/${s.traces_total}`;
    console.log(
      `| ${r.stamp} | ${cell(chan)} | ${cell(fault)} | ${cell(src, 'src')} | ` +
        `${r.measured_surfaces}/${r.surfaces.length} | ` +
        `${r.verdict === 'independent' ? '独立' : r.verdict === 'contaminated' ? '**污染**' : '**未知**'} |`,
    );
  }
  console.log(
    `\n独立 ${out.independent.length}｜污染 ${out.contaminated.length}｜未知 ${out.unknown.length}` +
      `（共 ${rows.length} 轮）\n产物 ${out.product ?? join(DIR, 'independence-audit.json')}`,
  );
}
