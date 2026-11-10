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
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const { scoreReport } = await import(
  new URL('./score-report.mjs', import.meta.url).href
);
const { buildLocalEntry } = await import(
  new URL('../collector/collect-local.mjs', import.meta.url).href
);
const { readRunningImage } = await import(
  new URL('../collector/local-image.mjs', import.meta.url).href
);
const { writeEntries } = await import(
  new URL('../collector/ledger.mjs', import.meta.url).href
);
const { resolveTarget, targetProfile, applicationLabel } = await import(
  new URL('../targets/descriptor.mjs', import.meta.url).href
);
const { realTargetPreflight, realDeps } = await import(
  new URL('./target-preflight.mjs', import.meta.url).href
);
const {
  loadSpec,
  startTarget,
  stopTarget,
  waitReady,
  listenPid,
  healthStatus,
} = await import(new URL('./real-target.mjs', import.meta.url).href);
const { hostObservation, toLedgerEntry, processStartMs } = await import(
  new URL('../collector/host-target.mjs', import.meta.url).href
);
const { readLedger, COMMIT_AUTHORITY } = await import(
  new URL('../collector/ledger.mjs', import.meta.url).href
);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LAB = join(ROOT, 'incident');
const RUNS = join(LAB, 'runs');
const LAB_ENV =
  process.env.LAB_ENV ?? join(homedir(), '.config/miniclaw-lab/lab.env');
// 用绝对路径：这几步的 cwd 是 incident/，相对路径会拼成 incident/incident/...
const FAULTS_MJS = join(ROOT, 'incident/faults/faults.mjs');
// 工作区路径的唯一真相源在 incident/lab-paths.json：工作区 2026-11-04 搬到仓库外，
// 这里再写死一份就会变成第二处漂移点（漏改一处 = 静默损坏）。
const LAB_PATHS = JSON.parse(
  readFileSync(new URL('../lab-paths.json', import.meta.url), 'utf8'),
);
/**
 * 夹具自己的部署台账。
 *
 * 合成夹具每跑一轮就是一次发布（重建镜像 + 重建容器），但它从没被推到任何镜像库，
 * 所以采集真实靶子的 registry 段看不见它——台账因此一直是空的，而
 * 「台账里没有这一条」和「这一轮没有发布」是相反的结论。夹具要自己写台账。
 *
 * 路径同样在 lab-paths.json 里（唯一真相源），放在 archiveDir 下：
 * 它不在工作区的邻域里（闸门 W 查的就是那条），也不在仓库里。
 * 与真实靶子的台账（ledger.jsonl）分成两个文件：不同靶子的记录混在一个文件里，
 * 「这一轮发布了什么」就变成一个跨靶子的问题了。
 */
const FIXTURE_LEDGER = LAB_PATHS.fixtureLedger;
const MINICLAW = 'http://127.0.0.1:3000';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i === -1 ? dflt : args[i + 1];
};

/**
 * 这一轮打的是哪个靶子。
 *
 * 默认是合成夹具（内置默认值，与改动前逐字一致）。给了描述文件就是真实靶子：
 * 描述文件在仓库外（`--target <路径|名字>`，或 INCIDENT_TARGET_FILE /
 * INCIDENT_TARGET 环境变量）。
 *
 * 注意：**没有描述文件时环境变量一律不生效**。夹具那边的通道是写死的，
 * 让 PROMETHEUS_URL 之类悄悄改掉它，等于让夹具轮次在别的靶子上跑——
 * 那比「跑不起来」难查得多。
 */
const TARGET_SPEC = opt('--target', null);
const DESCRIPTOR = resolveTarget(TARGET_SPEC);
const PROFILE = targetProfile(DESCRIPTOR, DESCRIPTOR ? process.env : {});
const REAL_MODE = PROFILE.mode === 'descriptor';

/**
 * 这一轮用哪个工作区、哪个会话。
 *
 * 合成夹具与真实靶子**各有一套工作区**：夹具工作区里是合成源码，真实工作区里
 * 是靶子源码的快照。混用的话，Agent 诊断的就不是被诊断的那个东西——
 * 而且这种混用不报错，报告读起来照样很有道理。
 */
const WORKSPACE = REAL_MODE
  ? LAB_PATHS.realWorkspaceRoot
  : LAB_PATHS.workspaceRoot;
const WS_JID = REAL_MODE
  ? LAB_PATHS.realGroupJid
  : 'web:8ff36e4b-e8da-4dfd-be0a-b55d70fd9edb';

/**
 * 真实靶子的启动规格（仓库外）。
 *
 * 规格里写着故障旋钮——它是这一轮的答案键的一部分，所以它既不在仓库里，
 * 也不在 Agent 的工作区里。找不到规格就报错，不静默退回夹具那一套。
 */
let LAUNCH_SPEC = null;
if (REAL_MODE) {
  // 启动规格以 lab-paths.json 为准（唯一真相源）：描述文件里可以不写。
  LAUNCH_SPEC = loadSpec(LAB_PATHS.realLaunchSpec ?? PROFILE.launchSpec);
  // 台账路径同样以 lab-paths.json 为准。
  PROFILE.ledgerPath = LAB_PATHS.realLedger;
}

const TARGET = PROFILE.actuatorBaseUrl;
const PROM = PROFILE.prometheusUrl;
const APP_LABEL = applicationLabel(PROFILE);
const RATIO_QUERY =
  `sum(rate(http_server_requests_seconds_count{application="${APP_LABEL}",status=~"5.."}[1m]))` +
  `/clamp_min(sum(rate(http_server_requests_seconds_count{application="${APP_LABEL}"}[1m])),0.001)`;

/**
 * 这一轮注入的故障编号。
 *
 * 真实靶子的故障编号来自启动规格（规格在仓库外）：合成夹具那边是命令行给的
 * F2/F4，真实这边是「R1」这一类**真实靶子自己的**故障，不能借用 F4——
 * 那一栏写着 F4，读的人会以为这一轮注入的是夹具那个超时旋钮。
 */
const FAULT = REAL_MODE ? (LAUNCH_SPEC.faultId ?? 'R1') : opt('--fault', 'F4');
const DRY_RUN = flag('--dry-run');
const NO_RESTORE = flag('--no-restore');
/**
 * Agent 单轮上限。上限是安全网，不是节奏控制：F2 轮的 Agent 跑过 15 分 10 秒，
 * 而旧的 15 分钟 cap 会让 runner 在报告送达前 10 秒断开（0703Z 那一轮就废在这）。
 */
const CAP_MS = Number(opt('--cap-ms', 1800000));
/**
 * 静默态要坐稳多久（毫秒）。默认 18 分钟：比 15 分钟窗口多留 3 分钟余量。
 *
 * 余量为什么从 1 分钟提到 3 分钟（复核件 audit-2026-11-04T0324Z.md 第 5 条）：
 * 11-04 那轮 settle 等了 15.65 分钟，注入时刻**贴着**窗口边界（首个异常距
 * 缺陷提交 16.6 分钟，窗口 15 分钟）——余量只有 1 分钟时，注入的相对时刻每次
 * 都会落在窗口边缘，后续任何「按时间对齐」的推理都会被这条脆弱的边界影响。
 * 18 分钟让缺陷提交在注入时刻至少已经 18 分钟，超出窗口 3 分钟。
 */
const SETTLE_MS = Number(
  opt('--settle-ms', REAL_MODE ? 5 * 60 * 1000 : 18 * 60 * 1000),
);

const now = new Date();
const STAMP = `${now.toISOString().slice(0, 10)}T${now.toISOString().slice(11, 16).replace(':', '')}Z`;
/**
 * 轮次产物落在哪。
 *
 * 合成夹具的轮次产物进仓库（它们是量具的历史证据）。**真实靶子的轮次产物不进
 * 仓库**：它们讲的是真实项目，属于仓库外的证据——仓库是公开的，真实项目的
 * 端口、路径、台账都不该跟着一份 manifest 进去。
 */
const OUT_DIR = REAL_MODE
  ? join(LAB_PATHS.archiveDir, 'lab-data', 'rounds')
  : RUNS;
mkdirSync(OUT_DIR, { recursive: true });
const REPORT_PATH = join(OUT_DIR, `agent-report-${STAMP}.md`);
const SCORE_PATH = join(OUT_DIR, `score-${STAMP}.json`);
const MANIFEST_PATH = join(OUT_DIR, `round-manifest-${STAMP}.json`);

