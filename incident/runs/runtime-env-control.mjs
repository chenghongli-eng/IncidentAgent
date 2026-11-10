#!/usr/bin/env node
/**
 * `runtime env` 对**宿主机形态**靶子的对照。
 *
 * 为什么要单独测这一条：`runtime env` 原来只有容器一条路
 * （`docker inspect` 拿容器环境）。靶子是宿主机进程时它报
 * 「container_env: (unavailable)」——不是「靶子没有旋钮」，
 * 是这条通道对宿主机形态**失明**了。进程实实在在带着
 * `--spring.datasource.dynamic.druid.max-wait=1` 跑着，Agent 却看不到，
 * 于是「旋钮被改过」这类根因在真实靶子上拿不到任何证据支撑。
 *
 * 这一组对照验三件事：
 *   1. 旋钮**看得见**（正对照）：argv 里的配置项要原样打出来；
 *   2. 凭据**看不见**（负对照，且与正对照形态相同）：
 *      `--...password=...` 与 `SPRING_*_PASSWORD=...` 的值必须被遮掉，
 *      而形态相同、只是名字里没有敏感词的必须**照常打出来**——
 *      否则「脱敏」就退化成了「什么都不给」，而那也是一种失效；
 *   3. 与靶子无关的环境变量**不进这条通道**：
 *      宿主机形态的进程会继承一整套桌面会话环境（实测 100 个变量，
 *      里面混着别人的令牌），全量打印等于把凭据抄给 Agent。
 *
 * 用法：node incident/runs/runtime-env-control.mjs
 * 退出码：0 = 全过；1 = 有失败（逐条打印）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const CLI = join(ROOT, 'incident/tools/incident-readonly.mjs');

let pass = 0;
let fail = 0;

function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? `：${detail}` : ''}`);
  }
}

/**
 * 起一个假进程：它自己监听一个端口，并且带着指定的 argv 与环境。
 *
 * 为什么用「真起一个进程」而不是造一个假的 /proc 目录：
 * CLI 是靠**端口**找进程的（lsof -ti:PORT -sTCP:LISTEN），
 * 造假的 /proc 就得连定位逻辑一起造，测的就不是线上那条路了。
 */
function startFakeTarget({ argv = [], env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-env-control-'));
  const script = join(dir, 'fake-target.mjs');
  writeFileSync(
    script,
    `import { createServer } from 'node:http';\n` +
      `const server = createServer((req, res) => { res.writeHead(200); res.end('ok'); });\n` +
      `server.listen(0, '127.0.0.1', () => {\n` +
      `  process.stdout.write(String(server.address().port) + '\\n');\n` +
      `});\n`,
  );
  const child = spawn(process.execPath, [script, ...argv], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/\d+/);
      if (m) resolve({ child, port: Number(m[0]), dir });
    });
    child.on('error', reject);
    setTimeout(() => reject(new Error('假靶子没起来')), 10000);
  });
}

