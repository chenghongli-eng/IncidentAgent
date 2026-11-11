/**
 * 真实靶子（宿主机进程形态）的启停与就绪判定。
 *
 * 为什么单独一个模块：轮次编排（run-round.mjs）要做的两件事——
 * 「把靶子按基线拉起来」「把靶子按故障态拉起来」——在合成夹具那边是
 * `lab.sh recreate`，在真实靶子这边是「按一份启动规格起进程」。
 * 规格本身（制品路径、启动脚本、故障旋钮）**在仓库外**：
 * 它就是这一轮的答案键的一半，仓库是公开的，不能把它带进去。
 *
 * 三条硬规矩：
 *
 * 1. **只杀监听进程。** 停靶子用 `lsof -ti:<port> -sTCP:LISTEN` 定位到
 *    那个 pid，然后只对它发信号。绝不用 `pkill -f`——那会连别的进程一起带走。
 * 2. **故障旋钮走环境变量，不走命令行。** 进程环境不进 argv，
 *    也就不会出现在 `ps` 输出、日志和 transcript 里；而 `runtime env`
 *    这条通道读的就是进程环境——旋钮在那儿等着被看见。
 * 3. **凭据不经过这里。** 加密密钥由启动脚本自己从项目自己的 Dockerfile 读出
 *    并导出进子进程环境；本模块既不读也不打印它。
 */
import { spawn, execFileSync } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  readFileSync,
  mkdirSync,
  openSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 读启动规格。规格在仓库外——找不到就报错，不静默回退到默认值。 */
export function loadSpec(path) {
  if (!path) throw new Error('没有给启动规格路径（launchSpec）');
  if (!existsSync(path)) {
    throw new Error(`启动规格不存在：${path}`);
  }
  const spec = JSON.parse(readFileSync(path, 'utf8'));
  /**
   * 分相规格：每一相有自己的启动脚本、制品目录、运行目录。
   *
   * 为什么需要：运行时旋钮那一轮，基线态和故障态跑的是**同一个制品**，
   * 差别只在进程环境里——一份扁平规格就够。发布类故障不一样：基线跑的是
   * 上一个版本的制品，故障跑的是这一轮刚打出来的新制品，**是两个目录、
   * 两个启动脚本**。一份扁平的规格表达不了这个差别。
   *
   * 顶层 launcher 取基线相：轮次编排开跑、摆基线时用的就是基线相，
   * 故障相由轮次编排切过去。
   */
  if (spec.phases) {
    for (const [name, phase] of Object.entries(spec.phases)) {
      if (!phase?.launcher) {
        throw new Error(`启动规格的 ${name} 相缺字段 launcher：${path}`);
      }
    }
    if (!spec.phases.baseline) {
      throw new Error(`分相启动规格缺 baseline 相：${path}`);
    }
    spec.launcher = spec.launcher ?? spec.phases.baseline.launcher;
    spec.artifactDir = spec.artifactDir ?? spec.phases.baseline.artifactDir;
    spec.runDir = spec.runDir ?? spec.phases.baseline.runDir;
  }
  for (const key of ['launcher', 'port', 'healthPath']) {
    if (!spec[key]) throw new Error(`启动规格缺字段 ${key}：${path}`);
  }
  spec.__file = path;
  return spec;
}

/** 端口上的监听进程 pid。没有就 null。 */
export function listenPid(port) {
  try {
    const out = execFileSync('lsof', [`-ti:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pid = out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)[0];
    return pid ? Number(pid) : null;
  } catch {
    return null;
  }
}

/** 靶子的健康端点返回什么状态码。不可达返回 null。 */
export async function healthStatus(spec, timeoutMs = 5000) {
  const url = `http://127.0.0.1:${spec.port}${spec.healthPath}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    return res.status;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 等靶子「应答」。
 *
 * expectedStatus 缺省表示「只要应答就算就绪」；给了就要求状态码等于它。
 * 故障态（503）也是就绪的一种——所以就绪判定不能写成「必须是 200」，
 * 否则注入之后永远等不到。
 */
export async function waitReady(
  spec,
  { expectedStatus = null, timeoutMs = 180000 } = {},
) {
  const until = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < until) {
    last = await healthStatus(spec);
    if (last !== null && (expectedStatus === null || last === expectedStatus)) {
      return { ready: true, status: last };
    }
    await sleep(2000);
  }
  return {
    ready: false,
    status: last,
    why: `等 ${timeoutMs}ms 没等到状态码 ${expectedStatus ?? '(任意)'}`,
  };
}

/**
 * 停掉靶子。只停端口上的那个监听进程。
 *
 * 先 SIGTERM 让它自己收尾（Spring Boot 有优雅停机钩子），等一会儿还在就
 * SIGKILL 那个 pid。**只对这一个 pid 发信号**。
 */
export async function stopTarget(spec, { timeoutMs = 60000 } = {}) {
  const pid = listenPid(spec.port);
  if (!pid) return { stopped: false, why: '端口上本来就没有监听进程' };
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    return { stopped: false, why: `SIGTERM 失败：${err.message}` };
  }
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (!listenPid(spec.port)) return { stopped: true, pid, signal: 'SIGTERM' };
    await sleep(1000);
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch (err) {
    return { stopped: false, pid, why: `SIGKILL 失败：${err.message}` };
  }
  const hard = Date.now() + 15000;
  while (Date.now() < hard) {
    if (!listenPid(spec.port)) return { stopped: true, pid, signal: 'SIGKILL' };
    await sleep(500);
  }
  return { stopped: false, pid, why: 'SIGKILL 之后端口仍在监听' };
}

/**
 * 按规格把靶子拉起来。
 *
 * env 是**额外**的环境变量（基线为空、故障态带那一个旋钮）。
 * 值为 null 的键表示「从环境里**去掉**这个变量」——基线态必须这样把故障旋钮
 * 显式抹掉，而不是「希望编排脚本自己的环境里没有它」：上一次手工起靶子时
 * 导出过这个变量的话，它就还在进程环境里，基线态会带着故障旋钮跑起来，
 * 而报告会把一个**根本没注入**的故障说成真故障。
 * 启动脚本自己 exec 成 java 进程，所以子进程就是靶子本身。
 */
export function startTarget(spec, { env = {}, logName = 'launch.log' } = {}) {
  if (!existsSync(spec.launcher)) {
    throw new Error(`启动脚本不存在：${spec.launcher}`);
  }
  const runDir = spec.runDir ?? dirname(spec.launcher);
  mkdirSync(runDir, { recursive: true });
  const logFile = join(runDir, logName);
  const childEnv = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === null || value === undefined) delete childEnv[key];
    else childEnv[key] = value;
  }
  // 用 fd 而不是 WriteStream：spawn 的 stdio 只接受数字 fd 或内置的三种值，
  // 传流对象会直接被拒。
  const fd = openSync(logFile, 'a');
  const child = spawn('bash', [spec.launcher], {
    env: childEnv,
    stdio: ['ignore', fd, fd],
  });
  child.on('error', () => {});
  // 不让靶子进程把编排脚本的进程树吊住：编排脚本退出时靶子要继续活着
  // （它是被独立管理的实验对象，不是编排脚本的附属品）。
  child.unref();
  return { child, logFile };
}