const log = (...a) => console.log(...a);
const section = (t) =>
  log(`\n── ${t} ${'─'.repeat(Math.max(0, 60 - t.length))}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// bash -c 而不是 bash -lc：登录 shell 会把 PATH 换成 /usr/bin/node (v20)，
// 而 better-sqlite3 是按当前 Node (v22) 编的，一 require 就 NODE_MODULE_VERSION 不匹配。
// 脚本里的 node 调用一律用 process.execPath，不靠 PATH。
function sh(cmd, { cwd = ROOT, timeout = 180000 } = {}) {
  const r = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', timeout });
  return {
    code: r.status,
    out: (r.stdout || '').trim(),
    err: (r.stderr || '').trim(),
  };
}

const NODE = process.execPath;

function mustSh(cmd, opts) {
  const r = sh(cmd, opts);
  if (r.code !== 0)
    throw new Error(`命令失败 (exit ${r.code}): ${cmd}\n${r.err || r.out}`);
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

/**
 * Miniclaw 服务（127.0.0.1:3000）是否在线。
 *
 * 为什么要有这个探针：0802Z 那轮前置闸门**全过**（P10 的 provider 是靠 HTTP 拿到的），
 * 说明开跑时服务是在线的；但它在本轮中途掉了，runner 直到「跑 Agent」一步
 * 才从 `ECONNREFUSED 127.0.0.1:3000` 知道——那时静默期已经烧掉 16 分钟、
 * 告警已经 firing，整轮白跑。
 *
 * ⚠️ `mc-auth.mjs` **不碰网络**：它直接读 DB 里的 session 和密钥文件造 cookie。
 * 所以「拿到 cookie」**不等于**「服务在跑」。必须真的发一次 HTTP 请求。
 */
async function probeMiniclaw() {
  try {
    const res = await fetchRetry(
      `${MINICLAW}/api/groups`,
      { headers: cookie ? { Cookie: cookie } : undefined },
      2,
    );
    return res.ok
      ? { ok: true, why: `HTTP ${res.status}` }
      : { ok: false, why: `HTTP ${res.status}` };
  } catch (err) {
    const cause = err?.cause?.message ? `（${err.cause.message}）` : '';
    return { ok: false, why: `${err.message}${cause}` };
  }
}

/**
 * 从本轮的 session transcript 里挖「Agent 为什么没说话」。
 *
 * 为什么要有：2026-11-02T1000Z 那轮中止，ws-run 的 stderr 只有
 * `run_finished reason=completed`——看起来像 Agent 正常跑完却没输出。
 * 真实原因在 data/sessions 的 transcript 里：连续 4 条
 * `stopReason:"error", errorMessage:"429 已达到 Token Plan 用量上限"`。
 * provider 报错既不走 ws-run 的 `error` 事件，也不打服务日志的 ERROR 级——
 * 只落在 transcript。不挖它，中止原因就永远是一句猜不透的「no agent_reply」。
 *
 * 返回 { transcript, apiErrors }；找不到 transcript 就如实说找不到。
 */
function digAgentApiErrors(agentStartIso) {
  const sessionDir = join(ROOT, 'data/sessions');
  const startMs = new Date(agentStartIso).getTime();
  let transcript = null;
  if (existsSync(sessionDir)) {
    for (const dir of readdirSync(sessionDir)) {
      const cand = join(sessionDir, dir, '.claude/sessions');
      if (!existsSync(cand)) continue;
      for (const f of readdirSync(cand)) {
        if (!f.endsWith('.jsonl')) continue;
        const p = join(cand, f);
        if (statSync(p).mtimeMs < startMs) continue;
        if (!transcript || statSync(p).mtimeMs > statSync(transcript).mtimeMs)
          transcript = p;
      }
    }
  }
  if (!transcript)
    return {
      transcript: null,
      apiErrors: null,
      why: '没找到本轮的 session transcript',
    };
  const errors = [];
  for (const line of readFileSync(transcript, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = r?.message;
    if (msg?.stopReason !== 'error') continue;
    errors.push({
      at: msg.timestamp ?? r.timestamp,
      error: String(msg.errorMessage ?? '').slice(0, 300),
    });
  }
  return { transcript, apiErrors: errors };
}

const manifest = {
  stamp: STAMP,
  // 真实靶子轮次注入的是**它自己的**故障（运行时配置旋钮），不是夹具那套：
  // 那一栏写着 F4，读的人会以为这一轮注入过夹具的超时旋钮。
  fault: REAL_MODE
    ? `${FAULT}：${LAUNCH_SPEC?.faultTitle ?? '真实靶子的运行时配置故障'}`
    : FAULT,
  /**
   * 这一轮打的是哪个靶子。合成夹具是 builtin（没有描述文件），真实靶子是
   * descriptor（描述文件在仓库外，所以这里只有代号与路径，不含任何内部信息）。
   */
  target: {
    mode: PROFILE.mode,
    id: PROFILE.id,
    application: APP_LABEL,
    descriptor_file: PROFILE.descriptorFile,
    prometheus_url: PROFILE.prometheusUrl,
    actuator_url: PROFILE.actuatorBaseUrl,
  },
  // dry_run 必须在**建 manifest 的时候**就写对，不能等到 dry-run 分支末尾
  // 才置 true。
  //
  // 原因：dry-run 在中途失败（服务不通之类）时，走的是中止分支，压根到不了
  // 那个置 true 的地方——留下的 manifest 就自称「不是 dry-run」，读起来像
  // 一轮真跑的成绩。中止的那次实测就是这样：dry_run=false、round_valid=false，
  // 靠 invalid_reason 才看得出它中止了。
  //
  // 「跑没跑」和「跑没跑完」是两件事：这个字段答的是前者，所以一开始就得准。
  dry_run: DRY_RUN,
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
  deploy_ledger: {
    ledger: REAL_MODE ? PROFILE.ledgerPath : FIXTURE_LEDGER,
    entries: [],
  },
  provider_probes: [],
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
 * 跑一次轮次规模的 provider 探测。
 *
 * 探测体是合成的，量级取自上一轮真实的 transcript，所以它问的是
 * 「provider 接不接得住一轮的上下文」，而不是「provider 活着吗」。
 *
 * 它**不能**证明「额度够跑完整轮」——provider 没有额度查询接口
 * （/key/info、/health、/model/info 全部 401，实测过）。所以结论只到
 * 「这个规模下通」为止；整轮能不能跑完，靠开跑前再探一次，
 * 以及跑完后回查 transcript 里的额度类错误。
 */
function runProviderProbe(id) {
  const at = new Date().toISOString();
  const r = sh(
    `${NODE} node_modules/tsx/dist/cli.mjs incident/runs/provider-probe.ts`,
    { timeout: 300000 },
  );
  let measured = null;
  try {
    measured = JSON.parse(r.out);
  } catch {
    measured = null;
  }
  const ok = Boolean(measured && measured.completed === true);
  const detail = {
    id,
    at,
    ok,
    exit: r.code,
    measured,
    stderr_tail: (r.err || '').slice(-300),
  };
  manifest.provider_probes.push(detail);
  return detail;
}

/**
 * 探针失败时的报错文本。**先分清是谁的锅，再说规模。**
 *
 * `probe_output_truncated` 是探针自己的 `max_tokens` 被 thinking 吃光了，
 * 不是 provider 接不住——2026-11-06 实测过这一档：`max_tokens=64` 时模型
 * 思考用掉 ~225 token，回复里没有标记，探针就报 `payload_not_echoed`，
 * 把一个完全接得住的轮次拦了下来。这种假阴性必须显式说成「探针自身」的问题，
 * 否则下一轮又会照同一个形状误判。
 */
function probeFailureMessage(id, m, run) {
  const size =
    `  探测规模：${m.payload_bytes ?? '?'} 字节` +
    `（约 ${m.approx_input_tokens ?? '?'} token，基准：${m.reference_round_source ?? '?'}）\n`;
  const tail = `  退出码 ${run.exit}；stderr：${run.stderr_tail || '（无）'}\n`;
  // stop_reason 必须**显式**报出来：它区分「平台把上下文截断了」和
  // 「探针自己的输出预算用完了」。不报这一项，两种截断就得靠人猜。
  const stop =
    `  stop_reason：${m.stop_reason ?? '(没拿到)'}` +
    `；载荷回显：${m.payload_echoed ?? '(没拿到)'}\n`;
  const retry = m.probe_retry
    ? `  探针已自查重试：第一次 max_tokens=${m.probe_retry.first_max_tokens}` +
      ` 用尽，重试用 ${m.probe_retry.retry_max_tokens}（${m.probe_retry.reason}）\n`
    : '';
  if (m.failure_class === 'probe_output_truncated') {
    return (
      `${id} 探针自己的输出预算用完了（stop_reason=max_tokens）——**不是 provider 的问题**。\n` +
      size +
      stop +
      retry +
      tail +
      '  这是探针的假阴性：模型的思考 token 吃掉了 max_tokens，回复里没来得及回显标记。\n' +
      '  探针已经自查重试过一次还是这样——先把 provider-probe.ts 的 max_tokens 调大再重跑，' +
      '不要当成额度故障。'
    );
  }
  return (
    `${id}：provider 接不住一轮规模的请求（可能是额度/限流）。\n` +
    `  失败分类：${m.failure_class ?? '(没拿到分类)'}\n` +
    size +
    stop +
    retry +
    tail +
    '  这是环境的问题（额度/限流），不是 Agent 的问题——别记到它头上。\n'
  );
}

/**
 * 探测通过时也要报 stop_reason。
 *
 * 「通过了」和「通过了而且不是被预算截断糊弄过去的」是两件事：
 * 只有把 stop_reason 和回显情况写进闸门记录，事后翻 manifest 才分得清
 * 这一条到底证明了什么。P12 和 P12b 两处都写——开跑前那一次如果漏了，
 * 前面那一处的判据就用不上。
 */
function probeVerdictNote(m) {
  const stop = m.stop_reason ?? '(没拿到)';
  const echoed = m.payload_echoed ?? '(没拿到)';
  const retried = m.probe_retry
    ? `，探针自查重试过（max_tokens ${m.probe_retry.first_max_tokens}→${m.probe_retry.retry_max_tokens}）`
    : '';
  return `stop_reason=${stop}，载荷回显=${echoed}${retried}`;
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
  const r = await json(
    `${PROM}/api/v1/query?query=${encodeURIComponent(RATIO_QUERY)}`,
  );
  const v = r.data?.result?.[0]?.value?.[1];
  return v === undefined ? 0 : Number(v);
}

/**
 * 等靶子自己的指标在 Prometheus 里出现（P3 的条件）。
 *
 * 重启后进程的指标是从零重新累计的，Prometheus 要等到下一轮抓取才看得见。
 * 所以这里的「等不到」有两种含义：抓取还没到（正常的秒级延迟），
 * 或者靶子根本没起来（异常）。120 秒足够区分——合成抓取周期是秒级。
 */
async function waitForSeries(timeoutMs = 120000) {
  const q = `sum(http_server_requests_seconds_count{application="${APP_LABEL}"})`;
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = await json(`${PROM}/api/v1/query?query=${encodeURIComponent(q)}`);
    const v = r.data?.result?.[0]?.value?.[1];
    if (v !== undefined && Number(v) > 0) return true;
    await sleep(2000);
  }
  return false;
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
    const s = sh(
      `docker inspect target-service --format '{{.State.Health.Status}}'`,
    );
    if (s.out.trim() === 'healthy') return true;
    await sleep(3000);
  }
  return false;
}

/** 容器启动时刻（部署锚点）。 */
function containerStartedAt() {
  const out = sh(
    `docker inspect target-service --format '{{.State.StartedAt}}'`,
  ).out.trim();
  const t = Date.parse(out);
  return Number.isNaN(t) ? null : t;
}

/** 重建容器并等它真的可用。 */
async function recreate() {
  mustSh('./lab.sh recreate target-service', { cwd: LAB });
  if (!(await waitContainerHealthy()))
    fail('target-service 重建后没有变 healthy。');
}

/**
 * 写一条发布记录到夹具自己的台账。
 *
 * 每一次「重建镜像 / 重建容器」之后都要写。合成夹具每轮都是一次发布，
 * 而它从没被推到镜像库，采集真实靶子的 registry 段看不见它——台账因此一直是空的。
 * 台账空着的时候，Agent 问「现在跑的是哪次发布」，读到的答案是
 * 「台账缺条目：没查到」，而不是「这一轮发布过」。这两个结论相反。
 *
 * 这一条同时解决「宿主进程形态的靶子没有 digest 主键」在夹具侧的问题：
 * digest 用本地镜像 id（docker 的内容哈希，和镜像库 digest 同一类身份）。
 */
function recordDeployment(phase, { soft = false } = {}) {
  // 真实靶子是宿主形态：主键是部署单元的 tree hash，不是镜像 id。
  // 两种形态的观测字段不同，写法也不同——共用一套会把「同一个制品
  // 重启了」写成「发了一个新版本」。
  if (REAL_MODE) return recordRealDeployment(phase, { soft });
  const abort = (msg) => {
    if (soft) {
      invalidate(msg);
      log(`  ⚠ ${msg}`);
      return null;
    }
    fail(msg);
  };
  let running;
  try {
    running = readRunningImage('target-service');
  } catch (err) {
    abort(
      `读不到本地镜像/容器事实，写不了发布记录：${err.message}\n` +
        '  采集失败不能被当成「这一轮没有发布」——那是相反的结论。',
    );
    return null;
  }
  const entry = buildLocalEntry({
    image: running,
    container: {
      container: 'target-service',
      started_at: running.container_started_at,
      running: running.running,
    },
    observedAt: new Date().toISOString(),
    cluster: 'lab-local',
    workload: 'target-service',
    deployedBy: 'incident-lab',
  });
  mkdirSync(dirname(FIXTURE_LEDGER), { recursive: true });
  const res = writeEntries(FIXTURE_LEDGER, [entry]);
  if (res.conflicts.length > 0) {
    abort(
      `台账冲突：同一个 digest 出现互斥的记录：${JSON.stringify(res.conflicts)}`,
    );
    return null;
  }
  manifest.deploy_ledger.entries.push({
    phase,
    digest: entry.digest,
    image_ref: entry.image_ref,
    commit: entry.commit,
    commit_source: entry.commit_source,
    built_at: entry.built_at,
    pod_started_at: entry.pod_started_at,
    appended: res.appended.length,
    skipped: res.skipped.length,
    superseded: res.superseded.length,
  });
  log(
    `  已写发布记录（${phase}）：${entry.digest} commit=${entry.commit ?? '(镜像没自述 commit)'} 起于 ${entry.pod_started_at}`,
  );
  return entry;
}

/**
 * 把台账路径交给 Agent。
 *
 * Agent 读得到台账文件，读不到 docker socket——采集在它的够不着的地方，
 * 读侧只读文件。路径写进该工作区的容器环境配置，host 模式下 runner 每次
 * 运行都会把它注入 Agent 的 shell 环境。
 */
function publishLedgerEnv(folder) {
  const file = join(ROOT, 'data', 'config', 'container-env', `${folder}.json`);
  let cfg = {};
  if (existsSync(file)) {
    try {
      cfg = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      fail(`工作区环境配置文件读不出来：${file}（${err.message}）`);
    }
  }
  const customEnv = { ...(cfg.customEnv ?? {}) };
  let ledger = FIXTURE_LEDGER;
  if (REAL_MODE) {
    // 真实靶子：台账是真实项目的台账（在仓库外），通道地址也要按实测指过去。
    //
    // 日志目录用**实测**的（靶子进程自己持有的那些日志文件所在目录），
    // 而不是描述文件里写的那个——描述文件过期时，Agent 会读到一份停在
    // 最后一次启动的旧日志，而且读起来毫无异样。
    ledger = PROFILE.ledgerPath;
    customEnv.DEPLOY_LEDGER = ledger;
    customEnv.PROMETHEUS_URL = PROFILE.prometheusUrl;
    customEnv.TARGET_URL = PROFILE.actuatorBaseUrl;
    // 观测 CLI 在**真实工作区**里（夹具那份在另一个工作区）。
    customEnv.INCIDENT_LAB = LAB_PATHS.realReadonlyCli;
    if (PROFILE.measuredLogsDir) customEnv.LOG_DIR = PROFILE.measuredLogsDir;
    // 描述文件：CLI 的靶子形态（host / container）、指标应用标签、
    // 日志文件名与 git 通道的仓库路径，全都在描述文件里。
    // 不给的话 CLI 会退回内置默认值（容器形态 + 9090/8080），
    // 读起来毫无异样——`runtime env` 会去读一个**别的**容器的环境。
    if (DESCRIPTOR?.__file) customEnv.INCIDENT_TARGET_FILE = DESCRIPTOR.__file;
  } else {
    customEnv.DEPLOY_LEDGER = ledger;
    // 夹具轮次要把真实靶子那一轮留下的通道地址**擦掉**。
    // 否则下一轮夹具的 Agent 会去读真实靶子的日志、查真实靶子的 Prometheus——
    // 合成夹具的证据里混进真实项目的日志，而且不报错。
    for (const key of [
      'PROMETHEUS_URL',
      'TARGET_URL',
      'LOG_DIR',
      'INCIDENT_TARGET_FILE',
    ]) {
      delete customEnv[key];
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...cfg, customEnv }, null, 2)}\n`);
  // 台账文件先建出来（可以是空的）：Agent 问「现在跑的是哪次发布」时，
  // 拿到的是「台账里没有这一条」——**没查到**；而不是「文件不存在」这种崩溃。
  // 这两种都还算「没查到」，但前者能继续问下去。
  mkdirSync(dirname(ledger), { recursive: true });
  if (!existsSync(ledger)) writeFileSync(ledger, '');
  log(`  台账路径已交给 Agent：DEPLOY_LEDGER=${ledger}`);
  return file;
}

