// 真实靶子的前置闸门。
//
// 合成夹具那套前置闸门（P1–P5）问的是**夹具**的问题：三个容器在跑吗、
// 挂载源在工作区吗、日志在长吗、5xx 比例是 0 吗、告警在 firing 吗。
// 换成真实靶子，这些问法有一个算一个不成立：
//
//   · 真实靶子是**宿主机上的进程**，不是容器——没有「挂载源」这回事；
//   · 真实靶子空闲时**日志不增长**（实测：打 actuator/health，日志一个字节
//     都不长）——「日志在长」是合成夹具的活性信号，不是通用的活性信号；
//   · 真实靶子的 Prometheus 一开始**一条告警规则都没有**——那时候
//     「没有告警在 firing」是空话，闸门看着是绿的，其实什么都没证明。
//
// 所以真实靶子要**另一套问法**，而且每一条都要能回答「它证明了什么」：
//
//   P1 证据通道在位      —— Prometheus / actuator / 日志目录 / 部署台账
//   P2 日志通道由靶子自己持有 —— 进程自己持有日志文件的写句柄
//   P3 靶子在自己的指标里现身 —— 活性信号用「指标存在」，不用「日志在长」
//   P4 基线 5xx 比例 = 0
//   P5 开跑前没有告警在 firing —— 并且**必须有规则**，否则这条闸门不算数
//
// 依赖全部走参数注入（deps），这样负对照能在不接真实靶子的情况下跑。
// 默认实现是真实读系统的那一套。

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { applicationLabel } from '../targets/descriptor.mjs';

/** 默认依赖：真的去问系统。 */
export const realDeps = {
  async fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
  async fetchStatus(url) {
    const res = await fetch(url);
    return res.status;
  },
  sh(cmd) {
    try {
      const out = execFileSync('bash', ['-c', cmd], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20000,
      });
      return { code: 0, out: (out || '').trim(), err: '' };
    } catch (err) {
      return {
        code: err.status ?? 1,
        out: (err.stdout || '').toString().trim(),
        err: (err.stderr || err.message || '').toString().trim(),
      };
    }
  },
  existsSync,
  readdirSync,
  readlinkSync,
  statSync,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

function listenPid(deps, port) {
  const r = deps.sh(`lsof -ti:${port} -sTCP:LISTEN`);
  if (r.code !== 0) return null;
  const pid = r.out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)[0];
  return pid ? Number(pid) : null;
}

/**
 * 靶子进程自己持有的日志文件。
 *
 * 为什么要看**文件描述符**而不是看目录里有没有 .log 文件：
 * 目录里有日志文件 ≠ 靶子在写它们。进程把自己的日志退回 stdout 时，
 * 目录里的文件会停在最后一次启动的时刻，一动不动——合成夹具那边踩过的坑
 * （「容器 healthy 但日志不增长」）在宿主机进程上长成一个样。
 * 持有写句柄才是「这条日志通道是活的」的证据。
 */
function heldLogFiles(deps, pid) {
  const dir = `/proc/${pid}/fd`;
  let entries;
  try {
    entries = deps.readdirSync(dir);
  } catch {
    return [];
  }
  const files = new Set();
  for (const entry of entries) {
    let target;
    try {
      target = deps.readlinkSync(join(dir, entry));
    } catch {
      continue;
    }
    if (typeof target !== 'string') continue;
    if (!target.endsWith('.log')) continue;
    if (target.includes('(deleted)')) continue;
    files.add(target);
  }
  return [...files].sort();
}

/**
 * 这个文件名是不是描述文件点名的那些日志文件之一。
 *
 * 描述文件的 logFiles 写的是「读哪几个」（例如只读 all*.log，避免同一行被
 * 数两遍）。要证明日志通道是活的，得证明**进程自己持有的是这几个文件**——
 * 不是「目录里恰好有几个 .log」。
 */
function matchesLogFiles(name, patterns) {
  const list = patterns.length ? patterns : ['*.log'];
  return list.some((p) => {
    if (!p.includes('*')) return p === name;
    const re = new RegExp(
      `^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`,
    );
    return re.test(name);
  });
}

function ratioQuery(profile) {
  const app = applicationLabel(profile);
  return (
    `sum(rate(http_server_requests_seconds_count{application="${app}",status=~"5.."}[1m]))` +
    `/clamp_min(sum(rate(http_server_requests_seconds_count{application="${app}"}[1m])), 0.001)`
  );
}

async function promValue(deps, prometheusUrl, query) {
  const body = await deps.fetchJson(
    `${prometheusUrl}/api/v1/query?query=${encodeURIComponent(query)}`,
  );
  if (body?.status !== 'success') {
    throw new Error(`Prometheus 返回 ${body?.status ?? '未知'}`);
  }
  const raw = body?.data?.result?.[0]?.value?.[1];
  return raw === undefined ? null : Number(raw);
}

