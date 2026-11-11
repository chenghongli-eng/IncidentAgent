#!/usr/bin/env node
/**
 * 样本独立性审计：每一轮开跑时，证据面上有没有**早于本轮注入**的痕迹。
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
 * 怎么量：
 *
 *   一轮的日志面 = 「本轮基线归档之后新写的内容」。要判断它干不干净，
 *   就看这个内容里有没有**时间戳早于本轮注入时刻**的痕迹行。
 *
 *   内容从哪来：本轮基线时归档出去的那一批日志（target.baseline.log_archive.dest）
 *   记的是**上一轮**留下的东西；本轮开跑时的日志面，要到**下一轮**基线
 *   归档时才被完整收走。所以：
 *
 *     · 有下一轮 → 下一轮的归档目录就是本轮日志面的快照；
 *     · 没有下一轮（最后轮）→ 用现在的日志目录。
 *
 *   痕迹行怎么认：`DiskSpaceHealthIndicator - Free disk space below threshold`
 *   （这一轮故障机制的日志指纹；换个故障机制要换指纹，见 TRACE_RE）。
 *
 *   日志里的时间戳是**本地时区**（靶子的 TZ=Asia/Shanghai），manifest 里的
 *   注入时刻是 UTC。差 8 小时，换算错了会让「本轮自己的痕迹」被当成
 *   「前轮痕迹」——所以脚本最后会自检：最后一轮自己的痕迹必须全部晚于
 *   它的注入时刻，否则报错退出，不给出一个看着像样其实错的数。
 *
 * 用法：
 *   node incident/runs/independence-audit.mjs <rounds目录>
 *   node incident/runs/independence-audit.mjs <rounds目录> --json
 *
 * 产物：<rounds目录>/independence-audit.json（指标表会读它）。
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

/**
 * 故障痕迹行：<时间戳> … DiskSpaceHealthIndicator … Free disk space below threshold …
 *
 * 同一个应用有两种日志格式，日志行长得不一样：
 *   · 文件日志：`… 10:09:26.480 [http-nio-…-exec-1] WARN  o.s.boot…DiskSpaceHealthIndicator - Free disk space below threshold. …`
 *   · 控制台日志（launch.log）：`… 10:09:26.480  WARN 112768 --- [.1-12306-exec-1] o.s.b.a.system.DiskSpaceHealthIndicator  : Free disk space below threshold. …`
 * 所以这里只锚「行首时间戳」和「两个关键词」，中间的格式差异不管。
 */
const TRACE_RE =
  /^(?<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+).*DiskSpaceHealthIndicator.*Free disk space below threshold/;

/** 靶子日志用的时区偏移（靶子的启动脚本里导出 TZ=Asia/Shanghai）。 */
const LOG_TZ_OFFSET_MINUTES = 8 * 60;

const args = process.argv.slice(2);
const DIR = resolve(args.find((a) => !a.startsWith('-')) ?? '.');
const AS_JSON = args.includes('--json');

if (!existsSync(DIR)) {
  process.stderr.write(`轮次目录不存在：${DIR}\n`);
  process.exit(1);
}

function parseUtc(value) {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/** 日志里的本地时间戳 → UTC 毫秒 */
function localStampToUtc(line) {
  const m = TRACE_RE.exec(line);
  if (!m) return null;
  const naive = Date.parse(m.groups.ts.replace(' ', 'T') + 'Z');
  if (Number.isNaN(naive)) return null;
  return naive - LOG_TZ_OFFSET_MINUTES * 60_000;
}

/** 递归列出目录下所有 .log 文件（归档目录是嵌套的：<stamp>/logs/*.log）。 */
function listLogFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listLogFiles(p));
    else if (entry.name.endsWith('.log')) out.push(p);
  }
  return out;
}

/**
 * 数痕迹行。按时间戳去重：控制台日志和应用文件日志是同一批行的两种格式，
 * 同一行会被算两遍——那是重复计数，不是两条证据。
 */