// ── 故障规格 ──────────────────────────────────────────────────────────────
const FAULTS = {
  /**
   * F4：触发源在运行时配置层。
   * 静默态 = 缺陷在线但没人踩它；注入 = 只改超时旋钮。
   */
  F4: {
    title: '下游读超时（运行时旋钮）',
    /**
     * 静默态 = **缺陷在线** + order 2 不在压测路径 + 超时旋钮 2000。
     *
     * 「缺陷在线」这一条以前是**隐含**的：F4 测的是「触发源是运行时配置、不是发布」，
     * 而要让运行时配置能触发 5xx，判空兜底必须已经被删掉（缺陷已上线）。
     * 台子停在基线时，旋钮改成 1ms 只会让下游超时 → 降级成 UNKNOWN → 还是 200，
     * 5xx 比例永远是 0，告警等 300 秒也不 firing。
     *
     * 2026-11-04 那次开跑就停在这儿：前置闸门全过、旋钮注入了、故障没起来，
     * 整轮中止（没有 Agent 产出，所以不产生证据，只是白等 5 分钟）。
     * 根因是**静默态的前提从来没被检查过**——这一轮把前提变成自己建立、自己验证：
     *   · 源码里缺陷在不在位 → faults.mjs status F2（读不出来就不跑）
     *   · 跑着的镜像是不是这份源码 → 重新构建（源码是缺陷版 ≠ 镜像是缺陷版）
     *   · 静默态本身是不是对 → order 3 必须 200（超时 2000ms 时下游能通）
     */
    async setup() {
      const knob = readKnob();
      if (knob.DOWNSTREAM_TIMEOUT_MS !== '2000') {
        fail(
          `静默态要求 DOWNSTREAM_TIMEOUT_MS=2000，实际 ${knob.DOWNSTREAM_TIMEOUT_MS}`,
        );
      }
      if ((knob.LOAD_PATHS ?? '').includes('/api/orders/2')) {
        fail(
          '静默态要求 order 2 不在 LOAD_PATHS 里——它在的话缺陷会自己发作，那是 F2 的场景。',
        );
      }

      const status = sh(`${NODE} ${FAULTS_MJS} status F2`, { cwd: LAB });
      if (status.code !== 0) {
        fail(`faults.mjs status F2 失败：\n${status.err || status.out}`);
      }
      const state = status.out.trim().split(/\s+/)[1] ?? 'unknown';
      if (state === 'baseline') {
        const inject = sh(`${NODE} ${FAULTS_MJS} inject F2`, { cwd: LAB });
        if (inject.code !== 0) {
          fail(`faults.mjs inject F2 失败：\n${inject.err || inject.out}`);
        }
      } else if (state !== 'injected') {
        fail(
          `读不懂 F2 的源码状态（${status.out.trim()}）——不能确定缺陷在不在位，这一轮不开跑。`,
        );
      }

      // 重新构建：源码是缺陷版不等于跑着的镜像是缺陷版，这两件事必须对上。
      mustSh('./lab.sh build target-service', { cwd: LAB, timeout: 900000 });
      if (!(await waitContainerHealthy())) {
        fail('重建后 target-service 没有变 healthy。');
      }
      const o3 = await orderStatus(3);
      if (o3 !== 200) {
        fail(
          `静默态要求 order 3 返回 200（超时 2000ms 时下游能通），实际 ${o3}。台子不对，这一轮不开跑。`,
        );
      }
      return {
        defect_state: state,
        defect_commit: mustSh(`git -C ${WORKSPACE} log -1 --format='%h %aI %s'`)
          .out,
        load_paths: knob.LOAD_PATHS,
        note: '静默态：缺陷在线（判空兜底已删），order 2 不在压测路径，超时旋钮 2000',
      };
    },
    /**
     * F4 要坐稳，但基准和 F2 不同。
     *
     * F4 的触发源是**容器重建本身**（旋钮一改就重建），所以注入那一刻的重建就是现场，
     * 不需要等它滑出窗口。要等的是**静默态那次部署**：缺陷是在 setup 里提交并部署的，
     * 那次提交和那次重建都落在窗口里的话，Agent 有理由把触发源归到发布——
     * 那这一轮测的就不是「会不会误归因到发布」，而是「会不会做时间对齐」。
     *
     * 基准 = max(缺陷提交时刻, 容器启动时刻) + 18 分钟（余量见 SETTLE_MS）。
     */
    async settle() {
      const started = containerStartedAt();
      if (!started) fail('读不到容器启动时刻，坐不稳。');
      const head = mustSh(
        `git -C ${WORKSPACE} log -1 --format='%aI'`,
      ).out.trim();
      const committed = new Date(head).getTime();
      const newest = Math.max(committed, started);
      const waitMs = SETTLE_MS - (Date.now() - newest);
      const detail = {
        defect_committed_at: new Date(committed).toISOString(),
        container_started_at: new Date(started).toISOString(),
        settle_ms: SETTLE_MS,
        settle_basis: new Date(newest).toISOString(),
      };
      if (waitMs <= 0) return { ...detail, waited_ms: 0 };
      log(
        `  静默态坐稳中：等 ${Math.ceil(waitMs / 1000)} 秒（到 ${new Date(newest + SETTLE_MS).toISOString()}）`,
      );
      await sleep(waitMs);
      return { ...detail, waited_ms: Math.round(waitMs) };
    },
    async inject() {
      const knob = readKnob();
      setKnob('DOWNSTREAM_TIMEOUT_MS', '1');
      await recreate();
      // 故障到底起来没有，现在就验：缺陷在线的话，超时会让 profile 取回 null，
      // 没有判空兜底 → NPE → 500。兜底还在的话就是 200（降级成 UNKNOWN）。
      // 以前这一步不验，代价是「等 300 秒等一个永远不会来的告警」。
      const o3 = await orderStatus(3);
      if (o3 !== 500) {
        fail(
          `注入后 order 3 返回 ${o3}，不是 500。缺陷没在位——` +
            '超时只会让下游失败，兜底还在的话就降级成 UNKNOWN（200），故障起不来。',
        );
      }
      return {
        knob: 'DOWNSTREAM_TIMEOUT_MS',
        from: knob.DOWNSTREAM_TIMEOUT_MS,
        to: '1',
        changed: ['运行时旋钮'],
        unchanged: ['代码', '压测路径', '数据'],
        probe: `注入后 order 3 = ${o3}（缺陷在位）`,
        note: '本轮只改运行时旋钮，代码一行没动',
      };
    },
    async restore() {
      setKnob('DOWNSTREAM_TIMEOUT_MS', '2000');
      await recreate();
      if (!(await waitHealthyBaseline()))
        fail('恢复后 5xx 比例没回到 0。实验台不干净，下一轮不能直接开跑。');
      return { knob: 'DOWNSTREAM_TIMEOUT_MS', to: '2000' };
    },
    /** 开跑前这条故障特有的不变量：窗口内没有任何代码变更。 */
    async checkWindow() {
      const head = mustSh(
        `git -C ${WORKSPACE} log -1 --format='%h %aI %s'`,
      ).out;
      const ageMin =
        (Date.now() - new Date(head.split(' ')[1]).getTime()) / 60000;
      if (ageMin < 15) {
        fail(
          `服务仓库 HEAD ${head} 只有 ${ageMin.toFixed(1)} 分钟前提交，落在 15 分钟窗口内。\n` +
            '这一轮测的就不是「Agent 会不会误归因到发布」，而是「Agent 会不会做时间对齐」。\n' +
            `等 ${Math.ceil(15 - ageMin)} 分钟让这次提交滑出窗口再开跑（或者先跑别的故障类型）。`,
        );
      }
      record(
        'P8',
        true,
        `服务仓库 HEAD 在窗口外（${ageMin.toFixed(0)} 分钟前）：${head}`,
      );
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
        fail(
          `F2 那一轮运行时配置必须是干净基线，实际 DOWNSTREAM_TIMEOUT_MS=${knob.DOWNSTREAM_TIMEOUT_MS}。` +
            '配置也变了的话，这一轮测的是「两个变更里挑哪个」，不是发布归因。',
        );
      }
      // 1. 把判空兜底加回去并提交——缺陷下线，代码回到基线
      const restore = sh(`${NODE} ${FAULTS_MJS} restore F2`, { cwd: LAB });
      if (restore.code !== 0)
        fail(`faults.mjs restore F2 失败：\n${restore.err || restore.out}`);
      // 2. order 2 放回压测路径（静默态就要一直压着它）
      //    放在重建之前：这样只需要一次容器启动，部署锚点才是干净的一个。
      setKnob(
        'LOAD_PATHS',
        '/api/orders/1,/api/orders/2,/api/orders/3,/api/orders/4,/api/orders/5',
      );
      // 3. 用基线代码重建镜像并部署
      mustSh('./lab.sh build target-service', { cwd: LAB, timeout: 900000 });
      if (!(await waitContainerHealthy()))
        fail('重建后 target-service 没有变 healthy。');

      const o2 = await orderStatus(2);
      if (o2 !== 200) {
        fail(
          `静默态要求 order 2 返回 200（基线代码降级成 UNKNOWN），实际 ${o2}。` +
            '基线没部署成功，这一轮测的就不是「一次发布把缺陷带上去」。',
        );
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
     * 基准 = max(旋钮 mtime, 容器启动时刻) + settle 时长。
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
      log(
        `  静默态坐稳中：等 ${Math.ceil(waitMs / 1000)} 秒（到 ${new Date(newest + SETTLE_MS).toISOString()}）`,
      );
      await sleep(waitMs);
      return { ...detail, waited_ms: Math.round(waitMs) };
    },
    async inject() {
      const inject = sh(`${NODE} ${FAULTS_MJS} inject F2`, { cwd: LAB });
      if (inject.code !== 0)
        fail(`faults.mjs inject F2 失败：\n${inject.err || inject.out}`);
      const commit = mustSh(
        `git -C ${WORKSPACE} log -1 --format='%h %aI %s'`,
      ).out;
      mustSh('./lab.sh build target-service', { cwd: LAB, timeout: 900000 });
      if (!(await waitContainerHealthy()))
        fail('重建后 target-service 没有变 healthy。');

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
      setKnob(
        'LOAD_PATHS',
        '/api/orders/1,/api/orders/3,/api/orders/4,/api/orders/5',
      );
      await recreate();
      if (!(await waitHealthyBaseline()))
        fail('恢复后 5xx 比例没回到 0。实验台不干净，下一轮不能直接开跑。');
      return { load_paths: readKnob().LOAD_PATHS };
    },
    async checkWindow() {
      // F2 要求的是反过来的不变量：被发布的那个提交必须**在**窗口里，
      // 而那个提交在注入时才产生，所以这里只能校验「现在还没有代码变更」。
      const head = mustSh(
        `git -C ${WORKSPACE} log -1 --format='%h %aI %s'`,
      ).out;
      const ageMin =
        (Date.now() - new Date(head.split(' ')[1]).getTime()) / 60000;
      record(
        'P8',
        true,
        `服务仓库 HEAD（${ageMin.toFixed(0)} 分钟前）：${head}`,
      );
      return head;
    },
  },
};

