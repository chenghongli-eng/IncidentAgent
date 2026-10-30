#!/usr/bin/env node
/**
 * 跑一轮诊断实验：摆静默态 → 清 Agent 可读面 → 注入故障 → 等告警 → 跑 Agent → 审计 → 打分 → 恢复。
 *
 * 为什么要写成脚本而不是一串手敲命令：
 *   这一轮实验的结论要能被别人复现。手敲命令时，「开跑前检查了什么」「哪一步失败了」
 *   散在终端历史里，指标表里那个数字就没有证据链。脚本把每一步的**实际输出**
 *   落到 round-manifest-<ts>.json 里，数字和证据表就对得上了。
 *
 * 两类故障的机制不同，所以「静默态」和「注入」也必须不同：
 *
 *   F4（运行时旋钮）  静默态 = 缺陷在线但没人踩它（order 2 不在压测路径里）
 *                     注入   = 只把超时旋钮 2000 → 1，重建容器
 *                     代码一行没动 → 发布必然不是触发源
 *
 *   F2（代码变更）    静默态 = 判空兜底在代码里（缺陷没上线）、order 2 一直在压测路径里
 *                     注入   = 提交一次改动把判空兜底删掉，重建容器
 *                     配置一行没动 → 发布就是触发源
 *
 * 关键约束：**一轮只动一个维度**。F2 那一轮如果靠「把 order 2 放回压测路径」来触发故障，
 * Agent 完全可以合理地把触发源归到配置上——那一轮测的就不是发布归因了。
 *
 * 静默态必须**坐稳**（settle）到 15 分钟窗口之外：
 *   窗口 = [故障前 15 分钟, 故障时刻]。F2 的静默态要换代码（提交 + 重建 + 改压测路径），
 *   这三件事各自都是一次「变更」。它们若落在窗口里，Agent 会看到窗口内既有代码变更
 *   又有配置变更（压测路径），那一轮测的就变成「Agent 能不能在两个变更里挑对」，
 *   而不是「Agent 会不会误归因到发布」。所以静默态摆完要等它滑出窗口再注入。
 *   F4 不需要等：它的触发源就是那一次容器重建本身。
 *
 * 刻意不做的事：
 *   - 不在注入故障后「顺手」改任何别的东西。
 *   - 不把「检查项跳过了」当成「检查项通过」。每个检查项要么有实测输出，要么整轮中止。
 *   - 不替 Agent 擦屁股。恢复实验台是恢复实验台，不能顺手把 Agent 的报告改好。
 *   - 不把「打分器没跑出来」当成「Agent 答错」。打分在恢复之前做，恢复失败不该吞掉分数。
 *
 * 用法：
 *   node incident/runs/run-round.mjs --fault F4
 *   node incident/runs/run-round.mjs --fault F4 --dry-run        # 只跑前置闸门
 *   node incident/runs/run-round.mjs --fault F4 --no-restore     # 故障态留在台子上（排查用）
 *   node incident/runs/run-round.mjs --fault F2 --settle-ms 960000
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { scoreReport } = await import(new URL('./score-report.mjs', import.meta.url).href);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LAB = join(ROOT, 'incident');
const RUNS = join(LAB, 'runs');
const LAB_ENV = process.env.LAB_ENV ?? join(homedir(), '.config/miniclaw-lab/lab.env');
// 用绝对路径：这几步的 cwd 是 incident/，相对路径会拼成 incident/incident/...
const FAULTS_MJS = join(ROOT, 'incident/faults/faults.mjs');
const WORKSPACE = join(LAB, 'workspace');
const WS_JID = 'web:8ff36e4b-e8da-4dfd-be0a-b55d70fd9edb';
const TARGET = 'http://127.0.0.1:8080';
const PROM = 'http://127.0.0.1:9090';
const MINICLAW = 'http://127.0.0.1:3000';
const RATIO_QUERY =
  'sum(rate(http_server_requests_seconds_count{application="target-service",status=~"5.."}[1m]))'
  + '/clamp_min(sum(rate(http_server_requests_seconds_count{application="target-service"}[1m])),0.001)';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i === -1 ? dflt : args[i + 1];
};

const FAULT = opt('--fault', 'F4');
const DRY_RUN = flag('--dry-run');
const NO_RESTORE = flag('--no-restore');
/**
 * Agent 单轮上限。上限是安全网，不是节奏控制：F2 轮的 Agent 跑过 15 分 10 秒，
 * 而旧的 15 分钟 cap 会让 runner 在报告送达前 10 秒断开（0703Z 那一轮就废在这）。
 */
