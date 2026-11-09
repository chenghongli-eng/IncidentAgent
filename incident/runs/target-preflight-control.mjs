#!/usr/bin/env node
// 真实靶子前置闸门的负对照。
//
// 这套闸门（runs/target-preflight.mjs）是**新加**的，所以它自己得先证明
// 「认得出坏」——否则它就是那种「怎么都绿」的闸门：闸门坏了，长得却像台子
// 没问题。合成夹具那边踩过这个坑（比例量具把 Prometheus 的返回形状认错了，
// C 臂真实的 43.6% 峰值被读成 0）。
//
// 规矩（实验室通用）：
//   · 每一条负对照都要配一条**只差一个变量**的正对照——不然「负对照红了」
//     可能只是因为整个环境是坏的。
//   · 断言「某句话**不**出现」时，不能用一句输出里本来就有的合法内容；
//     所以这里一律断言**该出现的话出现了**。
//   · 负对照红 = 闸门认不出坏；正对照红 = 闸门把好好的判成坏的。两种都要红。
//
// 另外还钉住一件事：**描述文件的解析规则不能和 CLI 漂移**。
// CLI（tools/incident-readonly.mjs）属于产品本体，改它要重跑整轮回归，
// 所以编排侧没有去动它，而是让本对照把两边**对拍**：CLI 的 `target info`
// 说什么，本模块就得解析成什么。

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { realTargetPreflight } from './target-preflight.mjs';
import { resolveTarget, targetProfile } from '../targets/descriptor.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

