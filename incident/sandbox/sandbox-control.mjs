#!/usr/bin/env node
// 沙箱闸门控制（负对照）。
//
// ── 这把尺子量什么 ───────────────────────────────────────────────────────────
//
// host 模式的 Agent 曾经能直读宿主机任意文件。沙箱装上之后，"读不到"这件事
// 必须**可复核**，不能靠人相信。本控制把沙箱按产品真实的构造方式搭起来，把一
// 串探针塞进去，然后逐条断言：
//
//   1. 该不可见的路径确实不可见（答案键、公司凭据、故障注入脚本、docker socket）
//   2. 该可见的路径确实可见（工作区）
//   3. 合法通道仍然可用（metrics / logs / git / runtime env）
//   4. docker shim 只放行两个格式，其余一律拒绝
//
// ── 为什么还有一条负对照 ────────────────────────────────────────────────────
//
// 上面 4 条全是"沙箱开着时应该成立"。如果尺子只在沙箱开着时跑，那么"沙箱没
// 装上"这件事它一样会报绿——量具坏了，长得却像台子没炸（这个项目栽过一次）。
//
// 所以本控制**必须**在沙箱关掉时看到洞：同一串探针，不带沙箱跑一遍，断言
// "确实读到了本该读不到的东西"。读不到洞 = 尺子坏了 = 本控制失败。
//
// 用法：
//   node incident/sandbox/sandbox-control.mjs            # 跑全部
//   node incident/sandbox/sandbox-control.mjs --verbose   # 打印探针原始输出
//
// 退出码：0 全绿；1 有断言没过。

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const POLICY = JSON.parse(readFileSync(join(HERE, 'policy.json'), 'utf8'));
const LAB_PATHS = JSON.parse(
  readFileSync(join(REPO_ROOT, 'incident/lab-paths.json'), 'utf8'),
);

const VERBOSE = process.argv.includes('--verbose');
const WORKSPACE = POLICY.workspaceRoots[0];
const CLI = join(WORKSPACE, 'tools/incident-readonly.mjs');

// 产品真实构造沙箱的那段代码。控制必须量**产品**，不能量一份复刻——复刻会漂。
const PRODUCT_SANDBOX_MODULE = join(REPO_ROOT, 'dist/host-sandbox.js');

