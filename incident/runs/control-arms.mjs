#!/usr/bin/env node
/**
 * F4 的**受控对照实验**：三个臂，一次只动一个变量。
 *
 * 为什么要有这个（复核件 audit-2026-11-04T0324Z.md §6）：
 * F4 的结论是「代码缺陷是必要条件、运行时旋钮是触发源」——这是一个**两条件叠加**
 * 的断言。11-04 那轮用的是「自然对照」（翻历史容器窗口找不同时间段比），
 * 变量没被控制住（容器不同、时刻不同、负载不同），所以：
 *   · 只能证明「缺陷 + 2s 超时 = 没有 500」「有兜底 + 1ms 超时 = 没有 500」
 *     这两条**必要性**方向；
 *   · 证不了**充分性**方向（两个条件都在时一定出 500），
 *     也证不了「单独任何一个条件都出不了 500」。
 * 缺了后两条，「叠加」这个词就没有实验支撑。
 *
 * 三个臂（其余条件全部固定：同一镜像基底、同一份种子数据、同一组压测路径、
 * 同一段观测窗口）：
 *
 *   A 缺陷在线 + 旋钮 2000ms   → 期望：0 个 500      （必要条件单独不够）
 *   B 缺陷撤掉 + 旋钮 1ms      → 期望：0 个 500      （触发源单独不够）
 *   C 缺陷在线 + 旋钮 1ms      → 期望：大量 500      （两者叠加才炸）
 *
 * 压测路径固定为 `/api/orders/1,3,4,5`（**不含 order 2**）：
 * order 2 的用户 9999 没有 profile 行，走的是「404 → 返回 null」这条路，
 * 跟超时不是一回事。带上 order 2 的话，缺陷在线时即使旋钮是 2000ms 也会出 500
 * （NPE），A 臂就不再是「静默态」，两臂的对照也就没有意义了。
 *
 * 观测口径与 Agent 用的是同一套只读通道（tools/incident-readonly.mjs）：
 * 日志计数用 `logs grep --count`，5xx 比例用 Prometheus 的 range 查询。
 *
 * 用法：
 *   node incident/runs/control-arms.mjs --warmup 60 --window 300
 *   node incident/runs/control-arms.mjs --arms A,C        # 只跑其中两个臂
 *   node incident/runs/control-arms.mjs --ratios-only incident/runs/control-arms-<stamp>.json
 *                                                            # 只重算 Prometheus 比例
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const LAB_PATHS = JSON.parse(
  readFileSync(new URL('../lab-paths.json', import.meta.url), 'utf8'),
);
const SERVICE_DIR = LAB_PATHS.serviceDir;
const CLI = LAB_PATHS.readonlyCli;
const COMPOSE_FILE = new URL('../docker-compose.yml', import.meta.url).pathname;
const LAB_ENV =
  process.env.LAB_ENV ?? `${process.env.HOME}/.config/miniclaw-lab/lab.env`;
// 结果落在**仓库里**（与其它证据件同目录）：这是实验室侧的自证材料，
// 应当和审计件一样进版本库，而不是散在仓库外。
const EVIDENCE_DIR = new URL('.', import.meta.url).pathname;

// 压测路径：不含 order 2（用户 9999 无 profile → 404 → null，与超时无关）。
const LOAD_PATHS = '/api/orders/1,/api/orders/3,/api/orders/4,/api/orders/5';

const ARMS = [
  {
    id: 'A',
    label: '缺陷在线 + 旋钮 2000ms',
    code: 'defect',
    timeout: '2000',
    expect: '0 个 500',
    why: '必要条件单独不成立：缺陷在，但没有把下游读超时压到 1ms',
  },
  {
    id: 'B',
    label: '缺陷撤掉 + 旋钮 1ms',
    code: 'baseline',
    timeout: '1',
    expect: '0 个 500',
    why: '触发源单独不成立：超时压到 1ms，但判空兜底还在 → 超时被降级成 UNKNOWN',
  },
  {
    id: 'C',
    label: '缺陷在线 + 旋钮 1ms',
    code: 'defect',
    timeout: '1',
    expect: '大量 500',
    why: '两者叠加：超时 → fetchProfile 返回 null → 未判空解引用 → NPE → 500',
  },
];

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const WARMUP = Number(arg('warmup', '60'));
const WINDOW = Number(arg('window', '300'));
const ONLY = arg('arms', '')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
/** 只重算 Prometheus 比例模式：读一个已有的 control-arms-*.json，重算比例后另存。 */
const RATIOS_ONLY = arg('ratios-only', '');

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 64 << 20,
    ...opts,
  }).trim();
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 只读通道的日志计数：与 Agent 看到的是同一套口径。 */
function countLogs(pattern, sinceIso, untilIso) {
  const out = sh('node', [
    CLI,
    'logs',
    'grep',
    pattern,
    '--since',
    sinceIso,
    '--until',
    untilIso,
    '--count',
  ]);
  return Number(out) || 0;
}