let pass = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` —— ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

function gate(gates, id) {
  return gates.find((g) => g.id === id);
}

// ─────────────────────────────────────────────────────────────────────
// 一个「一切都好」的靶子档案，和它的假依赖。
//
// 假依赖用真实的 fs 与假的网络：网络那几层（Prometheus 的返回形状、
// actuator 的状态码）是最容易认错的地方，所以假依赖要照着**真实返回的形状**
// 造，而不是造一个「方便断言」的形状。
// ─────────────────────────────────────────────────────────────────────
function fakeProfile(overrides = {}) {
  return {
    mode: 'descriptor',
    id: 'fake',
    application: 'fake-app',
    metricLabelName: 'application',
    prometheusUrl: 'http://prom.invalid:9094',
    actuatorBaseUrl: 'http://127.0.0.1:19999',
    logsDir: '/fake/logs',
    repoPath: '/fake/repo',
    container: null,
    logFiles: ['all.log'],
    ledgerPath: '/fake/ledger.jsonl',
    startedAt: null,
    descriptorFile: '/fake/target.json',
    ...overrides,
  };
}

function fakeDeps(overrides = {}) {
  const logFile = '/fake/logs/all.log';
  const base = {
    async fetchJson(url) {
      if (url.includes('/api/v1/rules')) {
        return {
          status: 'success',
          data: { groups: [{ name: 'g', rules: [] }] },
        };
      }
      if (url.includes('/api/v1/alerts')) {
        return { status: 'success', data: { alerts: [] } };
      }
      // 剩下的都是 query：up / 指标存在 / 5xx 比例
      if (url.includes('query=up')) {
        return { status: 'success', data: { result: [{ value: [0, '1'] }] } };
      }
      // 5xx 比例（query 是 URL 编码过的，所以匹配编码后的形态）
      if (url.includes(encodeURIComponent('status=~'))) {
        return { status: 'success', data: { result: [{ value: [0, '0'] }] } };
      }
      // 指标存在性
      return { status: 'success', data: { result: [{ value: [0, '42'] }] } };
    },
    async fetchStatus() {
      return 200;
    },
    sh(cmd) {
      if (cmd.startsWith('lsof')) return { code: 0, out: '4242', err: '' };
      return { code: 0, out: '', err: '' };
    },
    existsSync: (p) => p === '/fake/ledger.jsonl' || p === '/fake/logs',
    readdirSync: () => ['1', '2'],
    readlinkSync: (p) => {
      if (p.endsWith('/fd/1')) return logFile;
      if (p.endsWith('/fd/2')) return '/fake/logs/other.log';
      return '/dev/null';
    },
    statSync: (p) => ({
      isDirectory: () => p === '/fake/logs',
    }),
    sleep: async () => {},
  };
  return { ...base, ...overrides };
}

// ── 正对照：一切都好 → 五条闸门全绿 ──────────────────────────────────
console.log('\n[正对照] 一切都好的真实靶子');
{
  const { gates } = await realTargetPreflight(fakeProfile(), fakeDeps());
  for (const id of ['P1', 'P2', 'P3', 'P4', 'P5']) {
    const g = gate(gates, id);
    check(`${id} 通过`, g?.ok === true, g?.detail);
  }
  check(
    'P2 说清了「日志通道由靶子自己持有」',
    /自己持有/.test(gate(gates, 'P2').detail),
    gate(gates, 'P2').detail,
  );
  check(
    'P3 说清了活性信号为什么不是「日志在长」',
    /不用「日志在长」/.test(gate(gates, 'P3').detail),
    gate(gates, 'P3').detail,
  );
  check(
    'P5 说清了「没告警」这句有规则撑着',
    /有规则撑着/.test(gate(gates, 'P5').detail),
    gate(gates, 'P5').detail,
  );
}

// ── 负对照 1：Prometheus 不可查 → P1 红 ─────────────────────────────
console.log('\n[负对照 1] Prometheus 不可查');
{
  const deps = fakeDeps({
    async fetchJson(url) {
      if (url.includes('/api/v1/query')) throw new Error('connection refused');
      return fakeDeps().fetchJson(url);
    },
  });
  const { gates } = await realTargetPreflight(fakeProfile(), deps);
  check('P1 红了', gate(gates, 'P1').ok === false);
  check(
    'P1 说清了是 Prometheus 不可查',
    /Prometheus 不可查/.test(gate(gates, 'P1').detail),
    gate(gates, 'P1').detail,
  );
  // 只差一个变量：跟 Prometheus 无关的那条（P2 查的是进程的文件描述符）仍然绿。
  check(
    'P2 仍然是绿的（只差一个变量：它不依赖 Prometheus）',
    gate(gates, 'P2').ok === true,
    gate(gates, 'P2').detail,
  );
  // 依赖 Prometheus 的那两条**必须红**。数据源都读不到了还报绿，
  // 就是「闸门静默跳过」——那一类缺陷比闸门直接红更坏。
  for (const id of ['P3', 'P4']) {
    check(
      `${id} 也红了（数据源读不到就不能报绿）`,
      gate(gates, id).ok === false,
      gate(gates, id).detail,
    );
  }
}

// ── 负对照 2：靶子不持有日志写句柄 → P2 红 ───────────────────────────
console.log('\n[负对照 2] 靶子进程不持有日志文件（日志退回 stdout）');
{
  const deps = fakeDeps({
    readlinkSync: () => '/dev/null',
  });
  const { gates } = await realTargetPreflight(fakeProfile(), deps);
  check('P2 红了', gate(gates, 'P2').ok === false);
  check(
    'P2 说清了日志通道不活',
    /日志通道不活/.test(gate(gates, 'P2').detail),
    gate(gates, 'P2').detail,
  );
  check(
    'P2 说清了「目录里有日志文件」不等于「靶子在写」',
    /日志通道/.test(gate(gates, 'P2').detail),
  );
}

// ── 负对照 3：靶子不在指标里 → P3 红 ────────────────────────────────
console.log('\n[负对照 3] 靶子自己的指标查不到');
{
  const deps = fakeDeps({
    async fetchJson(url) {
      if (url.includes('/api/v1/query') && !url.includes('query=up')) {
        return { status: 'success', data: { result: [] } };
      }
      return fakeDeps().fetchJson(url);
    },
  });
  const { gates } = await realTargetPreflight(fakeProfile(), deps);
  check('P3 红了', gate(gates, 'P3').ok === false);
  check(
    'P3 说清了查不到指标',
    /查不到/.test(gate(gates, 'P3').detail),
    gate(gates, 'P3').detail,
  );
}

// ── 负对照 4：基线有 5xx → P4 红 ────────────────────────────────────
console.log('\n[负对照 4] 基线 5xx 比例不为 0');
{
  const deps = fakeDeps({
    async fetchJson(url) {
      if (url.includes(encodeURIComponent('status=~'))) {
        return { status: 'success', data: { result: [{ value: [0, '0.2'] }] } };
      }
      return fakeDeps().fetchJson(url);
    },
  });
  const { gates } = await realTargetPreflight(fakeProfile(), deps);
  check('P4 红了', gate(gates, 'P4').ok === false);
  check(
    'P4 说清了比例是多少',
    /0\.2/.test(gate(gates, 'P4').detail),
    gate(gates, 'P4').detail,
  );
}

// ── 负对照 5：Prometheus 一条告警规则都没有 → P5 红 ─────────────────
console.log('\n[负对照 5] Prometheus 没有加载任何告警规则');
{
  const deps = fakeDeps({
    async fetchJson(url) {
      if (url.includes('/api/v1/rules')) {
        return { status: 'success', data: { groups: [] } };
      }
      return fakeDeps().fetchJson(url);
    },
  });
  const { gates } = await realTargetPreflight(fakeProfile(), deps);
  check('P5 红了', gate(gates, 'P5').ok === false);
  check(
    'P5 说清了「没告警」是空话',
    /一条告警规则都没有/.test(gate(gates, 'P5').detail),
    gate(gates, 'P5').detail,
  );
  check(
    'P5 说清了这条闸门证明不了基线干净',
    /证明不了/.test(gate(gates, 'P5').detail),
    gate(gates, 'P5').detail,
  );
}

// ── 负对照 6：告警已经在 firing → P5 红 ─────────────────────────────
console.log('\n[负对照 6] HighServerErrorRate 已经在 firing');
{
  const deps = fakeDeps({
    async fetchJson(url) {
      if (url.includes('/api/v1/alerts')) {
        return {
          status: 'success',
          data: {
            alerts: [
              { labels: { alertname: 'HighServerErrorRate' }, state: 'firing' },
            ],
          },
        };
      }
      return fakeDeps().fetchJson(url);
    },
  });
  const { gates } = await realTargetPreflight(fakeProfile(), deps);
  check('P5 红了', gate(gates, 'P5').ok === false);
  check(
    'P5 说清了是哪个告警在 firing',
    /HighServerErrorRate/.test(gate(gates, 'P5').detail),
    gate(gates, 'P5').detail,
  );
}

// ── 描述文件过期（漂移）必须被说出来 ────────────────────────────────
console.log('\n[漂移] 描述文件写的日志目录与靶子实际写的不是一处');
{
  const { gates, facts } = await realTargetPreflight(
    fakeProfile({ logsDir: '/stale/logs' }),
    fakeDeps(),
  );
  check(
    'P2 仍然是绿的（日志通道本身是活的）',
    gate(gates, 'P2').ok === true,
    gate(gates, 'P2').detail,
  );
  check(
    'P2 把漂移说出来了',
    /描述文件已过期/.test(gate(gates, 'P2').detail),
    gate(gates, 'P2').detail,
  );
  check(
    'facts 里记了实测的日志目录',
    facts.measured_logs_dir === '/fake/logs',
    String(facts.measured_logs_dir),
  );
  check(
    'facts 里记了漂移本身',
    /已过期/.test(facts.logs_dir_drift ?? ''),
    String(facts.logs_dir_drift),
  );
}

// ── 解析规则不能和 CLI 漂移 ─────────────────────────────────────────
console.log('\n[对拍] 描述文件的解析与 CLI 的 target info 必须一致');
{
  const dir = mkdtempSync(join(tmpdir(), 'incident-descriptor-'));
  try {
    const file = join(dir, 'p9.json');
    writeFileSync(
      file,
      JSON.stringify({
        id: 'p9',
        application: 'p9-app',
        prometheusUrl: 'http://127.0.0.1:19094',
        actuatorBaseUrl: 'http://127.0.0.1:19999',
        logsDir: '/fake/logs',
        repoPath: '/fake/repo',
        ledgerPath: '/fake/ledger.jsonl',
      }),
    );
    const env = {
      ...process.env,
      INCIDENT_TARGET_FILE: file,
      DEPLOY_LEDGER: undefined,
      PROMETHEUS_URL: undefined,
      TARGET_URL: undefined,
      LOG_DIR: undefined,
      TARGET_REPO: undefined,
    };
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];

    // CLI 怎么说
    const raw = execFileSync(
      process.execPath,
      [join(ROOT, 'incident/tools/incident-readonly.mjs'), 'target', 'info'],
      { env, encoding: 'utf8' },
    );
    const cli = JSON.parse(raw);

    // 本模块怎么说
    const profile = targetProfile(resolveTarget(null, env), env);

    check('id 一致', cli.id === profile.id, `${cli.id} vs ${profile.id}`);
    check(
      'application 一致',
      cli.application === profile.application,
      `${cli.application} vs ${profile.application}`,
    );
    check(
      'Prometheus 一致',
      cli.prometheus === profile.prometheusUrl,
      `${cli.prometheus} vs ${profile.prometheusUrl}`,
    );
    check(
      'actuator 一致',
      cli.actuator === profile.actuatorBaseUrl,
      `${cli.actuator} vs ${profile.actuatorBaseUrl}`,
    );
    check(
      '仓库路径一致',
      cli.repo === profile.repoPath,
      `${cli.repo} vs ${profile.repoPath}`,
    );
    check(
      '日志目录一致',
      cli.logs_dir === profile.logsDir,
      `${cli.logs_dir} vs ${profile.logsDir}`,
    );
    check(
      '部署台账一致',
      cli.deploy_ledger === profile.ledgerPath,
      `${cli.deploy_ledger} vs ${profile.ledgerPath}`,
    );
    check(
      '描述文件路径一致',
      cli.descriptor === profile.descriptorFile,
      `${cli.descriptor} vs ${profile.descriptorFile}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 描述文件不存在时要**炸**，不许悄悄回退到夹具 ─────────────────────
console.log('\n[负对照 7] 描述文件路径写错');
{
  let threw = false;
  let message = '';
  try {
    resolveTarget(null, { INCIDENT_TARGET_FILE: '/definitely/not/here.json' });
  } catch (err) {
    threw = true;
    message = err.message;
  }
  check('抛错了（没有回退到内置默认值）', threw);
  check(
    '错误信息点名了那个路径',
    /\/definitely\/not\/here\.json/.test(message),
    message,
  );
}

console.log(`\n${pass} 通过 / ${failures.length} 失败`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