// 沙箱构造需要两个可写目录（会话目录、IPC 目录）。控制自己造一个临时的，
// 不去碰真实工作区的会话目录——控制量的是可见性策略，不是会话接线。
const SCRATCH = mkdtempSync(join(tmpdir(), 'miniclaw-sandbox-control-'));
mkdirSync(join(SCRATCH, 'sessions'), { recursive: true });
mkdirSync(join(SCRATCH, 'ipc'), { recursive: true });
process.on('exit', () => {
  try {
    rmSync(SCRATCH, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function fail(message) {
  console.error(`sandbox-control: ${message}`);
  if (!existsSync(PRODUCT_SANDBOX_MODULE)) {
    console.error(
      '  产品的 host-sandbox 模块没有编译。先跑 `npm run build`（控制量的是产物，不是源）。',
    );
  }
  process.exit(1);
}

if (!existsSync(PRODUCT_SANDBOX_MODULE)) {
  fail(`找不到 ${PRODUCT_SANDBOX_MODULE}`);
}

// ── 探针 ─────────────────────────────────────────────────────────────────────
//
// 探针代码走 argv（-e），不进文件：仓库里的 incident/ 目录整体对 Agent 不可见，
// 探针文件放在那里的话，沙箱里的控制自己都读不到自己的探针。
const PROBE = `
const fs = require('fs');
const { execFileSync } = require('child_process');
const out = { paths: {}, channels: {}, shim: {} };
const PATHS = ${JSON.stringify(POLICY.mustBeInvisible)};
for (const p of PATHS) {
  let state;
  try {
    state = fs.existsSync(p) ? 'readable' : 'missing';
    if (state === 'readable') {
      try {
        const st = fs.statSync(p);
        if (st.isDirectory()) fs.readdirSync(p);
        else fs.readFileSync(p);
      } catch (e) { state = 'exists-unreadable'; }
    }
  } catch (e) { state = 'error:' + e.code; }
  out.paths[p] = state;
}
out.paths['__workspace__'] = fs.existsSync(${JSON.stringify(WORKSPACE)}) ? 'readable' : 'missing';
out.paths['__workspace_listing__'] = (() => {
  try { return fs.readdirSync(${JSON.stringify(WORKSPACE)}).sort().join(','); } catch (e) { return 'error:' + e.code; }
})();

function run(args, opts) {
  try {
    const stdout = execFileSync(process.execPath, args, Object.assign({
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000,
      cwd: ${JSON.stringify(WORKSPACE)},
    }, opts || {}));
    return { ok: true, stdout };
  } catch (err) {
    return { ok: false, stdout: String(err.stdout || ''), stderr: String(err.stderr || err.message || '') };
  }
}

const CLI = ${JSON.stringify(CLI)};
out.channels.metrics = run([CLI, 'metrics', 'query', 'up']);
out.channels.logs = run([CLI, 'logs', 'grep', 'ERROR', '--count']);
out.channels.git = run([CLI, 'git', 'log', '--limit', '1']);
out.channels.runtime_env = run([CLI, 'runtime', 'env']);
out.channels.runtime_started = run([CLI, 'runtime', 'started']);

// shim：放行的两个格式必须答得出来；不在名单里的必须被拒。
// 这里跑的是 docker 命令本身（不是 node），所以走 PATH 解析。
function runCmd(cmd, args) {
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
      cwd: ${JSON.stringify(WORKSPACE)},
    });
    return { ok: true, stdout };
  } catch (err) {
    return { ok: false, stdout: String(err.stdout || ''), stderr: String(err.stderr || err.message || '') };
  }
}
out.shim.allowed_started = runCmd('docker', ['inspect', 'target-service', '--format', '{{.State.StartedAt}}']);
out.shim.allowed_env = runCmd('docker', ['inspect', 'target-service', '--format', '{{range .Config.Env}}{{println .}}{{end}}']);
out.shim.bad_format = runCmd('docker', ['inspect', 'target-service', '--format', '{{.Id}}']);
out.shim.bad_container = runCmd('docker', ['inspect', 'some-other-container', '--format', '{{.State.StartedAt}}']);
out.shim.bad_subcommand = runCmd('docker', ['run', '-v', '/:/mnt', 'alpine', 'ls', '/root']);
out.shim.socket_present = fs.existsSync(process.env.INCIDENT_FACTS_SOCKET || '');

process.stdout.write(JSON.stringify(out));
`;

function sandboxEnv() {
  const nodeBin = process.execPath;
  const pathValue = [
    POLICY.shimBinDir,
    nodeBin.replace(/\/[^/]+$/, ''),
    '/usr/local/sbin',
    '/usr/local/bin',
    '/usr/sbin',
    '/usr/bin',
    '/sbin',
    '/bin',
  ].join(':');
  return {
    PATH: pathValue,
    INCIDENT_FACTS_SOCKET: POLICY.factsSocket,
  };
}

async function runProbe({ sandboxed }) {
  const { buildHostSandboxPlan } = await import(
    `file://${PRODUCT_SANDBOX_MODULE}`
  );
  const env = { ...process.env, ...sandboxEnv() };
  const nodeBin = process.execPath;

  if (!sandboxed) {
    // 负对照：不带沙箱，Agent 看得见整个宿主机。
    const res = spawnSync(nodeBin, ['-e', PROBE], {
      encoding: 'utf8',
      env,
      cwd: WORKSPACE,
      timeout: 120000,
    });
    return { stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  }

  const plan = buildHostSandboxPlan({
    config: {
      provider: 'bwrap',
      env: sandboxEnv(),
    },
    workspaceDir: WORKSPACE,
    sessionsDir: join(SCRATCH, 'sessions'),
    ipcDir: join(SCRATCH, 'ipc'),
    agentRunnerRoot: join(REPO_ROOT, 'container/agent-runner'),
    nodeBinary: nodeBin,
    command: nodeBin,
    commandArgs: ['-e', PROBE],
    env,
    cwd: WORKSPACE,
    readablePaths: [POLICY.stateDir.replace(/\/run$/, '')],
    writablePaths: [],
  });
  if (!plan) {
    console.error('sandbox-control: 产品没有产出沙箱方案');
    process.exit(1);
  }
  const res = spawnSync(plan.command, plan.args, {
    encoding: 'utf8',
    env: plan.env,
    cwd: WORKSPACE,
    timeout: 120000,
  });
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function parseProbe(result) {
  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    console.error('sandbox-control: 探针没有产出可解析的 JSON');
    console.error(result.stderr.slice(0, 2000));
    if (VERBOSE) console.error(result.stdout.slice(0, 2000));
    process.exit(1);
  }
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(
    `[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`,
  );
}

// ── 1. 沙箱开着 ──────────────────────────────────────────────────────────────
const sandboxed = parseProbe(await runProbe({ sandboxed: true }));

for (const p of POLICY.mustBeInvisible) {
  check(
    `沙箱内不可见：${p}`,
    sandboxed.paths[p] !== 'readable' &&
      sandboxed.paths[p] !== 'exists-unreadable',
    `实际=${sandboxed.paths[p]}`,
  );
}

check(
  '沙箱内可见：工作区',
  sandboxed.paths['__workspace__'] === 'readable',
  `listing=${sandboxed.paths['__workspace_listing__']}`,
);

check(
  '合法通道可用：metrics query',
  sandboxed.channels.metrics.ok,
  (sandboxed.channels.metrics.stdout || sandboxed.channels.metrics.stderr || '')
    .trim()
    .slice(0, 80),
);
check(
  '合法通道可用：logs grep',
  sandboxed.channels.logs.ok,
  (sandboxed.channels.logs.stdout || sandboxed.channels.logs.stderr || '')
    .trim()
    .slice(0, 80),
);
check(
  '合法通道可用：git log',
  sandboxed.channels.git.ok,
  (sandboxed.channels.git.stdout || sandboxed.channels.git.stderr || '')
    .trim()
    .slice(0, 80),
);
check(
  '合法通道可用：runtime env（经 docker shim）',
  sandboxed.channels.runtime_env.ok &&
    /DOWNSTREAM_TIMEOUT_MS|DB_POOL_SIZE|container_env/.test(
      sandboxed.channels.runtime_env.stdout,
    ),
  (
    sandboxed.channels.runtime_env.stdout ||
    sandboxed.channels.runtime_env.stderr ||
    ''
  )
    .trim()
    .slice(0, 120),
);
check(
  '合法通道可用：runtime started（经 docker shim）',
  sandboxed.channels.runtime_started.ok &&
    /20\d\d-\d\d-\d\dT/.test(sandboxed.channels.runtime_started.stdout),
  (
    sandboxed.channels.runtime_started.stdout ||
    sandboxed.channels.runtime_started.stderr ||
    ''
  )
    .trim()
    .slice(0, 120),
);

check(
  'shim：放行格式答得出来',
  sandboxed.shim.allowed_started.ok && sandboxed.shim.allowed_env.ok,
);
check('shim：不在名单的格式被拒', !sandboxed.shim.bad_format.ok);
check('shim：不在名单的容器被拒', !sandboxed.shim.bad_container.ok);
check('shim：其它子命令被拒', !sandboxed.shim.bad_subcommand.ok);

// ── 2. 负对照：沙箱关掉 ──────────────────────────────────────────────────────
//
// 尺子必须能看见洞。读不到洞，说明这把尺子测不出东西——那它刚才的"全绿"就不算数。
const unsandboxed = parseProbe(await runProbe({ sandboxed: false }));
const leaked = POLICY.mustBeInvisible.filter(
  (p) => unsandboxed.paths[p] === 'readable',
);
check(
  '负对照：不带沙箱时确实读得到本该读不到的东西（尺子能看见洞）',
  leaked.length > 0,
  `读到 ${leaked.length} 条：${leaked.slice(0, 3).join(', ')}`,
);

if (VERBOSE) {
  console.log('\n--- 沙箱内探针原始输出 ---');
  console.log(JSON.stringify(sandboxed, null, 2));
  console.log('\n--- 无沙箱探针原始输出 ---');
  console.log(JSON.stringify(unsandboxed, null, 2));
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n沙箱控制：${results.length - failed.length}/${results.length} 项通过`,
);
if (failed.length > 0) {
  console.error('未通过的断言：');
  for (const f of failed)
    console.error(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
  process.exit(1);
}