/**
 * Prometheus 的 5xx 比例（range 查询，取窗口内的最大值）。
 *
 * 返回形状是**两种都要认**的：
 *   只读 CLI 的 `metrics range` 打印的是 Prometheus API 响应的 `data` 字段，
 *   也就是 `{resultType, result:[...]}`；
 *   有些封装会再包一层 `{data:{result:[...]}}`。
 * 认不出来就**抛错**，不许静默当成 0——第一版就是在这里把 C 臂的 43.6%
 * 读成 0，表格上还写着「5xx 峰值=0」，看上去像台子没炸。
 */
export function parseMatrix(out) {
  const parsed = JSON.parse(out);
  const result = parsed?.result ?? parsed?.data?.result;
  if (!Array.isArray(result)) {
    throw new Error(
      `metrics range 返回的形状不认识：顶层键 = ${Object.keys(parsed).join(',')}`,
    );
  }
  const values = result[0]?.values ?? [];
  let max = 0;
  for (const [, v] of values) max = Math.max(max, Number(v));
  return { max, points: values.length };
}

function maxFivexxRatio(startIso, endIso) {
  const expr =
    'sum(rate(http_server_requests_seconds_count{application="target-service",status=~"5.."}[1m]))' +
    '/ clamp_min(sum(rate(http_server_requests_seconds_count{application="target-service"}[1m])), 0.001)';
  const out = sh('node', [
    CLI,
    'metrics',
    'range',
    expr,
    startIso,
    endIso,
    '30s',
  ]);
  return parseMatrix(out);
}

function containerStartedAt() {
  const raw = sh('docker', [
    'inspect',
    'target-service',
    '--format',
    '{{.State.StartedAt}}',
  ]);
  return Date.parse(raw);
}

function waitHealthy(timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let status = '';
    try {
      status = sh('docker', [
        'inspect',
        'target-service',
        '--format',
        '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}',
      ]);
    } catch {
      status = 'missing';
    }
    if (status === 'healthy') return true;
    sleep(3000);
  }
  return false;
}

/** 把源码切到缺陷态或基线态（走 faults.mjs，两边都提交，状态可查）。 */
function setCodeState(state) {
  const status = sh('node', [
    new URL('../faults/faults.mjs', import.meta.url).pathname,
    'status',
    'F2',
  ]);
  const current = status.split(' ')[1];
  const want = state === 'defect' ? 'injected' : 'baseline';
  if (current === want) return { changed: false, state: current };
  const cmd = state === 'defect' ? 'inject' : 'restore';
  const out = sh('node', [
    new URL('../faults/faults.mjs', import.meta.url).pathname,
    cmd,
    'F2',
  ]);
  return { changed: true, state: want, out };
}

/**
 * 重建容器。
 *
 * 旋钮用**环境变量覆盖**而不是改旋钮文件：这次是实验室侧的对照实验，
 * 不需要留「旋钮文件 mtime」这条给 Agent 看的证据链；真跑轮次时旋钮文件
 * 必须与容器一致，那一步要走 lab.sh（--env-file）。
 */