function countTraces(dir, beforeUtc) {
  const stamps = new Set();
  if (!existsSync(dir)) return { total: 0, stale: 0, firstStamp: null, dir };
  for (const file of listLogFiles(dir)) {
    const text = readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      const ts = localStampToUtc(line);
      if (ts === null) continue;
      stamps.add(ts);
    }
  }
  const sorted = [...stamps].sort((a, b) => a - b);
  const stale =
    beforeUtc === null ? 0 : sorted.filter((t) => t < beforeUtc).length;
  return {
    total: sorted.length,
    stale,
    firstStamp: sorted.length ? new Date(sorted[0]).toISOString() : null,
    dir,
  };
}

const manifests = readdirSync(DIR)
  .filter((f) => /^round-manifest-.*\.json$/.test(f))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(DIR, f), 'utf8')))
  .sort((a, b) =>
    String(a.started_at ?? '').localeCompare(String(b.started_at ?? '')),
  );

/**
 * 每一轮的「日志面快照」：下一轮基线时归档出去的那一批。
 * 没有下一轮就用现在的日志目录。
 */
function surfaceDirFor(index) {
  for (let i = index + 1; i < manifests.length; i += 1) {
    const dest = manifests[i]?.target?.baseline?.log_archive?.dest ?? null;
    if (dest && existsSync(dest))
      return { dir: dest, from: manifests[i].stamp };
  }
  const logsDir = manifests[index]?.target?.facts?.logs_dir ?? null;
  if (logsDir && existsSync(logsDir)) {
    return { dir: logsDir, from: '(当前日志目录)' };
  }
  return null;
}

const rows = [];
for (let i = 0; i < manifests.length; i += 1) {
  const m = manifests[i];
  const injectedAt = parseUtc(m.injection?.at ?? null);
  const surface = surfaceDirFor(i);
  if (!injectedAt || !surface) continue;
  const counted = countTraces(surface.dir, injectedAt);
  rows.push({
    stamp: m.stamp,
    injected_at: m.injection.at,
    surface_dir: surface.dir,
    surface_from: surface.from,
    traces_total: counted.total,
    traces_before_injection: counted.stale,
    independent: counted.stale === 0,
    measured: true,
  });
}

/**
 * 自检：最后一轮自己的痕迹必须全部晚于它的注入时刻。
 * 换算错了（时区差 8 小时搞反）会让这一条不成立——那就别给数。
 */
const last = rows[rows.length - 1];
if (last && last.traces_total > 0 && last.traces_before_injection > 0) {
  process.stderr.write(
    `自检没过：最后一轮 ${last.stamp} 有 ${last.traces_before_injection}/${last.traces_total} ` +
      '条痕迹早于它的注入时刻。日志时间戳的时区换算多半错了，这个数不能用。\n',
  );
  process.exit(1);
}

const out = {
  $comment:
    '样本独立性审计：每一轮开跑时，证据面上有没有早于本轮注入的痕迹。' +
    '指标表据此把被污染的轮次剔出分母。',
  generated_at: new Date().toISOString(),
  trace_pattern: TRACE_RE.source,
  log_tz_offset_minutes: LOG_TZ_OFFSET_MINUTES,
  rounds: rows,
  contaminated: rows.filter((r) => !r.independent).map((r) => r.stamp),
};
// 一轮都没量到（夹具轮次没有真实日志面）就不留空产物——
// 一个内容为空的审计文件会被误读成「审过了」。
if (rows.length > 0) {
  writeFileSync(
    join(DIR, 'independence-audit.json'),
    JSON.stringify(out, null, 2) + '\n',
  );
}

if (AS_JSON) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`独立性审计：扫的目录 ${DIR}\n`);
  console.log('| 轮次 | 注入时刻 | 日志面痕迹 | 早于本轮注入 | 独立 |');
  console.log('| --- | --- | --- | --- | --- |');
  for (const r of rows) {
    console.log(
      `| ${r.stamp} | ${r.injected_at} | ${r.traces_total} | ${r.traces_before_injection} | ${r.independent ? '是' : '**否**'} |`,
    );
  }
  console.log(
    `\n独立轮 ${rows.filter((r) => r.independent).length}/${rows.length}；` +
      `产物 ${join(DIR, 'independence-audit.json')}`,
  );
}