const CAP_MS = Number(opt('--cap-ms', 1800000));
/** 静默态要坐稳多久（毫秒）。默认 16 分钟：比 15 分钟窗口多留 1 分钟余量。 */
const SETTLE_MS = Number(opt('--settle-ms', 16 * 60 * 1000));

const now = new Date();
const STAMP = `${now.toISOString().slice(0, 10)}T${now.toISOString().slice(11, 16).replace(':', '')}Z`;
const REPORT_PATH = join(RUNS, `agent-report-${STAMP}.md`);
const SCORE_PATH = join(RUNS, `score-${STAMP}.json`);
const MANIFEST_PATH = join(RUNS, `round-manifest-${STAMP}.json`);

const log = (...a) => console.log(...a);
const section = (t) => log(`\n── ${t} ${'─'.repeat(Math.max(0, 60 - t.length))}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// bash -c 而不是 bash -lc：登录 shell 会把 PATH 换成 /usr/bin/node (v20)，
// 而 better-sqlite3 是按当前 Node (v22) 编的，一 require 就 NODE_MODULE_VERSION 不匹配。
// 脚本里的 node 调用一律用 process.execPath，不靠 PATH。
function sh(cmd, { cwd = ROOT, timeout = 180000 } = {}) {
  const r = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', timeout });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

const NODE = process.execPath;

function mustSh(cmd, opts) {
  const r = sh(cmd, opts);
  if (r.code !== 0) throw new Error(`命令失败 (exit ${r.code}): ${cmd}\n${r.err || r.out}`);
  return r;
}

let cookie = null;

// 中止路径也要能恢复实验台。之前 fail() 直接抛出，第 9 步不执行，
// 台子就停在故障态（0446Z 那一轮就是这样：429 中止后 order 2 一直 500、告警一直 firing）。
let activeSpec = null;
let injected = false;
let restoreDone = false;

/**
 * 带重试的 fetch。
 *
 * 为什么要有：2026-10-30 那一轮在恢复阶段挂在 `fetch failed` 上——
 * 报告已经写完、打分却被整个跳过，一轮白跑。容器刚重建时本机回环端口会短暂
 * 拒绝连接，那不是「台子坏了」，是抖动。
 */
async function fetchRetry(url, opts = {}, tries = 4) {
  let last = null;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fetch(url, opts);
    } catch (err) {
      last = err;
      if (i < tries) await sleep(1000 * i);
    }
  }
  const cause = last?.cause?.message ? `（${last.cause.message}）` : '';
  throw new Error(`请求 ${url} 连续 ${tries} 次失败：${last?.message}${cause}`);
}

async function json(url, { withCookie = false } = {}) {
  const res = await fetchRetry(url, {
    headers: withCookie && cookie ? { Cookie: cookie } : undefined,
  });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return res.json();
}

const manifest = {
  stamp: STAMP,
  fault: FAULT,
  started_at: now.toISOString(),
  preflight: [],
  setup: null,
  settle: null,
  injection: null,
  alert: null,
  agent: null,
  channel_audit: null,
  restore: null,
  score: null,
  round_valid: true,
  invalid_reason: null,
  manifest_path: MANIFEST_PATH,
};

function record(id, ok, detail) {
  manifest.preflight.push({ id, ok, detail });
  log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} ${detail}`);
  return ok;
}

/**
 * 判本轮作废。
 *
 * 纪律是「审不过就不算这一轮的数」：分数照样记下来（要能复盘），
 * 但 manifest 标成无效，指标表不许收它。
 */
function invalidate(reason) {
  manifest.round_valid = false;
  manifest.invalid_reason = manifest.invalid_reason
    ? `${manifest.invalid_reason}；${reason}`
    : reason;
  log(`  ⚠ 本轮作废：${reason}`);
}

function fail(msg) {
  throw new Error(msg);
}

// ── 旋钮文件 ──────────────────────────────────────────────────────────────
function readKnob() {
  return Object.fromEntries(
    readFileSync(LAB_ENV, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => {
        const i = l.indexOf('=');
        return i === -1 ? [l, ''] : [l.slice(0, i), l.slice(i + 1)];
      }),
  );
}

function setKnob(key, value) {
  const text = readFileSync(LAB_ENV, 'utf8');
  const re = new RegExp(`^${key}=.*$`, 'm');
  const next = re.test(text)
    ? text.replace(re, `${key}=${value}`)
    : `${text.trimEnd()}\n${key}=${value}\n`;
  writeFileSync(LAB_ENV, next);
}

// ── 观测 ──────────────────────────────────────────────────────────────────
/**
 * 读 5xx 比例。
 *
 * 分子序列不存在时整个表达式无值（result 为空）——那本身是「这段时间没有 500」的
 * 佐证，不是「读不到」。所以空结果按 0 算，别把它当成读失败。
 */