/**
 * 真实靶子轮次的「故障规格」。
 *
 * 合成夹具那套规格注入的是**合成靶子的缺陷**（改源码、改旋钮、重建容器）。
 * 真实靶子的注入手段是另一件事：真实项目不能改源码（改了就不是真实项目了），
 * 所以这一轮注入的是**运行时配置层**的故障——改一个环境变量，让进程带着它重启。
 *
 * 这与夹具的 F4 是同一类：代码一行没动，制品还是同一个制品，
 * 所以「发布/代码变更」不可能是触发源，触发源只能在运行时配置层。
 *
 * 故障旋钮本身写在**仓库外**的启动规格里（`faultEnv`）：
 * 那是这一轮的答案键，不能进仓库，也不能进 Agent 的工作区。
 *
 * 为什么注入要重启进程：Spring Boot 的健康检查阈值在启动时绑定到 Bean 上，
 * 改环境变量不会让已经在跑的进程改口。要让旋钮生效，只能重启——
 * 而「重启」这件事本身会被台账记成一条新的观测（同一个 digest、新的启动时刻），
 * 这正是这一轮要考的东西：**制品没变，变了的是运行时环境**。
 */
const REAL_SPEC = {
  title: '真实靶子：运行时配置旋钮（健康检查的磁盘阈值）',

  /**
   * 窗口不变量：工作区源码快照的 HEAD 落在 15 分钟窗口之外。
   *
   * 夹具那边查的是「缺陷提交在窗口外」，因为那一轮的触发源是旋钮、
   * 代码变更是必要条件——窗口内的提交会让 Agent 有理由去查 diff。
   * 真实这一轮代码与制品一行没动，同一个道理：源码快照有多旧，
   * 旧到不可能是这一轮的触发源，就写清楚，免得 Agent 以为快照是新鲜的。
   */
  async checkWindow() {
    const head = mustSh(
      `git -C ${LAB_PATHS.realRepoPath} log -1 --format='%h %aI %s'`,
    ).out.trim();
    const ageMin =
      (Date.now() - new Date(head.split(' ')[1]).getTime()) / 60000;
    if (ageMin < 15) {
      fail(
        `工作区源码快照 HEAD ${head} 只有 ${ageMin.toFixed(1)} 分钟前提交，落在 15 分钟窗口内。\n` +
          '这一轮测的是「Agent 会不会把运行时配置误归因到代码/发布」，' +
          '而窗口内的提交会让这一轮变成「Agent 会不会做时间对齐」。',
      );
    }
    record(
      'P8',
      true,
      `工作区源码快照 HEAD 在窗口外（${ageMin.toFixed(0)} 分钟前）：${head}`,
    );
    return head;
  },

  /**
   * 静默态：靶子已经按基线跑着（前置那一步拉起来的）。
   *
   * 这里只**核对**，不重启：重启一次就多一条「刚刚发过版」的台账观测，
   * 而这一轮要测的恰恰是 Agent 会不会被那种观测带跑。
   */
  async setup() {
    const status = await healthStatus(LAUNCH_SPEC);
    if (status !== 200) {
      fail(
        `基线态的靶子不健康（/actuator/health = ${status}，期望 200）。台子不对，这一轮不开跑。`,
      );
    }
    const pid = listenPid(LAUNCH_SPEC.port);
    const startedMs = pid === null ? null : processStartMs(pid);
    return {
      note: '基线态：按启动规格跑着，不带故障旋钮（代码与制品都没动）',
      pid,
      started_at: startedMs === null ? null : new Date(startedMs).toISOString(),
      health_status: status,
      changed: [],
      unchanged: ['代码', '制品', '运行时旋钮'],
    };
  },

  /**
   * 静默态坐稳。
   *
   * 和夹具那边不是同一件事，所以默认时长也不同（真实模式 5 分钟，夹具 18 分钟）：
   *
   *   · 夹具要等的是「缺陷提交滑出 15 分钟窗口」——那一轮代码变更与旋钮变更
   *     同时存在，等窗口滑过去是为了让这一轮只测一件事。
   *   · 真实这一轮代码与制品一行没动，窗口里唯一可能出现的「变更」是**进程重启**，
   *     而那次重启恰恰是承载配置变更的动作——它躲不开，也不该躲。
   *     这里要保证的是：基线干净（5xx 比例 0、没有告警 firing），
   *     并且基线那次启动与注入那次重启是台账里**两条不同的观测**。
   */
  async settle() {
    if (!(await waitHealthyBaseline(120000))) {
      fail(
        `基线态 5xx 比例 120 秒内没回到 0（当前 ${await readRatio()}）。` +
          '上一轮故障的残留没清干净，这一轮不开跑。',
      );
    }
    const alerts = await json(`${PROM}/api/v1/alerts`);
    const firing = (alerts.data?.alerts ?? []).filter(
      (a) => a.labels?.alertname === 'HighServerErrorRate',
    );
    if (firing.length > 0) {
      fail('基线态还有 HighServerErrorRate 在 firing——台子不干净。');
    }
    const until = Date.now() + SETTLE_MS;
    const waitMs = until - Date.now();
    if (waitMs > 0) {
      log(`  静默态坐稳中：等 ${Math.ceil(waitMs / 1000)} 秒`);
      await sleep(waitMs);
    }
    return {
      settle_ms: SETTLE_MS,
      waited_ms: Math.max(0, Math.round(waitMs)),
      baseline_ratio: 0,
      baseline_alert_firing: false,
    };
  },

  /**
   * 注入：按故障态的环境变量重启进程。
   *
   * 旋钮走**进程环境**，不走命令行——环境不进 argv，也就不会出现在
   * `ps` 输出、启动日志和 transcript 里；而 `runtime env` 这条通道读的
   * 正是进程环境，旋钮就摆在那里等着被看见。
   */
  async inject() {
    const faultEnv = LAUNCH_SPEC.faultEnv ?? {};
    const knobs = Object.keys(faultEnv);
    if (knobs.length === 0) {
      fail(
        '启动规格里没有故障旋钮（faultEnv 是空的）——这一轮不会注入任何东西。',
      );
    }
    const stopped = await stopTarget(LAUNCH_SPEC);
    if (!stopped.stopped) {
      fail(`停不掉基线态的靶子：${stopped.why}`);
    }
    startTarget(LAUNCH_SPEC, { env: { ...baselineEnv(), ...faultEnv } });
    const ready = await waitReady(LAUNCH_SPEC, {
      expectedStatus: 503,
      timeoutMs: 300000,
    });
    if (!ready.ready) {
      fail(
        `注入后靶子没有进入故障态（/actuator/health 期望 503，实际 ${ready.status}）：${ready.why}\n` +
          '  注入没生效就不跑 Agent——那会变成一轮「在没故障的台子上测诊断」。',
      );
    }
    return {
      changed: knobs,
      unchanged: ['代码', '制品', '制品 digest'],
      probe: `注入后 /actuator/health = ${ready.status}`,
      note: '只改运行时旋钮（进程环境），代码与制品一行没动；进程重启让旋钮生效',
    };
  },

  /** 恢复：按基线态的环境变量重启进程，并把 5xx 比例等回 0。 */
  async restore() {
    const stopped = await stopTarget(LAUNCH_SPEC);
    if (!stopped.stopped) {
      fail(`停不掉故障态的靶子：${stopped.why}`);
    }
    startTarget(LAUNCH_SPEC, { env: baselineEnv() });
    const ready = await waitReady(LAUNCH_SPEC, {
      expectedStatus: 200,
      timeoutMs: 300000,
    });
    if (!ready.ready) {
      fail(`恢复后靶子没回到健康态：${ready.why}`);
    }
    if (!(await waitHealthyBaseline(180000))) {
      fail(
        `恢复后 5xx 比例 180 秒内没回到 0（当前 ${await readRatio()}）。` +
          '实验台不干净，下一轮不能直接开跑。',
      );
    }
    return {
      to: 'baseline',
      probe: `恢复后 /actuator/health = ${ready.status}`,
    };
  },
};