function recreateContainer(timeout) {
  const env = {
    ...process.env,
    DOWNSTREAM_TIMEOUT_MS: timeout,
    LOAD_PATHS,
    LOAD_ENABLED: 'true',
  };
  sh(
    'docker',
    [
      'compose',
      '--env-file',
      LAB_ENV,
      '-f',
      COMPOSE_FILE,
      'up',
      '-d',
      '--build',
      '--force-recreate',
      '--no-deps',
      'target-service',
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return waitHealthy();
}

function iso(ms) {
  return new Date(ms).toISOString();
}

/**
 * 只重算 Prometheus 比例模式（`--ratios-only <control-arms-*.json>`）。
 *
 * 什么时候需要：比例是在观测窗口**当场**算的，日志计数也是。但量具本身
 * 可能坏——第一版就把返回形状认错了，把 C 臂的 43.6% 读成 0，而表格看上去
 * 「各项都是 0」，很像台子没炸。比例是可以事后重算的：Prometheus 里那段
 * 时间窗的数据还在，重算得到的就是当时那个数（不是重新测一遍）。
 * 所以这个模式把「量具坏了」和「台子不对」区分开：只改比例，其余数字原样保留。
 */
if (RATIOS_ONLY) {
  const src = JSON.parse(readFileSync(RATIOS_ONLY, 'utf8'));
  const arms = src.arms.map((a) => {
    if (a.error) return a;
    const ratio = maxFivexxRatio(a.window.from, a.window.to);
    return {
      ...a,
      prometheus_5xx_ratio_max: ratio.max,
      prometheus_points: ratio.points,
    };
  });
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, 'Z');
  const outFile = join(EVIDENCE_DIR, `control-arms-${stamp}-corrected.json`);
  writeFileSync(
    outFile,
    JSON.stringify(
      {
        ...src,
        generated_at: new Date().toISOString(),
        correction_of: RATIOS_ONLY,
        correction_reason:
          '第一版把 metrics range 的返回形状认成 {data:{result}}，比例被静默读成 0；' +
          '日志侧计数未受影响。本次只重算 Prometheus 比例。',
        arms,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    '\n| 臂 | 配置 | 500 | NPE | 超时 | 成功加载 | 5xx 峰值 | 期望 |',
  );
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of arms) {
    if (r.error) {
      console.log(`| ${r.arm} | ${r.error} | | | | | | |`);
      continue;
    }
    console.log(
      `| ${r.arm} | ${r.label} | ${r.counts.fivexx_log} | ${r.counts.null_pointer} | ` +
        `${r.counts.read_timed_out} | ${r.counts.loaded_ok} | ${r.prometheus_5xx_ratio_max} | ${r.expect} |`,
    );
  }
  console.log(`\n结果写入：${outFile}`);
  process.exit(0);
}

async function main() {
  const results = [];
  for (const arm of ARMS) {
    if (ONLY.length && !ONLY.includes(arm.id)) continue;
    console.log(`\n=== 臂 ${arm.id}：${arm.label}（期望 ${arm.expect}）`);
    const code = setCodeState(arm.code);
    console.log(
      `  代码状态：${code.state}${code.changed ? '（已提交）' : '（未变）'}`,
    );
    const healthy = recreateContainer(arm.timeout);
    if (!healthy) {
      console.error(`  臂 ${arm.id} 失败：容器没起来`);
      results.push({ arm: arm.id, error: 'container not healthy' });
      continue;
    }
    const started = containerStartedAt();
    console.log(`  容器启动：${iso(started)}`);

    const measureFrom = started + WARMUP * 1000;
    const measureTo = measureFrom + WINDOW * 1000;
    console.log(
      `  观测窗口：${iso(measureFrom)} → ${iso(measureTo)}（预热 ${WARMUP}s + 观测 ${WINDOW}s）`,
    );
    // 等到窗口结束。
    sleep(Math.max(0, measureTo - Date.now()));

    const fivexx = countLogs(
      'threw exception',
      iso(measureFrom),
      iso(measureTo),
    );
    const timeouts = countLogs(
      'Read timed out',
      iso(measureFrom),
      iso(measureTo),
    );
    const npe = countLogs(
      'NullPointerException',
      iso(measureFrom),
      iso(measureTo),
    );
    const loaded = countLogs(
      'loaded for user',
      iso(measureFrom),
      iso(measureTo),
    );
    const ratio = maxFivexxRatio(iso(measureFrom), iso(measureTo));

    const record = {
      arm: arm.id,
      label: arm.label,
      expect: arm.expect,
      why: arm.why,
      code_state: arm.code,
      timeout_ms: arm.timeout,
      load_paths: LOAD_PATHS,
      container_started_at: iso(started),
      window: { from: iso(measureFrom), to: iso(measureTo) },
      counts: {
        fivexx_log: fivexx,
        null_pointer: npe,
        read_timed_out: timeouts,
        loaded_ok: loaded,
      },
      prometheus_5xx_ratio_max: ratio.max,
      prometheus_points: ratio.points,
    };
    results.push(record);
    console.log(
      `  计数：500=${fivexx} NPE=${npe} 超时=${timeouts} 成功加载=${loaded} ` +
        `Prometheus 5xx 峰值=${ratio.max}`,
    );
  }

  // ---- 落盘 ------------------------------------------------------------------
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, 'Z');
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const outFile = join(EVIDENCE_DIR, `control-arms-${stamp}.json`);
  writeFileSync(
    outFile,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        warmup_s: WARMUP,
        window_s: WINDOW,
        load_paths: LOAD_PATHS,
        arms: results,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`\n结果写入：${outFile}`);

  console.log(
    '\n| 臂 | 配置 | 500 | NPE | 超时 | 成功加载 | 5xx 峰值 | 期望 |',
  );
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of results) {
    if (r.error) {
      console.log(`| ${r.arm} | ${r.error} | | | | | | |`);
      continue;
    }
    console.log(
      `| ${r.arm} | ${r.label} | ${r.counts.fivexx_log} | ${r.counts.null_pointer} | ` +
        `${r.counts.read_timed_out} | ${r.counts.loaded_ok} | ${r.prometheus_5xx_ratio_max} | ${r.expect} |`,
    );
  }
}

// 仅在被直接执行时跑；被 import 时只导出 parseMatrix（负对照要这么用）。
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