async function readRatio() {
  const r = await json(`${PROM}/api/v1/query?query=${encodeURIComponent(RATIO_QUERY)}`);
  const v = r.data?.result?.[0]?.value?.[1];
  return v === undefined ? 0 : Number(v);
}

async function waitHealthyBaseline(timeoutMs = 120000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await readRatio()) === 0) return true;
    await sleep(5000);
  }
  return false;
}

async function orderStatus(id) {
  const res = await fetchRetry(`${TARGET}/api/orders/${id}`);
  return res.status;
}

async function waitContainerHealthy(timeoutMs = 180000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const s = sh(`docker inspect target-service --format '{{.State.Health.Status}}'`);
    if (s.out.trim() === 'healthy') return true;
    await sleep(3000);
  }
  return false;
}

/** 容器启动时刻（部署锚点）。 */
function containerStartedAt() {
  const out = sh(`docker inspect target-service --format '{{.State.StartedAt}}'`).out.trim();
  const t = Date.parse(out);
  return Number.isNaN(t) ? null : t;
}

/** 重建容器并等它真的可用。 */
async function recreate() {
  mustSh('./lab.sh recreate target-service', { cwd: LAB });
  if (!(await waitContainerHealthy())) fail('target-service 重建后没有变 healthy。');
}

// ── 故障规格 ──────────────────────────────────────────────────────────────
const FAULTS = {
  /**
   * F4：触发源在运行时配置层。
   * 静默态 = 缺陷在线但没人踩它；注入 = 只改超时旋钮。
   */
  F4: {
    title: '下游读超时（运行时旋钮）',
    /** 静默态就是台子的常态：缺陷在线、order 2 不在压测路径、超时旋钮 2000。 */
    async setup() {
      const knob = readKnob();
      if (knob.DOWNSTREAM_TIMEOUT_MS !== '2000') {
        fail(`静默态要求 DOWNSTREAM_TIMEOUT_MS=2000，实际 ${knob.DOWNSTREAM_TIMEOUT_MS}`);
      }
      if ((knob.LOAD_PATHS ?? '').includes('/api/orders/2')) {
        fail('静默态要求 order 2 不在 LOAD_PATHS 里——它在的话缺陷会自己发作，那是 F2 的场景。');
      }
      return { note: '台子已在静默态：缺陷在线但 order 2 不在压测路径' };
    },
    /**
     * F4 不需要坐稳：这一轮的触发源就是容器重建本身，
     * 容器刚起来、旋钮刚改，正是 Agent 要看到的现场。
     */
    async settle() {
      return null;
    },
    async inject() {
      const knob = readKnob();
      setKnob('DOWNSTREAM_TIMEOUT_MS', '1');
      await recreate();
      return {
        knob: 'DOWNSTREAM_TIMEOUT_MS',
        from: knob.DOWNSTREAM_TIMEOUT_MS,
        to: '1',
        changed: ['运行时旋钮'],
        unchanged: ['代码', '压测路径', '数据'],
        note: '本轮只改运行时旋钮，代码一行没动',
      };
    },
    async restore() {
      setKnob('DOWNSTREAM_TIMEOUT_MS', '2000');
      await recreate();
      if (!(await waitHealthyBaseline())) fail('恢复后 5xx 比例没回到 0。实验台不干净，下一轮不能直接开跑。');
      return { knob: 'DOWNSTREAM_TIMEOUT_MS', to: '2000' };
    },
    /** 开跑前这条故障特有的不变量：窗口内没有任何代码变更。 */
    async checkWindow() {
      const head = mustSh(`git -C ${WORKSPACE} log -1 --format='%h %aI %s'`).out;
      const ageMin = (Date.now() - new Date(head.split(' ')[1]).getTime()) / 60000;
      if (ageMin < 15) {
        fail(
          `服务仓库 HEAD ${head} 只有 ${ageMin.toFixed(1)} 分钟前提交，落在 15 分钟窗口内。\n`
          + '这一轮测的就不是「Agent 会不会误归因到发布」，而是「Agent 会不会做时间对齐」。\n'
          + `等 ${Math.ceil(15 - ageMin)} 分钟让这次提交滑出窗口再开跑（或者先跑别的故障类型）。`,
        );
      }
      record('P8', true, `服务仓库 HEAD 在窗口外（${ageMin.toFixed(0)} 分钟前）：${head}`);
      return head;
    },
  },

  /**
   * F2：触发源就是那次发布。
   * 静默态 = 判空兜底在代码里（缺陷没上线）、order 2 一直在压测路径里；
   * 注入   = 提交一次改动把判空兜底删掉，然后重建容器。
   */
  F2: {
    title: 'NPE 引发 5xx（代码变更）',
    async setup() {
      const knob = readKnob();
      if (knob.DOWNSTREAM_TIMEOUT_MS !== '2000') {
        fail(`F2 那一轮运行时配置必须是干净基线，实际 DOWNSTREAM_TIMEOUT_MS=${knob.DOWNSTREAM_TIMEOUT_MS}。`
          + '配置也变了的话，这一轮测的是「两个变更里挑哪个」，不是发布归因。');
      }
      // 1. 把判空兜底加回去并提交——缺陷下线，代码回到基线
      const restore = sh(`${NODE} ${FAULTS_MJS} restore F2`, { cwd: LAB });
      if (restore.code !== 0) fail(`faults.mjs restore F2 失败：\n${restore.err || restore.out}`);
      // 2. order 2 放回压测路径（静默态就要一直压着它）
      //    放在重建之前：这样只需要一次容器启动，部署锚点才是干净的一个。
      setKnob('LOAD_PATHS', '/api/orders/1,/api/orders/2,/api/orders/3,/api/orders/4,/api/orders/5');
      // 3. 用基线代码重建镜像并部署
      mustSh('./lab.sh build target-service', { cwd: LAB, timeout: 900000 });
      if (!(await waitContainerHealthy())) fail('重建后 target-service 没有变 healthy。');

      const o2 = await orderStatus(2);
      if (o2 !== 200) {
        fail(`静默态要求 order 2 返回 200（基线代码降级成 UNKNOWN），实际 ${o2}。`
          + '基线没部署成功，这一轮测的就不是「一次发布把缺陷带上去」。');
      }
      return {
        source_restored: restore.out,
        load_paths: readKnob().LOAD_PATHS,
        note: '静默态：判空兜底在代码里（缺陷没上线），order 2 一直在压测路径里',
      };
    },
    /**
     * 静默态坐稳：等它滑出 15 分钟窗口再注入。
     *
     * 窗口里同时出现代码变更（恢复判空那次提交）和配置变更（压测路径）的话，
     * Agent 有理由把触发源归到配置上——那一轮就废了。要盯的两个时间点：
     *   · 旋钮文件的 mtime——`runtime env` 把它当作「配置最后一次变更」的证据
     *   · 容器启动时刻——Agent 把它当作部署锚点
     *
     * 两个时间点都要滑出窗口，所以取**较晚**的那个作基准：
     * 基准 = max(旋钮 mtime, 容器启动时刻) + 16min。
     * 取较早的那个会漏掉一种情况——重建比旋钮改动慢时，容器启动时刻会落在
     * 基准之后，算出来的等待不足，基线那次部署会卡在 15 分钟窗口里，
     * Agent 有理由怀疑「是不是还有一次更早的发布才是触发源」。
     */
    async settle() {
      const knobMtime = statSync(LAB_ENV).mtimeMs;
      const started = containerStartedAt();
      if (!started) fail('读不到容器启动时刻，坐不稳。');
      const newest = Math.max(knobMtime, started);
      const waitMs = SETTLE_MS - (Date.now() - newest);
      const detail = {
        knob_file_mtime: new Date(knobMtime).toISOString(),
        container_started_at: new Date(started).toISOString(),
        settle_ms: SETTLE_MS,
        settle_basis: new Date(newest).toISOString(),
      };
      if (waitMs <= 0) return { ...detail, waited_ms: 0 };
      log(`  静默态坐稳中：等 ${Math.ceil(waitMs / 1000)} 秒（到 ${new Date(newest + SETTLE_MS).toISOString()}）`);
      await sleep(waitMs);
      return { ...detail, waited_ms: Math.round(waitMs) };
    },
    async inject() {
      const inject = sh(`${NODE} ${FAULTS_MJS} inject F2`, { cwd: LAB });
      if (inject.code !== 0) fail(`faults.mjs inject F2 失败：\n${inject.err || inject.out}`);
      const commit = mustSh(`git -C ${WORKSPACE} log -1 --format='%h %aI %s'`).out;
      mustSh('./lab.sh build target-service', { cwd: LAB, timeout: 900000 });
      if (!(await waitContainerHealthy())) fail('重建后 target-service 没有变 healthy。');

      const o2 = await orderStatus(2);
      if (o2 !== 500) fail(`注入后 order 2 返回 ${o2}，不是 500。缺陷没上线。`);
      return {
        commit,
        changed: ['代码'],
        unchanged: ['运行时旋钮', '压测路径', '数据'],
        note: '一次提交把判空兜底删掉，重建容器后生效；压测路径全程没动',
      };
    },
    async restore() {
      // 恢复到公共静默态：缺陷在线（源码与镜像都是缺陷版）、order 2 退出压测路径
      setKnob('LOAD_PATHS', '/api/orders/1,/api/orders/3,/api/orders/4,/api/orders/5');
      await recreate();
      if (!(await waitHealthyBaseline())) fail('恢复后 5xx 比例没回到 0。实验台不干净，下一轮不能直接开跑。');
      return { load_paths: readKnob().LOAD_PATHS };
    },
    async checkWindow() {
      // F2 要求的是反过来的不变量：被发布的那个提交必须**在**窗口里，
      // 而那个提交在注入时才产生，所以这里只能校验「现在还没有代码变更」。
      const head = mustSh(`git -C ${WORKSPACE} log -1 --format='%h %aI %s'`).out;
      const ageMin = (Date.now() - new Date(head.split(' ')[1]).getTime()) / 60000;
      record('P8', true, `服务仓库 HEAD（${ageMin.toFixed(0)} 分钟前）：${head}`);
      return head;
    },
  },
};