/**
 * 健康检查探针。
 *
 * 为什么需要它：5xx 比例这条告警的分子是「5xx 的请求数」。没有人打健康检查
 * 的时候，靶子返回 503 也只是一个没人看见的状态——指标里没有 5xx 样本，
 * 比值永远是 0，告警永远不 firing，这一轮就没有故障可诊断。
 *
 * 它是**探针**，不是压测：每秒 1 次、单连接、只打健康检查端点，
 * 打的是我们自己按规格起在回环上的实验实例。
 *
 * 为什么不用「改监控配置加一个健康检查抓取任务」：监控配置是共享资源，
 * 改它要单独授权；而且由编排脚本自己造流量，可以在 manifest 里说清楚
 * 「这一轮的健康检查流量来自本地探针，每秒 1 次」——读的人不至于以为
 * 真实环境里有人在压健康检查。
 */
/**
 * 这一轮的健康检查探针（全局一份）。
 *
 * 探针是**这一轮证据面的一部分**，不是台子的常驻设施：
 * 起在摆静默态之前，停在恢复之后——它打出来的 5xx 样本正是
 * 「HighServerErrorRate」这条告警的分子。
 */
let HEALTH_PROBE = null;

function ensureHealthProbe() {
  if (HEALTH_PROBE) return HEALTH_PROBE;
  HEALTH_PROBE = startHealthProbe(
    `http://127.0.0.1:${LAUNCH_SPEC.port}${LAUNCH_SPEC.healthPath}`,
  );
  log(
    `  健康检查探针已起：每秒 1 次打 ${LAUNCH_SPEC.healthPath}` +
      '（探针，不是压测：单连接、只打体检端点）',
  );
  return HEALTH_PROBE;
}

function stopHealthProbe() {
  if (!HEALTH_PROBE) return;
  log(`  健康检查探针已停：${JSON.stringify(HEALTH_PROBE.stats())}`);
  HEALTH_PROBE.stop();
  HEALTH_PROBE = null;
}

/**
 * 台账里这个 digest 的 commit 由谁说了算。
 *
 * commit 不自己编：宿主形态的靶子没有 CI 记录可读，能说的只有
 * 「台账里已经有这么一条，而且它的 commit 来源比别的来源更硬」。
 * 台账里没有 → 写 null（「没查到」），不是「没有 commit」。
 */
function ledgerCommitFor(digest) {
  let best = null;
  for (const row of readLedger(PROFILE.ledgerPath)) {
    if (row.digest !== digest) continue;
    if (!row.commit) continue;
    const authority = COMMIT_AUTHORITY[row.commit_source] ?? 0;
    if (!best || authority > best.authority) {
      best = { authority, commit: row.commit, source: row.commit_source };
    }
  }
  return best;
}

/**
 * 写一条**宿主形态**的发布观测到台账。
 *
 * 与夹具那边的差别：夹具的主键是镜像 id，宿主形态的主键是**部署单元的
 * tree hash**（制品目录整体）。同一个制品重启一次，主键不变、启动时刻变，
 * 于是台账里多一条观测——读侧按 (digest, 启动时刻) 分桶就知道
 * 「同一个制品被重启过」，而不是「发过两个版本」。
 *
 * 这一条必须**如实**写：少写一条，Agent 就看不到「刚刚重启过」；
 * 多写一条，它就会把「台账里多了几行」当成「发过好几个版本」。
 */
function recordRealDeployment(phase, { soft = false } = {}) {
  const abort = (msg) => {
    if (soft) {
      invalidate(msg);
      log(`  ⚠ ${msg}`);
      return null;
    }
    fail(msg);
    return null;
  };
  const pid = listenPid(LAUNCH_SPEC.port);
  if (pid === null) {
    abort(
      '端口上没有监听进程，写不了发布观测——' +
        '采集失败不能被当成「这一轮没有发布」，那是相反的结论。',
    );
    return null;
  }
  let observation;
  try {
    observation = hostObservation({
      artifactDir: LAUNCH_SPEC.artifactDir,
      pid,
    });
  } catch (err) {
    abort(`读不到宿主形态的部署事实，写不了发布观测：${err.message}`);
    return null;
  }
  const known = ledgerCommitFor(observation.digest);
  const entry = toLedgerEntry(
    {
      ...observation,
      commit: known?.commit ?? null,
      commit_source: known?.source ?? null,
    },
    { deployedBy: 'host' },
  );
  mkdirSync(dirname(PROFILE.ledgerPath), { recursive: true });
  const res = writeEntries(PROFILE.ledgerPath, [entry]);
  if (res.conflicts.length > 0) {
    abort(
      `台账冲突：同一个 digest 出现互斥的记录：${JSON.stringify(res.conflicts)}`,
    );
    return null;
  }
  manifest.deploy_ledger.entries.push({
    phase,
    digest: entry.digest,
    image_ref: entry.image_ref,
    commit: entry.commit,
    commit_source: entry.commit_source,
    built_at: entry.built_at,
    pod_started_at: entry.pod_started_at,
    appended: res.appended.length,
    skipped: res.skipped.length,
    superseded: res.superseded.length,
  });
  log(
    `  已写发布观测（${phase}）：${entry.digest} commit=${entry.commit ?? '(台账里还没有 commit)'} 起于 ${entry.pod_started_at}`,
  );
  return entry;
}

/**
 * 基线态的进程环境：规格里的基线环境，**外加把故障旋钮显式抹掉**。
 *
 * 为什么显式抹：编排脚本自己的进程环境可能带着故障旋钮
 * （上一次手工起靶子时导出过），那样基线态会带着旋钮跑起来，
 * 「注入」就变成了一句空话，而报告会把一个根本没注入的故障说成真故障。
 */
function baselineEnv() {
  const env = { ...(LAUNCH_SPEC.baselineEnv ?? {}) };
  for (const key of Object.keys(LAUNCH_SPEC.faultEnv ?? {})) env[key] = null;
  return env;
}

/**
 * 把上一轮留下的日志挪出 Agent 的证据面。
 *
 * 为什么非做不可：真实靶子的日志目录是**跨轮累积**的。第二轮 Agent 能读到第一轮
 * 注入时打的那几行 `DiskSpaceHealthIndicator ... threshold: 53687091200`，
 * 第三轮还能读到前两轮——阈值这个答案就直接躺在日志里。
 *
 * 这**不是**通道越界：日志目录本来就是合法证据面，channel-audit 按定义放行它，
 * 所以审计会说 clean。真正被破坏的是**样本独立性**：后几轮的命中是被前一轮
 * 提示过的命中，命中率不能当独立样本的命中率看。
 *
 * 归档而不是删除：完整历史留着可追溯，只是不在这一轮的证据面里。
 * 必须在**停掉进程之后**调用——进程持着旧句柄，只挪文件的话它会继续写进
 * 已改名的 inode，新一轮看不到那些内容，归档件却还在长。
 */
