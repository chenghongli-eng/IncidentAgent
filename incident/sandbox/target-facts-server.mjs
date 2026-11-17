#!/usr/bin/env node
// Read-only target facts service for the sandboxed IncidentAgent.
//
// ── 为什么存在 ───────────────────────────────────────────────────────────────
//
// 沙箱里没有 docker socket（给了 socket 就等于给了宿主机 root：`docker run -v /:/mnt`
// 能把整个文件系统读出来，沙箱当场作废）。但 `incident-readonly.mjs` 的两个合法通道
// 依赖 docker：
//
//   · `runtime env`    → docker inspect <容器> '{{range .Config.Env}}…'
//   · `runtime started`→ docker inspect <容器> '{{.State.StartedAt}}'
//
// 也就是说：**不能靠删通道来换安全**。正确做法是把这一个能力从"整个 docker API"
// 缩成"读靶子容器的两件事"，并且由沙箱外面的人代答。
//
// 于是有了这个服务：它跑在沙箱**外面**（有 docker 权限），通过一个 unix socket
// 回答两个问题，仅此而已。沙箱里的 `docker` 是一个 shim（见 bin/docker），它把
// `docker inspect <容器> --format <格式>` 转成 socket 请求。
//
// 放行规则（incident/sandbox/policy.json）：
//   · 容器名必须在 allowedContainers 里；
//   · --format 必须是 allowedInspectFormats 里的字面量之一；
//   · 其余子命令、其余格式一律拒绝——这个服务不是 docker 代理。
//
// ── 协议 ─────────────────────────────────────────────────────────────────────
//
// 一行一个 JSON：请求 `{"op":"inspect","container":"…","format":"…"}`，
// 响应 `{"ok":true,"value":"…"}` 或 `{"ok":false,"error":"…"}`。
//
// 用法：
//   node incident/sandbox/target-facts-server.mjs            # 前台运行
//   node incident/sandbox/target-facts-server.mjs --check    # 只自检（不发请求）

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLICY_PATH = path.join(HERE, 'policy.json');

function die(msg) {
  console.error(`target-facts-server: ${msg}`);
  process.exit(1);
}

function loadPolicy() {
  if (!existsSync(POLICY_PATH)) die(`policy not found: ${POLICY_PATH}`);
  return JSON.parse(readFileSync(POLICY_PATH, 'utf8'));
}

const policy = loadPolicy();
const ALLOWED_CONTAINERS = new Set(policy.allowedContainers ?? []);
const ALLOWED_FORMATS = new Set(policy.allowedInspectFormats ?? []);

/**
 * 真正的 docker inspect 调用。这个进程在沙箱之外，它有 docker 权限。
 * 只走 --format，不取整份 JSON：整份 inspect 里还有别的容器的信息。
 */
function dockerInspect(container, format) {
  return execFileSync('docker', ['inspect', container, '--format', format], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function handleRequest(request) {
  if (!request || typeof request !== 'object') {
    return { ok: false, error: 'malformed request' };
  }
  if (request.op !== 'inspect') {
    return { ok: false, error: `unsupported op: ${String(request.op)}` };
  }
  const container = String(request.container ?? '');
  const format = String(request.format ?? '');
  if (!ALLOWED_CONTAINERS.has(container)) {
    return { ok: false, error: `container not allowed: ${container}` };
  }
  if (!ALLOWED_FORMATS.has(format)) {
    return { ok: false, error: 'inspect format not allowed' };
  }
  try {
    return { ok: true, value: dockerInspect(container, format) };
  } catch (err) {
    return {
      ok: false,
      error: `docker inspect failed: ${String(err.stderr ?? err.message).trim()}`,
    };
  }
}

function log(line) {
  const stamp = new Date().toISOString();
  try {
    appendFileSync(policy.logFile, `${stamp} ${line}\n`);
  } catch {
    // 日志写不进去不该拖垮服务
  }
}

function serve(socketPath) {
  mkdirSync(path.dirname(socketPath), { recursive: true });
  // 旧 socket 文件会让 listen 失败。先删，但只删我们自己这个路径。
  if (existsSync(socketPath)) rmSync(socketPath, { force: true });

  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let response;
      try {
        response = handleRequest(JSON.parse(line));
      } catch (err) {
        response = { ok: false, error: `bad request: ${err.message}` };
      }
      log(`${response.ok ? 'ok' : 'refused'} ${line.slice(0, 200)}`);
      socket.end(`${JSON.stringify(response)}\n`);
    });
    socket.on('error', () => {
      /* 客户端断开不算错误 */
    });
  });

  server.on('error', (err) => die(`server error: ${err.message}`));
  server.listen(socketPath, () => {
    log(`listening on ${socketPath}`);
    console.log(`target-facts-server listening on ${socketPath}`);
    if (process.send) process.send('ready');
  });

  const shutdown = () => {
    log('shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

function selfCheck() {
  const problems = [];
  for (const container of ALLOWED_CONTAINERS) {
    try {
      const startedAt = dockerInspect(container, '{{.State.StartedAt}}').trim();
      if (!startedAt) problems.push(`${container}: empty StartedAt`);
      else console.log(`ok  ${container} startedAt=${startedAt}`);
    } catch (err) {
      problems.push(
        `${container}: ${String(err.stderr ?? err.message).trim()}`,
      );
    }
  }
  if (problems.length > 0) {
    console.error('target-facts-server self-check failed:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log('target-facts-server self-check passed');
}

const argv = process.argv.slice(2);
if (argv.includes('--check')) {
  selfCheck();
} else {
  serve(policy.factsSocket);
}
