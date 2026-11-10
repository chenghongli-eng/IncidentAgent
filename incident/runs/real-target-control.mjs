#!/usr/bin/env node
/**
 * 真实靶子启停机制（incident/runs/real-target.mjs）的对照。
 *
 * 这一段机制直接决定真实轮次「基线态 / 故障态」是不是真的到位了，
 * 所以它必须自己站得住：机制错了，后面整轮都在错的台子上跑，而且不报错。
 *
 * 四组对照：
 *   1. 正对照：靶子起来并且应答 200 → 就绪；额外环境变量确实传到了子进程。
 *   2. 近邻正对照：**同样形态**、只是健康端点返 503 → 也算就绪。
 *      这一条防的是「就绪 = 必须是 200」这种写法：故障态本身就是 503，
 *      写死 200 的话，注入之后永远等不到，轮次会卡在超时上。
 *   3. 负对照：靶子根本不应答 → 就绪判定必须**超时并返回失败**，
 *      而不是永远挂着，更不是把「没应答」当成就绪。
 *   4. 负对照：停靶子**只停监听进程**——同机另一个端口上的进程必须还活着。
 *      这一条防的是宽泛 kill（pkill -f 之类）：靶子旁边还有别的进程，
 *      停错一次就是别人的服务没了。
 */
import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadSpec,
  startTarget,
  stopTarget,
  waitReady,
  listenPid,
} from './real-target.mjs';

/** 这一轮对照起过的子进程：结束时全部收掉，不给系统留孤儿。 */
const spawned = [];
function start(spec, opts) {
  const r = startTarget(spec, opts);
  spawned.push(r.child);
  return r;
}
function cleanup() {
  for (const c of spawned) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* 已经不在了 */
    }
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));

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
 * 造一个假的靶子：一个 bash 启动脚本 + 一个 node 服务。
 *
 * 用真脚本 + 真进程，不用假的 /proc：被测的是「起进程 → 等它应答 → 只停它」，
 * 造假的 /proc 就得把定位逻辑一起造，测的就不是线上那条路了。
 */
function makeFakeTarget({ mode = 'ok', port }) {
  const dir = mkdtempSync(join(tmpdir(), 'real-target-control-'));
  const server = join(dir, 'fake.mjs');
  writeFileSync(
    server,
    `import { createServer } from 'node:http';\n` +
      `import { writeFileSync } from 'node:fs';\n` +
      `const mode = process.argv[2];\n` +
      `const port = Number(process.argv[3]);\n` +
      `if (mode === 'dead') { process.stdout.write('never listening\\n'); setInterval(() => {}, 1000); }\n` +
      `else {\n` +
      `  const server = createServer((req, res) => {\n` +
      `    if (req.url.startsWith('/actuator/health')) {\n` +
      `      const code = mode === 'bad' ? 503 : 200;\n` +
      `      res.writeHead(code, {'content-type':'application/json'});\n` +
      `      res.end(JSON.stringify({status: code === 200 ? 'UP' : 'DOWN'}));\n` +
      `      return;\n` +
      `    }\n` +
      `    res.writeHead(200); res.end('ok');\n` +
      `  });\n` +
      `  server.listen(port, '127.0.0.1', () => process.stdout.write('listening\\n'));\n` +
      `}\n` +
      `writeFileSync(process.env.CONTROL_MARKER ?? '/dev/null', String(process.env.CONTROL_KNOB ?? 'unset'));\n`,
  );
  const launcher = join(dir, 'launch.sh');
  writeFileSync(
    launcher,
    `#!/usr/bin/env bash\nexec ${process.execPath} ${server} ${mode} ${port}\n`,
  );
  return { dir, launcher };
}

function makeSpec(launcher, port, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'real-target-spec-'));
  const file = join(dir, 'launch-spec.json');
  writeFileSync(
    file,
    JSON.stringify({
      launcher,
      port,
      healthPath: '/actuator/health',
      runDir: dir,
      ...extra,
    }),
  );
  return loadSpec(file);
}

