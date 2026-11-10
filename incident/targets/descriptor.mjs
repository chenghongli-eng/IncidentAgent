// 靶子描述文件的解析，以及由此推出的「通道档案」。
//
// 为什么单独一个文件：`tools/incident-readonly.mjs`（Agent 的唯一证据通道）和
// `runs/run-round.mjs`（轮次编排）都要知道同一件事——这个靶子的日志在哪、
// Prometheus 在哪、指标带什么标签。两边各写一份，早晚漂移：CLI 读 A 目录、
// 编排读 B 目录，那么 Agent 拿到的证据和这一轮测的东西就不是同一个靶子，
// 而且这种漂移**不会报错**，只会让报告看起来很有道理。
//
// 但 CLI 属于**产品本体**（改它要重跑整轮回归），所以这里**不动 CLI**。
// 折中办法是：解析规则按 `targets/README.md` 写的那套顺序实现一份，
// 再由 `runs/target-preflight-control.mjs` 把本文件的解析结果和 CLI 自己的
// `target info` 输出**对拍**——两边不一致，对照就红。
// 于是「不漂移」是**被检查的**，不是靠自觉。
//
// 真实靶子的描述文件含内部路径，**放在仓库外**（`INCIDENT_TARGET_FILE` 或
// `INCIDENT_TARGET` + `INCIDENT_TARGET_DIR`）。仓库里只有合成夹具的内置默认值。

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 本文件在 incident/targets/ 下，所以「夹具默认值」相对它就是 ../logs/ 与
// ../target-service/——和 CLI（incident/tools/）相对自身算出来的同一处。
const HERE = dirname(fileURLToPath(import.meta.url));

export const FIXTURE_DEFAULTS = {
  prometheusUrl: 'http://127.0.0.1:9090',
  actuatorBaseUrl: 'http://127.0.0.1:8080',
  logsDir: join(HERE, '..', 'logs'),
  repoPath: join(HERE, '..', 'target-service'),
  container: 'target-service',
  appStartedPattern: 'Started TargetServiceApplication',
};

/**
 * 按约定的顺序找描述文件。
 *
 * 顺序（与 targets/README.md 一致）：
 *   1. INCIDENT_TARGET_FILE —— 绝对路径
 *   2. INCIDENT_TARGET      —— 名字，在 INCIDENT_TARGET_DIR（冒号分隔）里找
 *   3. 都没有               —— 返回 null（调用方用内置默认值）
 *
 * 找不到时**抛错**，不静默回退：描述文件写错路径时回退到默认靶子，
 * 这一轮就会拿合成夹具的证据去回答真实靶子的问题——错得毫无痕迹。
 */
export function findDescriptor(env = process.env, { extraDirs = [] } = {}) {
  const explicit = env.INCIDENT_TARGET_FILE;
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`INCIDENT_TARGET_FILE does not exist: ${explicit}`);
    }
    return readDescriptor(explicit);
  }
  const name = env.INCIDENT_TARGET;
  if (!name) return null;
  const dirs = [
    ...(env.INCIDENT_TARGET_DIR ?? '').split(':').filter(Boolean),
    ...extraDirs,
    HERE,
  ];
  for (const dir of dirs) {
    const file = join(dir, `${name}.json`);
    if (existsSync(file)) return readDescriptor(file);
  }
  throw new Error(`target "${name}" not found in: ${dirs.join(', ')}`);
}

export function readDescriptor(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(
      `target descriptor ${file} is not readable JSON: ${err.message}`,
    );
  }
  return { ...parsed, __file: file };
}

/**
 * 命令行给的靶子规格 → 描述文件。
 *
 * `--target` 可以给**路径**（含 '/' 或以 .json 结尾），也可以给**名字**
 * （在 INCIDENT_TARGET_DIR 与本目录里找）。两者混在一个选项里，是因为调用者
 * 关心的是「我要打哪个靶子」，而不是「它是按名字索引的还是按路径指的」。
 */
export function resolveTarget(spec, env = process.env) {
  if (!spec) return findDescriptor(env);
  if (spec.includes('/') || spec.endsWith('.json')) {
    return readDescriptor(spec);
  }
  return findDescriptor(
    { ...env, INCIDENT_TARGET: spec },
    {
      extraDirs: (env.INCIDENT_TARGET_DIR ?? '').split(':').filter(Boolean),
    },
  );
}

/**
 * 从描述文件推出**通道档案**：这一轮要用的每个通道的地址与标签。
 *
 * 环境变量优先于描述文件（targets/README.md 的规矩）：轮次编排用它把通道
 * 指向当时的工作区。合成夹具没有描述文件时，全部落到内置默认值——
 * 与改动前逐字相同。
 */
export function targetProfile(descriptor, env = process.env) {
  const d = descriptor ?? {};
  return {
    mode: descriptor ? 'descriptor' : 'builtin',
    id: d.id ?? null,
    application: d.application ?? null,
    metricLabelName: d.metricLabelName ?? 'application',
    metricLabelAliases: d.metricLabelAliases ?? [],
    prometheusUrl:
      env.PROMETHEUS_URL ?? d.prometheusUrl ?? FIXTURE_DEFAULTS.prometheusUrl,
    actuatorBaseUrl:
      env.TARGET_URL ?? d.actuatorBaseUrl ?? FIXTURE_DEFAULTS.actuatorBaseUrl,
    logsDir: env.LOG_DIR ?? d.logsDir ?? FIXTURE_DEFAULTS.logsDir,
    repoPath: env.TARGET_REPO ?? d.repoPath ?? FIXTURE_DEFAULTS.repoPath,
    container:
      env.TARGET_CONTAINER ?? d.container ?? FIXTURE_DEFAULTS.container,
    appStartedPattern:
      d.appStartedPattern ?? FIXTURE_DEFAULTS.appStartedPattern,
    logFiles: d.logFiles ?? [],
    ledgerPath: env.DEPLOY_LEDGER ?? d.ledgerPath ?? null,
    /**
     * 启动规格（宿主机形态靶子用）。
     *
     * 规格在仓库外——它是这一轮的答案键的一部分（故障旋钮写在里面）。
     * 这里只把路径带出来，读不读由轮次编排决定。
     */
    launchSpec: d.launchSpec ?? null,
    startedAt: d.startedAt ?? null,
    descriptorFile: descriptor?.__file ?? null,
  };
}

/**
 * 指标的 application 标签值。
 *
 * 合成夹具的指标带 `application="target-service"`；真实靶子带自己的值。
 * 没有描述文件时就是夹具的字面量——所以 PromQL 在两种模式下是同一句。
 */
export function applicationLabel(profile) {
  return profile.application ?? 'target-service';
}