function archiveRealLogs(stamp) {
  const runDir = LAUNCH_SPEC.runDir ?? dirname(LAUNCH_SPEC.launcher);
  const logsDir = join(runDir, 'logs');
  const moves = [];
  if (existsSync(logsDir)) {
    for (const f of readdirSync(logsDir)) {
      if (f.endsWith('.log')) {
        moves.push({ src: join(logsDir, f), rel: join('logs', f) });
      }
    }
  }
  const launchLog = join(runDir, 'launch.log');
  if (existsSync(launchLog)) moves.push({ src: launchLog, rel: 'launch.log' });
  if (moves.length === 0) return { archived: 0, dest: null };
  const dest = join(runDir, 'logs-archive', stamp);
  mkdirSync(dest, { recursive: true });
  for (const m of moves) {
    const target = join(dest, m.rel);
    mkdirSync(dirname(target), { recursive: true });
    renameSync(m.src, target);
  }
  return { archived: moves.length, dest };
}

/**
 * 把靶子拉回**基线态**（不带故障旋钮），并把这次观测记进台账。
 *
 * 顺序：
 *   1. 端口上有进程就停掉（健康也停）。停法只有一种：找到监听进程，只对它发信号。
 *      健康的进程以前是**沿用**的，理由是不想多一条「刚刚发过版」的观测。
 *      但沿用意味着日志接着上一轮往下写——见 archiveRealLogs 的注释。
 *      两害相权：多一条基线重启的观测是**可见的**（台账里写着），
 *      前一轮的注入痕迹留在证据面里是**不可见的**。选前者。
 *   2. 把上一轮的日志归档出去。
 *   3. 拉起来，等它真的健康（200），再记观测。
 */
async function ensureRealBaseline() {
  const pid = listenPid(LAUNCH_SPEC.port);
  if (pid !== null) {
    const stopped = await stopTarget(LAUNCH_SPEC);
    if (!stopped.stopped) {
      fail(`停不掉现有的靶子进程：${stopped.why}`);
    }
  }
  const logArchive = archiveRealLogs(STAMP);
  if (logArchive.archived > 0) {
    log(
      `  上一轮日志已归档：${logArchive.archived} 个文件 → ${logArchive.dest}`,
    );
  }
  startTarget(LAUNCH_SPEC, { env: baselineEnv() });
  const ready = await waitReady(LAUNCH_SPEC, {
    expectedStatus: 200,
    timeoutMs: 300000,
  });
  if (!ready.ready) {
    fail(
      `基线态拉不起来（/actuator/health 期望 200，实际 ${ready.status}）：${ready.why}`,
    );
  }
  recordRealDeployment('baseline');
  return {
    restarted: true,
    pid: listenPid(LAUNCH_SPEC.port),
    status: 200,
    log_archive: logArchive,
  };
}

/**
 * 真实这一轮的工作区记忆必须**结构性地**为空。
 *
 * 夹具那边这一步是 memory-de-leak.mjs：把固定的两行 lesson/open_loop 改写掉。
 * 真实这一轮没有那两行，改写脚本用不上；但「记忆面为空」这条判据不能跟着
 * 消失——漏扫的面和没有面的区别，正是这个项目最贵的那次教训。
 * 所以这里换成一条**显式检查**：直接查表（不按 status 过滤，软删的正文也算），
 * 非空就中止。
 *
 * 顺带把「工作区 jid → folder → 同 folder 的全部 jid」这件事重算一遍，
 * 与泄漏扫描用的是同一套口径。
 */
function assertRealMemoryEmpty() {
  const require = createRequire(import.meta.url);
  const Database = require('better-sqlite3');
  const db = new Database(join(ROOT, 'data/db/messages.db'), {
    readonly: true,
  });
  try {
    const grp = db
      .prepare('SELECT folder FROM registered_groups WHERE jid = ?')
      .get(WS_JID);
    if (!grp?.folder) fail(`工作区 ${WS_JID} 没有登记 folder，记忆面无从核对`);
    const jids = new Set(
      db
        .prepare('SELECT jid FROM registered_groups WHERE folder = ?')
        .all(grp.folder)
        .map((r) => r.jid),
    );
    for (const a of db
      .prepare('SELECT chat_jid, id FROM agents WHERE group_folder = ?')
      .all(grp.folder)) {
      jids.add(`${a.chat_jid}#agent:${a.id}`);
    }
    const rows = db
      .prepare(
        `SELECT workspace_jid, id, kind, status, title FROM workspace_memory_items
          WHERE workspace_jid IN (${[...jids].map(() => '?').join(',')})`,
      )
      .all(...jids);
    if (rows.length) {
      fail(
        `工作区记忆非空（${rows.length} 条）：\n` +
          rows
            .map(
              (r) =>
                `  - ${r.workspace_jid}/${r.kind}/${r.status}/${r.id} ${r.title ?? ''}`,
            )
            .join('\n') +
          '\nclear-history 之后记忆面必须为空。这不是「改写」能解决的：真实这一轮' +
          '没有夹具那两行可改写，非空就说明清理没生效。',
      );
    }
    return 0;
  } finally {
    db.close();
  }
}

function startHealthProbe(url, { intervalMs = 1000 } = {}) {
  let stopped = false;
  let requests = 0;
  let errors = 0;
  const timer = setInterval(() => {
    if (stopped) return;
    fetch(url)
      .then(() => {
        requests += 1;
      })
      .catch(() => {
        errors += 1;
      });
  }, intervalMs);
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    stats() {
      return { requests, errors, interval_ms: intervalMs, url };
    },
  };
}