async function main() {
  const spec = FAULTS[FAULT];
  if (!spec) fail(`还没实现的故障类型：${FAULT}。当前支持：${Object.keys(FAULTS).join(', ')}`);
  activeSpec = spec;

  // ───────────────────────────────────────────────────────────
  // 0. 前置闸门
  // ───────────────────────────────────────────────────────────
  section('前置闸门');

  if (!existsSync(LAB_ENV)) fail(`旋钮文件不存在：${LAB_ENV}`);

  const ps = mustSh(`docker ps --format '{{.Names}}\t{{.Status}}'`);
  const containers = Object.fromEntries(
    ps.out.split('\n').filter(Boolean).map((l) => {
      const [n, ...rest] = l.split('\t');
      return [n, rest.join('\t')];
    }),
  );
  for (const name of ['target-service', 'incident-prometheus', 'incident-alertmanager']) {
    if (!containers[name]) fail(`容器 ${name} 没在跑。开跑前先 incident/lab.sh up -d。`);
  }
  record('P1', true, `三个容器都在跑：${Object.keys(containers).join(', ')}`);

  const mounts = mustSh(
    `docker inspect target-service --format '{{range .Mounts}}{{.Source}}->{{.Destination}} {{end}}'`,
  );
  if (!mounts.out.includes(join(ROOT, 'incident'))) {
    fail(`target-service 的挂载源不在当前仓库路径下：${mounts.out}\n搬家后常见静默损坏，先按 RESUME.md 的验收清单修。`);
  }
  record('P2', true, `挂载源指向当前仓库：${mounts.out}`);

  // 日志文件必须真的在增长——容器 healthy 但日志文件不增长是搬家的静默损坏之一
  const appLog = join(WORKSPACE, 'logs/app.log');
  const stat1 = sh(`stat -c '%s' ${appLog}`);
  if (stat1.code !== 0) fail(`读不到 ${appLog}：${stat1.err}`);
  await sleep(3000);
  const size1 = Number(stat1.out);
  const size2 = Number(sh(`stat -c '%s' ${appLog}`).out);
  if (!(size2 > size1)) {
    fail(`app.log 3 秒内没有增长（${size1} → ${size2}）。容器 healthy 不代表日志通道活着——文件属主不对时容器会退回 stdout。`);
  }
  record('P3', true, `app.log 在增长（${size1} → ${size2} 字节）`);

  // 基线 5xx 比例必须为 0。**必须在下面那次 order2 探针之前测**——
  // 探针本身会产生一次 500，会把 1 分钟窗口的比例顶到 0.006。
  // 所以这里等一小会儿让窗口滚过去：上一轮/上一次 dry-run 留下的那一次 500
  // 会自然滚出窗口；而真实残留的故障态会让比例一直不降，等完就中止。
  const baselineRatio = await readRatio();
  if (baselineRatio !== 0) {
    log(`  基线 5xx 比例 ${baselineRatio}，等窗口滚出上一次探针的残留…`);
    if (!(await waitHealthyBaseline(90000))) {
      fail(`基线 5xx 比例 90 秒内没回到 0（当前 ${await readRatio()}）。上一轮故障态没清干净。`);
    }
  }
  record('P4', true, '基线 5xx 比例 = 0');

  const alerts0 = await json(`${PROM}/api/v1/alerts`);
  if (alerts0.data.alerts.some((a) => a.labels?.alertname === 'HighServerErrorRate')) {
    fail('开跑前 HighServerErrorRate 已经在 firing。实验台不干净，这一轮的结果不可用。');
  }
  record('P5', true, '开跑前没有告警在 firing');

  await spec.checkWindow();

  cookie = mustSh(`${NODE} incident/runs/mc-auth.mjs`).out;

  // 上一轮失败时服务端会「retry silently with backoff」同一条消息。
  // 开跑前先停掉它，否则它会在本轮期间插进来跑一个不受 runner 控制的 turn。
  try {
    const stop = await fetchRetry(`${MINICLAW}/api/groups/${encodeURIComponent(WS_JID)}/stop`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    log(`  已停止该工作区的残留队列（HTTP ${stop.status}）`);
  } catch (err) {
    log(`  ⚠ 停止残留队列失败（继续）：${err.message}`);
  }

  const groups = await json(`${MINICLAW}/api/groups`, { withCookie: true });

  // 记录本轮实际使用的 provider/模型。换模型会让不同轮次不可比，
  // manifest 必须带上，指标表才能说清楚「这个数字是哪个模型跑出来的」。
  const prov = await json(`${MINICLAW}/api/config/claude/providers`, { withCookie: true });
  const activeProvider = prov.providers?.find((p) => p.id === prov.defaultProviderId);
  if (!activeProvider) fail(`找不到当前默认 provider（${prov.defaultProviderId}）。`);
  manifest.provider = {
    defaultProviderId: prov.defaultProviderId,
    name: activeProvider.name ?? null,
    model: activeProvider.anthropicModel ?? null,
    enabledCount: prov.enabledCount ?? null,
  };
  record('P10', true, `provider=${activeProvider.name} model=${activeProvider.anthropicModel}`);

  const grp = groups?.groups?.[WS_JID];
  if (!grp) fail(`找不到工作区 ${WS_JID}，Agent 无处可跑。`);
  const expectCwd = WORKSPACE;
  if (grp.custom_cwd !== expectCwd) {
    fail(`工作区 custom_cwd=${grp.custom_cwd}，不是 ${expectCwd}。Agent 会拿到一个空壳目录。`);
  }
  record('P9', true, `工作区就位（custom_cwd=${grp.custom_cwd}，folder=${grp.folder}）`);

  if (DRY_RUN) {
    manifest.finished_at = new Date().toISOString();
    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
    log(`\n--dry-run：前置闸门全过，manifest 落在 ${MANIFEST_PATH}\n`);
    return;
  }

  // ───────────────────────────────────────────────────────────
  // 1. 摆静默态
  // ───────────────────────────────────────────────────────────
  section(`摆静默态（${FAULT}：${spec.title}）`);
  manifest.setup = await spec.setup();
  log(`  ${manifest.setup.note ?? '静默态就位'}`);

  // ───────────────────────────────────────────────────────────
  // 2. 清 Agent 可读面
  // ───────────────────────────────────────────────────────────
  section('清 Agent 可读面');

  // 聊天历史不是扫描面，必须显式清。clear-history 会连带清掉工作区记忆与
  // data/sessions 下的 Skill 副本，所以后面三步是重跑，不是首跑。
  const clear = await fetchRetry(`${MINICLAW}/api/groups/${encodeURIComponent(WS_JID)}/clear-history`, {
    method: 'POST',
    headers: { Cookie: cookie },
  });
  if (!clear.ok) fail(`clear-history 返回 ${clear.status}：${await clear.text()}`);
  log('  聊天历史已清（连带工作区记忆与 session 目录）');

  mustSh(`${NODE} incident/runs/memory-de-leak.mjs`);
  mustSh(`${NODE} incident/runs/sync-skills.mjs`);
  mustSh(`${NODE} incident/runs/sync-agent-profile.mjs`);

  const scan = sh(`${NODE} incident/runs/leak-scan.mjs`);
  if (scan.code !== 0) fail(`泄漏扫描没过（exit ${scan.code}）：\n${scan.out}\n${scan.err}`);
  log('  泄漏扫描：0 命中');

  // ───────────────────────────────────────────────────────────
  // 3. 静默态坐稳（滑出 15 分钟窗口）
  // ───────────────────────────────────────────────────────────
  section('静默态坐稳');
  manifest.settle = (await spec.settle()) ?? { skipped: true };
  if (manifest.settle.skipped) {
    log('  本轮不需要坐稳（触发源就是那一次容器重建）');
  } else {
    log(`  已坐稳（等 ${Math.round((manifest.settle.waited_ms ?? 0) / 1000)} 秒）`);
  }

  // ───────────────────────────────────────────────────────────
  // 4. 注入故障
  // ───────────────────────────────────────────────────────────
  section('注入故障');

  const injectedAt = new Date().toISOString();
  manifest.injection = { fault: FAULT, at: injectedAt, ...(await spec.inject()) };
  injected = true;
  log(`  已注入：${manifest.injection.changed.join('、')}（${manifest.injection.changed.length} 个维度）`);

  // ───────────────────────────────────────────────────────────
  // 5. 等告警 firing
  // ───────────────────────────────────────────────────────────
  section('等告警 firing');

  let fired = null;
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    const a = await json(`${PROM}/api/v1/alerts`);
    const hit = a.data.alerts.find(
      (x) => x.labels?.alertname === 'HighServerErrorRate' && x.state === 'firing',
    );
    if (hit) {
      fired = hit;
      break;
    }
    await sleep(5000);
  }
  if (!fired) {
    fail('300 秒内 HighServerErrorRate 没有 firing。故障可能没注入成功，别在没故障的台子上跑 Agent。');
  }
  manifest.alert = {
    alertname: fired.labels.alertname,
    state: fired.state,
    activeAt: fired.activeAt,
    value: fired.value,
    observed_at: new Date().toISOString(),
  };
  log(`  告警 firing：activeAt=${fired.activeAt} value=${fired.value}`);

  // ───────────────────────────────────────────────────────────
  // 6. 跑 Agent
  // ───────────────────────────────────────────────────────────
  section('跑 Agent');

  writeFileSync('/tmp/mc-cookie.txt', cookie);
  const agentStart = new Date().toISOString();
  const ws = spawnSync(
    NODE,
    ['incident/runs/ws-run.mjs', WS_JID, 'incident/runs/diag-prompt.txt', String(CAP_MS)],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: CAP_MS + 180000 },
  );
  if (!ws.stdout || !ws.stdout.trim()) {
    // spawnSync 的字段是 stderr，不是 err。之前写成 ws.err，报错只剩一个
    // 「undefined」，把真正的失败原因（例如 provider 429）吞掉了。
    const why = [ws.stderr, ws.error?.message, ws.signal ? `signal=${ws.signal}` : '']
      .filter(Boolean)
      .join('\n');
    fail(`Agent 没有产出任何文本（exit ${ws.status}）：\n${why || '（ws-run 没有输出，也没有 stderr）'}`);
  }
  writeFileSync(REPORT_PATH, ws.stdout);
  manifest.agent = {
    report: REPORT_PATH,
    started_at: agentStart,
    finished_at: new Date().toISOString(),
    chars: ws.stdout.length,
    stderr_tail: (ws.stderr || '').split('\n').slice(-8).join('\n'),
  };
  log(`  报告已存：${REPORT_PATH}（${ws.stdout.length} 字）`);

  // 收会话 transcript，供逐条审
  const sessionDir = join(ROOT, 'data/sessions');
  let transcript = null;
  if (existsSync(sessionDir)) {
    for (const dir of readdirSync(sessionDir)) {
      const cand = join(sessionDir, dir, '.claude/sessions');
      if (!existsSync(cand)) continue;
      for (const f of readdirSync(cand)) {
        if (!f.endsWith('.jsonl')) continue;
        const p = join(cand, f);
        if (statSync(p).mtimeMs < new Date(agentStart).getTime()) continue;
        if (!transcript || statSync(p).mtimeMs > statSync(transcript).mtimeMs) transcript = p;
      }
    }
  }
  if (transcript) {
    const dest = join(RUNS, 'session-transcripts', transcript.split('/').pop());
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(transcript, dest);
    manifest.agent.transcript = dest;
    log(`  transcript 已收：${dest}`);
  }

  // ───────────────────────────────────────────────────────────
  // 7. 通道合规审计
  // ───────────────────────────────────────────────────────────
  // 顺序在打分之前：审计不过就不算这一轮的数。
  section('通道合规审计');

  if (!transcript) {
    manifest.channel_audit = {
      verdict: 'not_run',
      why: '没找到会话 transcript——审计没跑。扫不到的面等于没扫。',
    };
    invalidate('通道审计没跑（没有 transcript）');
    log('  审计没跑：没找到 transcript');
  } else {
    const audit = sh(`${NODE} incident/runs/channel-audit.mjs ${transcript} --json`);
    try {
      manifest.channel_audit = JSON.parse(audit.out);
    } catch {
      manifest.channel_audit = { verdict: 'not_run', why: audit.err || audit.out || '审计脚本没产出可解析的结果' };
    }
    const ca = manifest.channel_audit;
    log(`  判定：${ca.verdict}（污染 ${ca.contaminating ?? '?'} 处｜越界 ${ca.out_of_surface ?? '?'} 处）`);
    if (ca.verdict === 'contaminated') {
      invalidate('通道污染：Agent 读到了答案键或绕过了只读通道');
      for (const f of ca.findings ?? []) {
        if (f.level !== 'contaminating') continue;
        log(`    污染：${f.tool} → ${f.token}｜${f.why}`);
      }
    } else if (ca.verdict === 'not_run') {
      invalidate('通道审计没跑');
    }
  }

  // ───────────────────────────────────────────────────────────
  // 8. 打分（在恢复之前）
  // ───────────────────────────────────────────────────────────
  // 顺序有讲究：恢复实验台可能失败（容器重建后本机端口会短暂拒绝连接）。
  // 分数先落盘，恢复失败就不会把一整轮的结论一起吞掉。
  section('打分');

  const truthPath = join(RUNS, 'ground-truth', `${FAULT}.json`);
  if (!existsSync(truthPath)) fail(`找不到真值文件：${truthPath}`);
  const truth = JSON.parse(readFileSync(truthPath, 'utf8'));
  const score = scoreReport(readFileSync(REPORT_PATH, 'utf8'), truth, {
    reportPath: REPORT_PATH,
    truthPath,
  });
  writeFileSync(SCORE_PATH, JSON.stringify(score, null, 2));
  manifest.score = {
    path: SCORE_PATH,
    // rubric 版本写进 manifest：换了判据重打之后，指标表里每个数字
    // 都能说清是哪个口径出来的。
    rubric_version: score.rubric_version,
    root_cause_accuracy: score.root_cause_accuracy,
    accuracy_tier: score.accuracy_tier,
    deployment_attribution: score.deployment_attribution,
    deployment_attribution_correct: score.deployment_attribution_correct,
    deployment_expected: score.deployment_expected,
    needs_review: score.needs_review,
  };

  // ───────────────────────────────────────────────────────────
  // 9. 恢复实验台
  // ───────────────────────────────────────────────────────────
  section('恢复实验台');

  if (NO_RESTORE) {
    manifest.restore = { ok: null, skipped: true };
    log('  --no-restore：故障态留在台子上');
  } else {
    try {
      manifest.restore = { ok: true, at: new Date().toISOString(), ...(await spec.restore()) };
      log('  已恢复公共静默态（缺陷在线、order 2 不在压测路径、超时旋钮 2000）');
    } catch (err) {
      // 恢复失败不能改分数——分数已经在上面落盘了。
      // 但台子脏了，下一轮不能直接开跑，必须让 manifest 说清楚。
      manifest.restore = { ok: false, at: new Date().toISOString(), error: err.message, stack: err.stack };
      invalidate(`恢复实验台失败：${err.message}`);
      log(`  ⚠ 恢复失败：${err.message}`);
    }
  }
  restoreDone = true;

  manifest.finished_at = new Date().toISOString();
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));

  log(`  Root Cause Accuracy：${score.root_cause_accuracy}（tier=${score.accuracy_tier}）`);
  log(`  发布归因：${score.deployment_attribution}（真值要求 ${score.deployment_expected}）`);
  log(`  评分：${SCORE_PATH}`);
  log(`  manifest：${MANIFEST_PATH}`);
  if (!manifest.round_valid) log(`\n⚠ 本轮作废：${manifest.invalid_reason}\n`);
  log('');
}