async function main() {
  console.log('真实靶子启停机制对照：');

  // ── 对照 1：正对照（起来 + 应答 + 环境变量到位）──────────────────
  {
    const port = 34101;
    const { dir, launcher } = makeFakeTarget({ mode: 'ok', port });
    const marker = join(dir, 'knob.txt');
    const spec = makeSpec(launcher, port);
    try {
      start(spec, { env: { CONTROL_KNOB: 'FAULT', CONTROL_MARKER: marker } });
      const ready = await waitReady(spec, {
        expectedStatus: 200,
        timeoutMs: 20000,
      });
      check('靶子应答 200 时判定为就绪', ready.ready, JSON.stringify(ready));
      check(
        '额外环境变量确实传到了子进程',
        existsSync(marker) && readFileSync(marker, 'utf8') === 'FAULT',
        existsSync(marker) ? readFileSync(marker, 'utf8') : '(没写出来)',
      );
      check(
        '端口上能定位到监听进程',
        listenPid(port) !== null,
        String(listenPid(port)),
      );
      const stopped = await stopTarget(spec);
      check('停靶子成功', stopped.stopped, JSON.stringify(stopped));
      check(
        '停完之后端口上没有监听进程了',
        listenPid(port) === null,
        String(listenPid(port)),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // ── 对照 2：近邻正对照（形态一样，只是 503）───────────────────────
  {
    const port = 34102;
    const { dir, launcher } = makeFakeTarget({ mode: 'bad', port });
    const spec = makeSpec(launcher, port);
    try {
      start(spec, {});
      const ready = await waitReady(spec, {
        expectedStatus: 503,
        timeoutMs: 20000,
      });
      check(
        '健康端点返 503 也算就绪（故障态不是「起不来」）',
        ready.ready,
        JSON.stringify(ready),
      );
      await stopTarget(spec);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // ── 对照 3：负对照（根本不应答）────────────────────────────────
  {
    const port = 34103;
    const { dir, launcher } = makeFakeTarget({ mode: 'dead', port });
    const spec = makeSpec(launcher, port);
    try {
      start(spec, {});
      const started = Date.now();
      const ready = await waitReady(spec, {
        expectedStatus: 200,
        timeoutMs: 6000,
      });
      const waited = Date.now() - started;
      check(
        '靶子不应答时就绪判定必须失败',
        ready.ready === false,
        JSON.stringify(ready),
      );
      check(
        '就绪判定会超时返回，不会一直挂着',
        waited >= 5000 && waited < 30000,
        `等了 ${waited}ms`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // ── 对照 4：负对照（只停监听进程）──────────────────────────────
  {
    const port = 34104;
    const otherPort = 34105;
    const { dir, launcher } = makeFakeTarget({ mode: 'ok', port });
    const other = makeFakeTarget({ mode: 'ok', port: otherPort });
    const spec = makeSpec(launcher, port);
    try {
      start(spec, {});
      start(makeSpec(other.launcher, otherPort), {});
      await waitReady(spec, { expectedStatus: 200, timeoutMs: 20000 });
      await waitReady(makeSpec(other.launcher, otherPort), {
        expectedStatus: 200,
        timeoutMs: 20000,
      });
      const stopped = await stopTarget(spec);
      check('靶子已停', stopped.stopped, JSON.stringify(stopped));
      check(
        '同机另一个端口上的进程还活着（没有宽泛 kill）',
        listenPid(otherPort) !== null,
        `other pid=${listenPid(otherPort)}`,
      );
      await stopTarget(makeSpec(other.launcher, otherPort));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(other.dir, { recursive: true, force: true });
    }
  }

  console.log(`\n${pass} 通过 / ${fail} 失败`);
  if (fail) process.exit(1);
}

main()
  .catch((err) => {
    console.error(`✗ 对照中断：${err.message}`);
    process.exitCode = 1;
  })
  .finally(cleanup);