/**
 * 跑真实靶子的前置闸门。
 *
 * 返回闸门记录（ok 布尔 + 人能读的 detail）。**不抛错**：由调用方决定
 * 哪一条不通过要中止——dry-run 与真跑的中止策略不一样。
 */
export async function realTargetPreflight(profile, deps = realDeps) {
  const gates = [];
  const facts = {
    target_id: profile.id,
    application: applicationLabel(profile),
    prometheus_url: profile.prometheusUrl,
    actuator_url: profile.actuatorBaseUrl,
  };

  // ── P1 证据通道在位 ────────────────────────────────────────────────
  const p1 = [];
  let promOk = false;
  try {
    const up = await promValue(deps, profile.prometheusUrl, 'up');
    promOk = true;
    p1.push(`Prometheus 可查（up 的返回值=${up === null ? '空' : up}）`);
  } catch (err) {
    p1.push(`Prometheus 不可查：${err.message}`);
  }

  let actuatorStatus = null;
  try {
    actuatorStatus = await deps.fetchStatus(
      `${profile.actuatorBaseUrl}/actuator/health`,
    );
    p1.push(
      `actuator 体检返回 ${actuatorStatus}${actuatorStatus === 200 ? '' : '（不是 200）'}`,
    );
  } catch (err) {
    p1.push(`actuator 体检不可达：${err.message}`);
  }

  let logsDirOk = false;
  try {
    logsDirOk = deps.statSync(profile.logsDir).isDirectory();
    p1.push(
      `描述文件里的日志目录 ${profile.logsDir} ${logsDirOk ? '存在' : '不是目录'}（它是不是靶子实际在写的那一处，由 P2 量）`,
    );
  } catch {
    p1.push(`描述文件里的日志目录 ${profile.logsDir} 不存在`);
  }

  let ledgerOk = false;
  if (profile.ledgerPath && deps.existsSync(profile.ledgerPath)) {
    ledgerOk = true;
    p1.push(`部署台账可读（${profile.ledgerPath}）`);
  } else {
    p1.push(
      `部署台账不可用（${profile.ledgerPath ?? '没配路径'}）——Agent 的 deploy 通道会直接死`,
    );
  }

  const p1ok = promOk && actuatorStatus === 200 && logsDirOk && ledgerOk;
  gates.push({
    id: 'P1',
    ok: p1ok,
    detail: `证据通道在位：${p1.join('；')}`,
  });
  facts.prometheus_reachable = promOk;
  facts.actuator_status = actuatorStatus;
  facts.logs_dir = profile.logsDir;
  facts.ledger_path = profile.ledgerPath;

  // ── P2 日志通道由靶子自己持有 ──────────────────────────────────────
  let port = null;
  try {
    port = new URL(profile.actuatorBaseUrl).port || null;
  } catch {
    port = null;
  }
  const pid = port ? listenPid(deps, port) : null;
  const held = pid ? heldLogFiles(deps, pid) : [];
  // 描述文件点名的那些日志文件，进程是不是真的持有。
  //
  // 「进程持有哪个目录下的 .log」不能只看「有 .log」：靶子可能同时持有
  // 启动器自己的 instance.log（在上一级目录）。要认的是**描述文件说的那几个**。
  const matching = held.filter((f) =>
    matchesLogFiles(basename(f), profile.logFiles),
  );
  const measuredDir = matching.length
    ? dirname(matching[0])
    : (() => {
        // 描述文件没点名任何文件时，退回「日志文件最多的那个目录」。
        const byDir = new Map();
        for (const f of held) {
          const d = dirname(f);
          byDir.set(d, (byDir.get(d) ?? 0) + 1);
        }
        const top = [...byDir.entries()].sort((a, b) => b[1] - a[1])[0];
        return top ? top[0] : null;
      })();
  // 描述文件说的目录 vs 进程实际在写的目录。两者不一致不是「小问题」：
  // Agent 按描述文件去读，读到的是一份**停在最后一次启动**的旧日志。
  // 这里把分歧**说出来**，并且让调用方按实测目录覆盖 LOG_DIR。
  const drift =
    measuredDir && measuredDir !== profile.logsDir
      ? `描述文件写的是 ${profile.logsDir}，靶子进程实际在写 ${measuredDir}——描述文件已过期，本轮按实测目录覆盖 LOG_DIR`
      : null;
  const p2ok = Boolean(pid && matching.length);
  gates.push({
    id: 'P2',
    ok: p2ok,
    detail: p2ok
      ? `靶子进程 pid=${pid} 自己持有 ${matching.length} 个日志文件的写句柄（${matching.map((f) => basename(f)).join(', ')}；目录 ${measuredDir}）` +
        (drift ? `；⚠ ${drift}` : '')
      : `靶子进程${pid ? ` pid=${pid}` : ''} 没有持有描述文件点名的那几个日志文件（点名的是 ${(profile.logFiles.length ? profile.logFiles : ['*.log']).join(', ')}；它持有的是 ${held.map((f) => basename(f)).join(', ') || '一个都没有'}）` +
        (pid ? '' : `（在端口 ${port ?? '?'} 上没找到监听进程）`) +
        '——日志通道不活，Agent 读到的日志不是这个靶子写的',
  });
  facts.pid = pid;
  facts.held_log_files = held;
  facts.matched_log_files = matching;
  facts.measured_logs_dir = measuredDir;
  facts.logs_dir_drift = drift;

  // ── P3 靶子在自己的指标里现身 ──────────────────────────────────────
  // 活性信号为什么不用「日志在长」：真实靶子空闲时日志不长（实测过），
  // 用它当活性信号会把「靶子没被访问」误判成「靶子死了」。指标还在，
  // 说明这一轮采到的就是活着的靶子。
  const seriesQuery = `sum(http_server_requests_seconds_count{application="${applicationLabel(profile)}"})`;
  let series = null;
  let seriesOk = false;
  try {
    series = await promValue(deps, profile.prometheusUrl, seriesQuery);
    seriesOk = series !== null && series > 0;
    gates.push({
      id: 'P3',
      ok: seriesOk,
      detail: seriesOk
        ? `靶子自己的指标在 Prometheus 里存在（${applicationLabel(profile)} 的请求计数 = ${series}）——活性信号用「指标在」，不用「日志在长」：真实靶子空闲时日志不长`
        : `靶子自己的指标在 Prometheus 里查不到（${seriesQuery} → ${series ?? '空'}）`,
    });
  } catch (err) {
    gates.push({
      id: 'P3',
      ok: false,
      detail: `查靶子指标失败：${err.message}`,
    });
  }
  facts.metric_series = series;

  // ── P4 基线 5xx 比例 = 0 ───────────────────────────────────────────
  let ratio = null;
  let ratioOk = false;
  try {
    ratio = await promValue(deps, profile.prometheusUrl, ratioQuery(profile));
    // 分子序列不存在时整个表达式无值——那是「这段时间没有 500」的佐证，
    // 不是「读不到」。空结果按 0 算（与合成夹具那边同一口径）。
    const value = ratio === null ? 0 : ratio;
    ratioOk = value === 0;
    gates.push({
      id: 'P4',
      ok: ratioOk,
      detail: ratioOk
        ? `基线 5xx 比例 = 0（${ratio === null ? '没有 5xx 序列，按 0 算' : '比例 0'}）`
        : `基线 5xx 比例 = ${ratio}，台子不干净`,
    });
  } catch (err) {
    gates.push({
      id: 'P4',
      ok: false,
      detail: `读 5xx 比例失败：${err.message}`,
    });
  }
  facts.baseline_ratio = ratio;

  // ── P5 开跑前没有告警在 firing ─────────────────────────────────────
  // 「必须有规则」是这条闸门的一半：没有规则时「没有告警在 firing」是空话。
  let rulesGroups = 0;
  try {
    const rules = await deps.fetchJson(`${profile.prometheusUrl}/api/v1/rules`);
    rulesGroups = rules?.data?.groups?.length ?? 0;
  } catch (err) {
    gates.push({
      id: 'P5',
      ok: false,
      detail: `读告警规则失败：${err.message}——这条闸门证明不了基线是干净的`,
    });
  }
  if (rulesGroups > 0) {
    let firing = [];
    try {
      const alerts = await deps.fetchJson(
        `${profile.prometheusUrl}/api/v1/alerts`,
      );
      firing = (alerts?.data?.alerts ?? []).filter(
        (a) => a.labels?.alertname === 'HighServerErrorRate',
      );
    } catch (err) {
      gates.push({
        id: 'P5',
        ok: false,
        detail: `读告警失败：${err.message}`,
      });
    }
    gates.push({
      id: 'P5',
      ok: firing.length === 0,
      detail:
        firing.length === 0
          ? `开跑前没有告警在 firing（该 Prometheus 加载了 ${rulesGroups} 组规则，「没告警」这句有规则撑着）`
          : `开跑前 HighServerErrorRate 已经在 firing`,
    });
  } else if (!gates.some((g) => g.id === 'P5')) {
    gates.push({
      id: 'P5',
      ok: false,
      detail:
        '这个 Prometheus **一条告警规则都没有**——「没有告警在 firing」是空话，这条闸门证明不了基线是干净的',
    });
  }

  return { gates, facts };
}