main().catch(async (err) => {
  console.error(`\n✗ 本轮中止：${err.message}\n`);

  // 中止也要恢复实验台。否则故障留在台子上：下一轮的前置闸门会拦下来，
  // 但如果没人看 manifest，服务会一直 500、告警一直 firing。
  if (injected && !restoreDone && !NO_RESTORE && activeSpec) {
    try {
      manifest.restore = { ok: true, at: new Date().toISOString(), ...(await activeSpec.restore()) };
      restoreDone = true;
      console.error('  已在中止路径恢复实验台');
    } catch (restoreErr) {
      manifest.restore = {
        ok: false,
        at: new Date().toISOString(),
        error: restoreErr.message,
        stack: restoreErr.stack,
      };
      console.error(`  ⚠ 中止路径恢复失败：${restoreErr.message}`);
    }
  }

  // 停掉服务端的静默重试。Agent 失败后服务会「retry silently with backoff」，
  // 那会在 runner 已经放弃之后继续跑同一轮，产生不受控的额外 turn。
  if (cookie) {
    try {
      const res = await fetchRetry(`${MINICLAW}/api/groups/${encodeURIComponent(WS_JID)}/stop`, {
        method: 'POST',
        headers: { Cookie: cookie },
      });
      manifest.abort_stop = { status: res.status };
    } catch (stopErr) {
      manifest.abort_stop = { error: stopErr.message };
    }
  }

  manifest.finished_at = new Date().toISOString();
  manifest.aborted = err.message;
  manifest.aborted_stack = err.stack;
  manifest.round_valid = false;
  manifest.invalid_reason = manifest.invalid_reason ?? `本轮中止：${err.message}`;
  try {
    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
    console.error(`  manifest：${MANIFEST_PATH}`);
  } catch {
    /* manifest 也写不下去就没别的办法了 */
  }
  process.exit(1);
});