function runCli(port, extraEnv = {}, { runtimeForm = 'host' } = {}) {
  const descriptor = join(
    mkdtempSync(join(tmpdir(), 'runtime-env-desc-')),
    'target.json',
  );
  const desc = {
    id: 'control',
    application: 'control',
    actuatorBaseUrl: `http://127.0.0.1:${port}`,
    prometheusUrl: 'http://127.0.0.1:1',
    logsDir: '/tmp',
  };
  if (runtimeForm) desc.runtimeForm = runtimeForm;
  writeFileSync(descriptor, JSON.stringify(desc));
  const r = spawnSync(process.execPath, [CLI, 'runtime', 'env'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      INCIDENT_TARGET_FILE: descriptor,
      DEPLOY_LEDGER: '/dev/null',
      ...extraEnv,
    },
    timeout: 30000,
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

async function main() {
  console.log('runtime env（宿主机形态）对照：');

  // ── 对照 1：旋钮要看得见 ────────────────────────────────────────────
  {
    const { child, port, dir } = await startFakeTarget({
      argv: ['--server.port=1', '--spring.datasource.dynamic.druid.max-wait=1'],
    });
    try {
      const r = runCli(port);
      check(
        'argv 里的运行时旋钮原样打出来（宿主机形态不再瞎）',
        r.code === 0 &&
          r.out.includes('--spring.datasource.dynamic.druid.max-wait=1'),
        `exit=${r.code}\n${r.out.slice(0, 800)}`,
      );
      check(
        '宿主机形态下仍然明说容器环境不可用（不是「没旋钮」）',
        r.out.includes(
          'container_env: (unavailable: target runs as a host process)',
        ),
        r.out.slice(0, 400),
      );
    } finally {
      child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // ── 对照 2：凭据要看不见（负对照）──────────────────────────────────
  // 形态与对照 1 完全一样，只是值的名字里带敏感词。
  {
    const { child, port, dir } = await startFakeTarget({
      argv: [
        '--spring.datasource.dynamic.druid.max-wait=1',
        '--spring.datasource.password=hunter2',
      ],
      env: { SPRING_DATASOURCE_PASSWORD: 'hunter2-in-env' },
    });
    try {
      const r = runCli(port);
      check(
        'argv 里的凭据值被遮掉',
        !r.out.includes('hunter2') &&
          r.out.includes('--spring.datasource.password=<redacted>'),
        r.out.slice(0, 800),
      );
      check(
        '环境里的凭据值被遮掉',
        !r.out.includes('hunter2-in-env'),
        r.out.slice(0, 800),
      );
      check(
        '脱敏不能把旋钮一起吃掉（近邻正对照）',
        r.out.includes('--spring.datasource.dynamic.druid.max-wait=1'),
        r.out.slice(0, 800),
      );
    } finally {
      child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // ── 对照 3：与靶子无关的环境不进这条通道 ───────────────────────────
  {
    const { child, port, dir } = await startFakeTarget({
      argv: ['--server.port=1'],
      env: {
        ANTHROPIC_AUTH_TOKEN: 'sk-should-never-be-printed',
        SOME_RANDOM_VAR: 'should-never-be-printed',
        SPRING_PROFILES_ACTIVE: 'dev',
      },
    });
    try {
      const r = runCli(port);
      check(
        '别人的令牌不进这条通道',
        !r.out.includes('sk-should-never-be-printed'),
        r.out.slice(0, 800),
      );
      check(
        '与靶子无关的环境变量不进这条通道',
        !r.out.includes('should-never-be-printed'),
        r.out.slice(0, 800),
      );
      check(
        '应用自己的配置照常打出来（近邻正对照）',
        r.out.includes('SPRING_PROFILES_ACTIVE=dev'),
        r.out.slice(0, 800),
      );
    } finally {
      child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // ── 对照 4：容器形态的老路不能被改坏 ───────────────────────────────
  // 同一台机器上恰好有个同名容器时，容器形态**不得**去读宿主机进程——
  // 读到的是别的进程的旋钮，读起来毫无异样。
  {
    const { child, port, dir } = await startFakeTarget({
      argv: ['--server.port=1', '--spring.datasource.dynamic.druid.max-wait=1'],
    });
    try {
      const r = runCli(
        port,
        { TARGET_CONTAINER: 'miniclaw-control-no-such-container' },
        { runtimeForm: 'container' },
      );
      check(
        '容器形态仍然走容器这条路',
        r.out.includes(
          'container_env: (unavailable: target is not a local container)',
        ),
        r.out.slice(0, 800),
      );
      check(
        '容器形态不去读宿主机进程的 argv（近邻负对照）',
        !r.out.includes('process_argv:') &&
          !r.out.includes('--spring.datasource.dynamic.druid.max-wait=1'),
        r.out.slice(0, 800),
      );
    } finally {
      child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // ── 对照 5：management 命名空间的旋钮也要看得见 ────────────────────
  // Spring Boot 的 management 命名空间里放的就是运维旋钮（健康检查阈值、
  // 端点暴露范围）。白名单漏了它，「健康检查被谁改坏了」在通道上就是瞎的。
  {
    const { child, port, dir } = await startFakeTarget({
      argv: ['--server.port=1'],
      env: {
        MANAGEMENT_HEALTH_DISKSPACE_THRESHOLD: '50GB',
        MANAGEMENT_SECURITY_TOKEN: 'should-never-be-printed',
        HEALTHCHECK_DISKSPACE_THRESHOLD: 'should-never-be-printed',
      },
    });
    try {
      const r = runCli(port);
      check(
        'management 命名空间里的旋钮原样打出来',
        r.out.includes('MANAGEMENT_HEALTH_DISKSPACE_THRESHOLD=50GB'),
        r.out.slice(0, 800),
      );
      check(
        'management 命名空间里的凭据照样遮掉（近邻负对照）',
        !r.out.includes('should-never-be-printed') &&
          r.out.includes('MANAGEMENT_SECURITY_TOKEN=<redacted>'),
        r.out.slice(0, 800),
      );
      check(
        '前缀不匹配的同名旋钮不进这条通道',
        !r.out.includes('HEALTHCHECK_DISKSPACE_THRESHOLD'),
        r.out.slice(0, 800),
      );
    } finally {
      child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log(`\n${pass} 通过 / ${fail} 失败`);
  if (fail) process.exit(1);
}

main().catch((err) => {
  console.error(`✗ 对照中断：${err.message}`);
  process.exit(1);
});