async function main() {
  // 真实靶子的轮次注入的是**运行时配置层**的故障：改一个环境变量，
  // 让同一个制品的进程带着它重启。代码一行没动，制品还是那个制品——
  // 所以「发布/代码变更」在物理上就不可能是触发源，这一轮考的就是
  // Agent 会不会被「刚刚发过版」的表象带跑。
  //
  // 合成夹具那套注入（改源码 / 改旋钮 / 重建容器）在真实靶子上**不适用**：
  // 改源码就不叫真实项目了。所以两边的注入路径必须分开写，不能共用一套。

  const spec = REAL_MODE ? REAL_SPEC : FAULTS[FAULT];
  if (!spec)
    fail(
      `还没实现的故障类型：${FAULT}。当前支持：${Object.keys(FAULTS).join(', ')}`,
    );
  activeSpec = spec;

  // ───────────────────────────────────────────────────────────
  // 0. 前置闸门
  // ───────────────────────────────────────────────────────────
  section('前置闸门');

  if (REAL_MODE) {
    // 真实靶子用另一套前置闸门（问的问题不一样，见 runs/target-preflight.mjs）。
    //
    // 闸门之前先把靶子摆到基线态：闸门里的 P1 要量「actuator 体检返回 200」，
    // P2 要量「靶子进程自己持有那些日志文件」——靶子没跑起来，这两条问不出
    // 任何东西。dry-run 不碰靶子：它只验证闸门本身能不能过。
    if (DRY_RUN) {
      if (listenPid(LAUNCH_SPEC.port) === null) {
        fail(
          'dry-run 需要靶子已经跑着（前置闸门要量它的体检端点与日志句柄）。\n' +
            '  先按启动规格把它拉起来：规格在仓库外，见 incident/REAL-TARGET.md。',
        );
      }
    } else {
      manifest.target = {
        ...manifest.target,
        baseline: await ensureRealBaseline(),
      };
      ensureHealthProbe();
      // 基线现在每轮都重启（为了把上一轮日志挪出证据面），而刚起来的进程在
      // Prometheus 里还没有序列——不在这里等，P3「靶子在自己的指标里现身」会
      // 因为「还没来得及被抓到」判死，整轮在闸门处中止。
      if (!(await waitForSeries())) {
        fail(
          '基线重启后 120 秒内，靶子的指标没在 Prometheus 里出现——' +
            '活性信号拿不到，这一轮不开跑（不能把「没抓到」当成「靶子活着」）。',
        );
      }
    }
    const { gates, facts } = await realTargetPreflight(PROFILE, realDeps);
    manifest.target = { ...manifest.target, facts };
    // 实测出来的日志目录（靶子进程自己持有的那些日志文件在哪）。
    // 交给 Agent 的是它，不是描述文件里那个可能已经过期的路径。
    PROFILE.measuredLogsDir = facts.measured_logs_dir;
    manifest.deploy_ledger = { ledger: PROFILE.ledgerPath, entries: [] };
    for (const g of gates) record(g.id, g.ok, g.detail);
    const failed = gates.filter((g) => !g.ok);
    if (failed.length) {
      fail(
        `真实靶子的前置闸门没过（${failed.map((g) => g.id).join(', ')}）：\n` +
          failed.map((g) => `  ${g.id}：${g.detail}`).join('\n'),
      );
    }
  } else {
    if (!existsSync(LAB_ENV)) fail(`旋钮文件不存在：${LAB_ENV}`);

    const ps = mustSh(`docker ps --format '{{.Names}}\t{{.Status}}'`);
    const containers = Object.fromEntries(
      ps.out
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [n, ...rest] = l.split('\t');
          return [n, rest.join('\t')];
        }),
    );
    for (const name of [
      'target-service',
      'incident-prometheus',
      'incident-alertmanager',
    ]) {
      if (!containers[name])
        fail(`容器 ${name} 没在跑。开跑前先 incident/lab.sh up -d。`);
    }
    record('P1', true, `三个容器都在跑：${Object.keys(containers).join(', ')}`);

    const mounts = mustSh(
      `docker inspect target-service --format '{{range .Mounts}}{{.Source}}->{{.Destination}} {{end}}'`,
    );
    if (!mounts.out.includes(WORKSPACE)) {
      fail(
        `target-service 的挂载源不在工作区路径下：${mounts.out}\n期望挂载源 = ${WORKSPACE}/logs（工作区 2026-11-04 已搬到仓库外，见 incident/lab-paths.json）。`,
      );
    }
    record('P2', true, `挂载源指向工作区：${mounts.out}`);

    // 日志文件必须真的在增长——容器 healthy 但日志文件不增长是搬家的静默损坏之一
    const appLog = join(WORKSPACE, 'logs/app.log');
    const stat1 = sh(`stat -c '%s' ${appLog}`);
    if (stat1.code !== 0) fail(`读不到 ${appLog}：${stat1.err}`);
    await sleep(3000);
    const size1 = Number(stat1.out);
    const size2 = Number(sh(`stat -c '%s' ${appLog}`).out);
    if (!(size2 > size1)) {
      fail(
        `app.log 3 秒内没有增长（${size1} → ${size2}）。容器 healthy 不代表日志通道活着——文件属主不对时容器会退回 stdout。`,
      );
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
        fail(
          `基线 5xx 比例 90 秒内没回到 0（当前 ${await readRatio()}）。上一轮故障态没清干净。`,
        );
      }
    }
    record('P4', true, '基线 5xx 比例 = 0');

    const alerts0 = await json(`${PROM}/api/v1/alerts`);
    if (
      alerts0.data.alerts.some(
        (a) => a.labels?.alertname === 'HighServerErrorRate',
      )
    ) {
      fail(
        '开跑前 HighServerErrorRate 已经在 firing。实验台不干净，这一轮的结果不可用。',
      );
    }
    record('P5', true, '开跑前没有告警在 firing');
  } // ← 合成夹具的前置闸门到此为止；真实靶子走上面那套

  await spec.checkWindow();

  cookie = mustSh(`${NODE} incident/runs/mc-auth.mjs`).out;

  // 上一轮失败时服务端会「retry silently with backoff」同一条消息。
  // 开跑前先停掉它，否则它会在本轮期间插进来跑一个不受 runner 控制的 turn。
  try {
    const stop = await fetchRetry(
      `${MINICLAW}/api/groups/${encodeURIComponent(WS_JID)}/stop`,
      {
        method: 'POST',
        headers: { Cookie: cookie },
      },
    );
    log(`  已停止该工作区的残留队列（HTTP ${stop.status}）`);
  } catch (err) {
    log(`  ⚠ 停止残留队列失败（继续）：${err.message}`);
  }

  const groups = await json(`${MINICLAW}/api/groups`, { withCookie: true });

  // 记录本轮实际使用的 provider/模型。换模型会让不同轮次不可比，
  // manifest 必须带上，指标表才能说清楚「这个数字是哪个模型跑出来的」。
  const prov = await json(`${MINICLAW}/api/config/claude/providers`, {
    withCookie: true,
  });
  const activeProvider = prov.providers?.find(
    (p) => p.id === prov.defaultProviderId,
  );
  if (!activeProvider)
    fail(`找不到当前默认 provider（${prov.defaultProviderId}）。`);
  manifest.provider = {
    defaultProviderId: prov.defaultProviderId,
    name: activeProvider.name ?? null,
    model: activeProvider.anthropicModel ?? null,
    enabledCount: prov.enabledCount ?? null,
  };
  record(
    'P10',
    true,
    `provider=${activeProvider.name} model=${activeProvider.anthropicModel}`,
  );

  const grp = groups?.groups?.[WS_JID];
  if (!grp) fail(`找不到工作区 ${WS_JID}，Agent 无处可跑。`);
  const expectCwd = WORKSPACE;
  if (grp.custom_cwd !== expectCwd) {
    fail(
      `工作区 custom_cwd=${grp.custom_cwd}，不是 ${expectCwd}。Agent 会拿到一个空壳目录。`,
    );
  }
  record(
    'P9',
    true,
    `工作区就位（custom_cwd=${grp.custom_cwd}，folder=${grp.folder}）` +
      (REAL_MODE
        ? '——真实靶子的工作区（里面是靶子源码的快照，与合成夹具的工作区不是同一个）'
        : ''),
  );

  // 把台账路径交给 Agent（写进该工作区的容器环境配置）。
  // 不做这一步，Agent 的 deploy 通道就会因为「没有配置台账」直接死掉，
  // 它连「没查到」都拿不到——那一轮对发布归因就是没有证据。
  publishLedgerEnv(grp.folder);

  // P11：Miniclaw 服务本身在线。
  // runner 不负责起服务，只假设 3000 端口上有东西在听；而 mc-auth.mjs 只读 DB 造 cookie，
  // 不碰网络——所以「拿到 cookie」不等于「服务在跑」。0802Z 就是漏了这一条。
  const probe = await probeMiniclaw();
  if (!probe.ok) {
    fail(
      `Miniclaw 服务不在线（${MINICLAW}：${probe.why}）。\n` +
        `runner 不负责起服务，开跑前先把它拉起来：node dist/index.js`,
    );
  }
  record('P11', true, `Miniclaw 服务在线（${probe.why}）`);

  // P12：provider 接不接得住**一轮的规模**。
  //
  // 这一条改过两次语义，两次都是被实测打脸：
  //
  // 11-02 有两轮撞在额度上（0802Z 跑到最后一刻才发现，1000Z 轮次中途 429），
  // 当时闸门是全过的——因为闸门问的是「provider 活着吗」，而额度类故障的
  // 形状是「小请求还通、大请求不通」「开跑时通、跑到一半不通」。
  //
  // 11-05 又撞了一次：闸门绿，轮次跑完，最后才发现额度用完了。
  //
  // 所以闸门改成问「接不接得住一轮的上下文」，探测规模取自上一轮真实的
  // transcript 字节数（不是拍脑袋的数），而且**开跑前还要再探一次**（P12b）——
  // 前置闸门到开跑之间隔着静默期的十几分钟，额度就是在那段时间里死的。
  //
  // 它**不能**证明「额度够跑完整轮」：provider 没有额度查询接口
  // （/key/info、/health、/model/info 全部 401，实测过）。所以这条闸门的
  // 结论只到「这个规模下通」为止，manifest 里记的是这次探测的测量值。
  //
  // 代价要说清楚：这是一次**真实的模型请求**，规模和一轮相当，会产生真实费用。
  // 换来的是「不白等一轮」。脚本只吐测量值和失败分类，不吐 endpoint /
  // 模型名 / 凭据 / 回复原文。
  const p12 = runProviderProbe('P12');
  if (!p12.ok) {
    const m = p12.measured ?? {};
    // 「额度不通」的历史注脚只在**真的**额度/限流时才有意义。
    // 探针自己截断（probe_output_truncated）时附上它，就把探针的锅
    // 说成了 provider 的锅——正是这次踩到的那个错归因。
    const history =
      m.failure_class === 'probe_output_truncated'
        ? ''
        : '  11-02 的 0802Z / 1000Z、11-05 那轮都白等在这里：闸门全过、轮次跑完，\n' +
          '  最后才发现额度根本不通。';
    fail(probeFailureMessage('P12', m, p12) + history);
  }
  record(
    'P12',
    true,
    `provider 接得住一轮规模（${p12.measured.approx_input_tokens} token / ${p12.measured.elapsed_ms}ms，基准：${p12.measured.reference_round_source}，${probeVerdictNote(p12.measured)}）`,
  );

  if (DRY_RUN) {
    // dry-run 只跑了前置闸门，**不是一轮成绩**。manifest 里必须自己说清楚，
    // 否则这份文件读起来像「一轮跑完了而且有效」（2026-11-06 的 0910Z 就是
    // 那样：agent/score 全是 null，round_valid 却是 true）。
    manifest.dry_run = true;
    invalidate('dry-run：只跑了前置闸门，没有跑整轮，不是一轮成绩');
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
  // 静默态本身就是一次部署（重建镜像 + 重建容器）。不写这一条，
  // Agent 在窗口里问「有没有发布」时读到的是空台账。
  //
  // 真实靶子不在这里写：基线态那次启动的观测在前置步骤已经记过了
  // （ensureRealBaseline）。同一个进程记两次会在台账里多出一行
  // 「刚才又重启了一次」——那不是观测，是重复计数。
  if (REAL_MODE) {
    log('  基线态的发布观测已在前置步骤记过（同一个进程不重复记）');
  } else {
    recordDeployment('setup');
  }
  log(`  ${manifest.setup.note ?? '静默态就位'}`);

  // ───────────────────────────────────────────────────────────
  // 2. 清 Agent 可读面
  // ───────────────────────────────────────────────────────────
  section('清 Agent 可读面');

  // 聊天历史不是扫描面，必须显式清。clear-history 会连带清掉工作区记忆与
  // data/sessions 下的 Skill 副本，所以后面三步是重跑，不是首跑。
  const clear = await fetchRetry(
    `${MINICLAW}/api/groups/${encodeURIComponent(WS_JID)}/clear-history`,
    {
      method: 'POST',
      headers: { Cookie: cookie },
    },
  );
  if (!clear.ok)
    fail(`clear-history 返回 ${clear.status}：${await clear.text()}`);
  log('  聊天历史已清（连带工作区记忆与 session 目录）');

  if (REAL_MODE) {
    // 真实这一轮没有「同步夹具 Profile / 同步夹具工作区的 CLI」那两步：
    // sync-agent-profile.mjs 写死的是夹具的 profile id 与 identity.json，
    // sync-tools.mjs 写的也是夹具工作区那份 CLI。真实这一轮对应的是
    // setup-real-workspace.mjs（幂等：按名字找现有的 Profile 与工作区，找到就更新）。
    mustSh(`${NODE} incident/runs/setup-real-workspace.mjs`);
    // 记忆面：不改写、只核对——真实这一轮没有夹具那两行可改写，
    // 「记忆面为空」这条判据必须显式验，不能跟着改写脚本一起消失。
    const memoryRows = assertRealMemoryEmpty();
    log(`  工作区记忆面核对：${memoryRows} 条（非空即中止）`);
  } else {
    mustSh(`${NODE} incident/runs/memory-de-leak.mjs`);
    mustSh(`${NODE} incident/runs/sync-agent-profile.mjs`);
    mustSh(`${NODE} incident/runs/sync-tools.mjs`);
  }
  // Skill 两套轮次共用同一份源（incident/skills/），同步与轮次无关。
  mustSh(`${NODE} incident/runs/sync-skills.mjs`);

  const scan = sh(
    `${NODE} incident/runs/leak-scan.mjs${REAL_MODE ? ' --real' : ''}`,
  );
  if (scan.code !== 0)
    fail(`泄漏扫描没过（exit ${scan.code}）：\n${scan.out}\n${scan.err}`);
  log('  泄漏扫描：0 命中');

  // ───────────────────────────────────────────────────────────
  // 3. 静默态坐稳（滑出 15 分钟窗口）
  // ───────────────────────────────────────────────────────────
  section('静默态坐稳');
  manifest.settle = (await spec.settle()) ?? { skipped: true };
  if (manifest.settle.skipped) {
    log('  本轮不需要坐稳（触发源就是那一次容器重建）');
  } else {
    log(
      `  已坐稳（等 ${Math.round((manifest.settle.waited_ms ?? 0) / 1000)} 秒）`,
    );
  }

  // ───────────────────────────────────────────────────────────
  // 4. 注入故障
  // ───────────────────────────────────────────────────────────
  section('注入故障');

  const injectedAt = new Date().toISOString();
  manifest.injection = {
    fault: FAULT,
    at: injectedAt,
    ...(await spec.inject()),
  };
  injected = true;
  log(
    `  已注入：${manifest.injection.changed.join('、')}（${manifest.injection.changed.length} 个维度）`,
  );
  // 注入这一步对 F2 是「改代码 + 重建」（一次发布），对 F4 是「改旋钮 + 重建」
  // （容器重启但镜像没变）。两种都写：台账记的是**观测**，不是「发布了几次」，
  // 读侧按 (digest, 启动时刻) 分桶才知道这是一次还是两次发布。
  recordDeployment('inject');

  // ───────────────────────────────────────────────────────────
  // 5. 等告警 firing
  // ───────────────────────────────────────────────────────────
  section('等告警 firing');

  let fired = null;
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    const a = await json(`${PROM}/api/v1/alerts`);
    const hit = a.data.alerts.find(
      (x) =>
        x.labels?.alertname === 'HighServerErrorRate' && x.state === 'firing',
    );
    if (hit) {
      fired = hit;
      break;
    }
    await sleep(5000);
  }
  if (!fired) {
    fail(
      '300 秒内 HighServerErrorRate 没有 firing。故障可能没注入成功，别在没故障的台子上跑 Agent。',
    );
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

  // 跑 Agent 之前再探一次服务。0802Z 的教训：开跑时服务在线，跑到一半掉了，
  // 结果在告警 firing 之后才发现，白烧一整轮。掉线要在开跑前就暴露。
  const live = await probeMiniclaw();
  if (!live.ok) {
    fail(
      `Miniclaw 服务在本轮中途掉线了（${MINICLAW}：${live.why}）。\n` +
        `这一轮不是 Agent 的问题，别记到它头上。`,
    );
  }

  // P12b：开跑前再探一次 provider。
  //
  // 前置闸门到开跑之间隔着静默期的十几分钟，额度恰恰就是在那段时间里死的
  // （11-05 那轮：闸门绿，跑完才发现额度用完）。所以「开跑前那一刻通不通」
  // 必须单独测一次——前置闸门的结论不能替它作证。
  const p12b = runProviderProbe('P12b');
  if (!p12b.ok) {
    const m = p12b.measured ?? {};
    fail(probeFailureMessage('P12b', m, p12b) + '  这一轮不开跑。');
  }
  record(
    'P12b',
    true,
    `开跑前 provider 仍接得住一轮规模（${p12b.measured.approx_input_tokens} token / ${p12b.measured.elapsed_ms}ms，${probeVerdictNote(p12b.measured)}）`,
  );

  writeFileSync('/tmp/mc-cookie.txt', cookie);
  const agentStart = new Date().toISOString();
  // 提示词也分两套：合成夹具那份提到夹具自己的名词（订单端点、压测探针），
  // 真实靶子那份说的是「体检、告警、指标标签」，而且**不出现任何内部名字**。
  const promptFile = REAL_MODE
    ? 'incident/runs/diag-prompt-real.txt'
    : 'incident/runs/diag-prompt.txt';
  const ws = spawnSync(
    NODE,
    ['incident/runs/ws-run.mjs', WS_JID, promptFile, String(CAP_MS)],
    {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: CAP_MS + 180000,
    },
  );
  if (!ws.stdout || !ws.stdout.trim()) {
    // spawnSync 的字段是 stderr，不是 err。之前写成 ws.err，报错只剩一个
    // 「undefined」，把真正的失败原因（例如 provider 429）吞掉了。
    const why = [
      ws.stderr,
      ws.error?.message,
      ws.signal ? `signal=${ws.signal}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    // ws 的 stderr 只有「run_finished reason=…」这类表面现象。
    // 真实原因（例如 provider 429）只写在本轮的 session transcript 里，挖出来再报。
    // 挖不到也如实写进 manifest——「没挖到」不能装成「没有」。
    const dug = digAgentApiErrors(agentStart);
    if (dug.apiErrors?.length) {
      manifest.agent_api_errors = dug;
      const last = dug.apiErrors[dug.apiErrors.length - 1];
      const rateLimit = /429|rate.?limit|用量上限|quota/i.test(last.error);
      fail(
        `Agent 没有产出任何文本（exit ${ws.status}）。\n` +
          `ws-run stderr：\n${why || '（无）'}\n` +
          `transcript（${dug.transcript}）里有 ${dug.apiErrors.length} 条 API 错误，最后一条：\n` +
          `  ${last.error}\n` +
          (rateLimit
            ? `这是 provider 额度/限流问题，不是 Agent 也不是台子的问题——额度恢复前别再烧静默期。`
            : `transcript 里的错误不是额度类，逐条看过再决定这一轮算谁的。`),
      );
    }
    manifest.agent_api_errors = dug;
    fail(
      `Agent 没有产出任何文本（exit ${ws.status}）：\n${why || '（ws-run 没有输出，也没有 stderr）'}\n${dug.why ?? ''}`,
    );
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
        if (!transcript || statSync(p).mtimeMs > statSync(transcript).mtimeMs)
          transcript = p;
      }
    }
  }
  if (transcript) {
    const dest = join(
      OUT_DIR,
      'session-transcripts',
      transcript.split('/').pop(),
    );
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(transcript, dest);
    manifest.agent.transcript = dest;
    log(`  transcript 已收：${dest}`);
  }

  // 跑完后回查 transcript 里的额度类错误。
  //
  // 「Agent 出了报告」不等于「这一轮跑完了」：额度可以在跑到一半时耗尽，
  // 报告照样交上来——只是后半段是编的。11-05 那轮就是这么废的：
  // 闸门全绿、报告也有，但报告里混着额度耗尽之后的内容。
  // 这类轮次不能算 Agent 的成绩，也不能算台子的。
  const postRunErrors = digAgentApiErrors(agentStart);
  if (postRunErrors.apiErrors?.length) {
    manifest.agent_api_errors = postRunErrors;
    const quotaish = postRunErrors.apiErrors.filter((e) =>
      /429|quota|用量上限|rate.?limit|insufficient|余额/i.test(e.error),
    );
    if (quotaish.length) {
      invalidate(
        `provider 额度/限流在轮次中途报错（${quotaish.length} 条）：这一轮不是 Agent 的成绩`,
      );
      log(
        `  ⚠ transcript 里有 ${quotaish.length} 条额度类错误，这一轮作废（provider 的账，不是 Agent 的）`,
      );
    }
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
    // 真实靶子这一轮换一套证据面与答案键（工作区、日志目录、真值、启动规格）。
    // 不换的话，Agent 读到真值或故障旋钮，审计却判成 clean。
    const audit = sh(
      `${NODE} incident/runs/channel-audit.mjs ${transcript} --json` +
        (REAL_MODE
          ? ` --real --logs-dir ${PROFILE.measuredLogsDir ?? '/nonexistent'}`
          : ''),
    );
    try {
      manifest.channel_audit = JSON.parse(audit.out);
    } catch {
      manifest.channel_audit = {
        verdict: 'not_run',
        why: audit.err || audit.out || '审计脚本没产出可解析的结果',
      };
    }
    const ca = manifest.channel_audit;
    log(
      `  判定：${ca.verdict}（污染 ${ca.contaminating ?? '?'} 处｜越界 ${ca.out_of_surface ?? '?'} 处）`,
    );
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

  // 真值（答案键）。合成夹具的真值在仓库里（它是量具的一部分）；
  // 真实靶子的真值在**仓库外**——它写的是真实项目的故障机制，
  // 而仓库是公开的。
  const truthPath = REAL_MODE
    ? join(LAB_PATHS.realTruthDir, `${FAULT}.json`)
    : join(RUNS, 'ground-truth', `${FAULT}.json`);
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
      manifest.restore = {
        ok: true,
        at: new Date().toISOString(),
        ...(await spec.restore()),
      };
      // 恢复本身也是一次容器重建 → 也是一次部署观测。
      // 这一条用 soft：恢复已经成功了，写台账失败不能反过来把恢复说成失败，
      // 但整轮的部署证据缺了一条，要作废。
      recordDeployment('restore', { soft: true });
      log(
        '  已恢复公共静默态（缺陷在线、order 2 不在压测路径、超时旋钮 2000）',
      );
    } catch (err) {
      // 恢复失败不能改分数——分数已经在上面落盘了。
      // 但台子脏了，下一轮不能直接开跑，必须让 manifest 说清楚。
      manifest.restore = {
        ok: false,
        at: new Date().toISOString(),
        error: err.message,
        stack: err.stack,
      };
      invalidate(`恢复实验台失败：${err.message}`);
      log(`  ⚠ 恢复失败：${err.message}`);
    }
  }
  restoreDone = true;

  // 探针停在这一轮的最后：恢复过程本身要靠它把 5xx 比例等回 0，
  // 所以不能提前停。
  stopHealthProbe();

  manifest.finished_at = new Date().toISOString();
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));

  log(
    `  Root Cause Accuracy：${score.root_cause_accuracy}（tier=${score.accuracy_tier}）`,
  );
  log(
    `  发布归因：${score.deployment_attribution}（真值要求 ${score.deployment_expected}）`,
  );
  log(`  评分：${SCORE_PATH}`);
  log(`  manifest：${MANIFEST_PATH}`);
  if (!manifest.round_valid) log(`\n⚠ 本轮作废：${manifest.invalid_reason}\n`);
  log('');
}

main().catch(async (err) => {
  console.error(`\n✗ 本轮中止：${err.message}\n`);

  // 探针先停：它是我们自己起的流量，中止之后不该继续打靶子。
  stopHealthProbe();

  // 中止也要恢复实验台。否则故障留在台子上：下一轮的前置闸门会拦下来，
  // 但如果没人看 manifest，服务会一直 500、告警一直 firing。
  if (injected && !restoreDone && !NO_RESTORE && activeSpec) {
    try {
      manifest.restore = {
        ok: true,
        at: new Date().toISOString(),
        ...(await activeSpec.restore()),
      };
      recordDeployment('restore-abort', { soft: true });
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
      const res = await fetchRetry(
        `${MINICLAW}/api/groups/${encodeURIComponent(WS_JID)}/stop`,
        {
          method: 'POST',
          headers: { Cookie: cookie },
        },
      );
      manifest.abort_stop = { status: res.status };
    } catch (stopErr) {
      manifest.abort_stop = { error: stopErr.message };
    }
  }

  manifest.finished_at = new Date().toISOString();
  manifest.aborted = err.message;
  manifest.aborted_stack = err.stack;
  manifest.round_valid = false;
  manifest.invalid_reason =
    manifest.invalid_reason ?? `本轮中止：${err.message}`;
  try {
    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
    console.error(`  manifest：${MANIFEST_PATH}`);
  } catch {
    /* manifest 也写不下去就没别的办法了 */
  }
  process.exit(1);
});
