#!/usr/bin/env node
/**
 * provider 探针（P12 / P12b）的控制脚本。
 *
 * 这条闸门问的是「provider 接不接得住一轮规模的上下文」。它值不值钱，
 * 全看判据是不是**非恒真**的：
 *
 *   - 只看 HTTP 200 的话，平台只要肯收请求就放行，探针什么都没证明。
 *     2026-11-06 09:10Z 那次实测就是 206KB 载荷只报 input_tokens=81。
 *   - 只看「探针自己说成功」的话，探针把失败吞掉，闸门照样绿。
 *
 * 所以这里把判据拆成能被证伪的几条，逐条钉死：
 *
 *   1. 探针失败 → 闸门判失败；探针通过 → 闸门判通过（**成对**出现，
 *      缺一条就等于没测）。
 *   2. 429 必须归成额度/限流，不能归成别的；同时要用近邻输入（401、500）
 *      做负对照，证明这个分类不是「什么都归额度」。
 *   3. 载荷没被回显 → 探针判失败（不是只看 HTTP 200）。
 *   4. 上下文变大 → 估算值变大。
 *   5. 探针的认证头必须和真实 Agent 路径一致（同一把钥匙开同一扇门）。
 *   6. 探针的输出不许带出凭据 / endpoint / 模型名 / 回复原文。
 *
 * 全程**不依赖真实网络、不花钱**：探针真正跑起来，但它的 HTTP 调用被一个
 * 本地假 provider 顶掉了（`--import` 注入的 fetch 替身）。替身会照着载荷里
 * 的标记回显，所以「载荷被吃进去了」这条判据在离线的情况下也是真的被执行，
 * 不是被跳过。
 *
 * 从仓库根目录跑：
 *     node incident/runs/provider-probe-control.mjs
 */

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const RUNS = join(ROOT, 'incident', 'runs');
const PROBE_SRC = join(RUNS, 'provider-probe.ts');
const ROUND_SRC = join(RUNS, 'run-round.mjs');
const AGENT_AUTH_SRC = join(
  ROOT,
  'container',
  'agent-runner',
  'src',
  'pi-index.ts',
);

/**
 * 假 provider：把探针的 fetch 顶掉。
 *
 * 只拦 `/v1/messages`（provider 协议端点），其它请求（Miniclaw 自己的 API）
 * 原样放行，所以 `--dry-run` 里的服务在线检查不受影响。
 *
 * 它会从收到的载荷里把标记抠出来回显——所以「模型确实读到了载荷末尾」
 * 这条判据在离线环境下也是真的跑过了，而不是被跳过。
 */
const FAKE_FETCH_SOURCE = `
import { writeFileSync } from 'node:fs';

const original = globalThis.fetch;
const status = Number(process.env.FAKE_PROVIDER_STATUS || '200');
const mode = process.env.FAKE_PROVIDER_MODE || 'echo';
const capturePath = process.env.FAKE_PROVIDER_CAPTURE || '';

// 请求序号：探针自查重试时会发第二次请求，替身要能分辨第几次。
let callIndex = 0;
const requests = [];

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : String((input && input.url) || input);
  if (!/\\/v1\\/messages(\\?|$)/.test(url)) return original(input, init);

  const raw = typeof init.body === 'string' ? init.body : '';
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  let prompt = '';
  if (parsed && Array.isArray(parsed.messages)) {
    prompt = parsed.messages
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\\n');
  }
  const head = (prompt.match(/PAYLOAD-HEAD-([0-9A-F]+)/i) || [])[1] || null;
  const end = (prompt.match(/PAYLOAD-END-\\d+-([0-9A-F]+)/i) || [])[1] || null;

  const headerNames = Object.keys(init.headers || {}).map((h) => h.toLowerCase()).sort();
  callIndex += 1;
  const thisCall = callIndex;
  const record = {
    call: thisCall,
    url_path: new URL(url).pathname,
    method: init.method || 'POST',
    body_bytes: Buffer.byteLength(raw, 'utf8'),
    header_names: headerNames,
    auth_header: headerNames.includes('x-api-key')
      ? 'x-api-key'
      : headerNames.includes('authorization')
        ? 'authorization'
        : null,
    head_marker_found: Boolean(head),
    end_marker_found: Boolean(end),
    max_tokens: parsed && typeof parsed.max_tokens === 'number' ? parsed.max_tokens : null,
  };
  requests.push(record);
  if (capturePath) {
    writeFileSync(
      capturePath,
      JSON.stringify({ ...record, request_count: requests.length, requests }),
    );
  }

  if (mode === 'throw') {
    throw new Error(
      'fetch failed for ' + url + ' (key=sk-control-must-never-be-logged)',
    );
  }

  let reply = '';
  if (mode === 'echo') reply = 'PAYLOAD-END-' + (end || '');
  else if (mode === 'head-only') reply = 'PAYLOAD-HEAD-' + (head || '');
  else if (mode === 'wrong') reply = 'PAYLOAD-END-000000000000';
  else if (mode === 'empty') reply = '';

  // stop_reason='max_tokens' 模拟「探针自己的输出预算用完了」。
  // 这和「平台截断了上下文」是两回事：前者是探针的锅，后者才是 provider 的锅。
  //
  // 'budget-then-echo'：第一次预算用尽、第二次正常回显——模拟「探针自查重试
  // 之后真的量到了」，用来证明重试这条路真的通。
  // 'budget-then-budget'：两次都预算用尽——重试救不回来，必须仍然判失败。
  let stopReason = 'end_turn';
  if (mode === 'budget' || mode === 'budget-then-budget') {
    stopReason = 'max_tokens';
    reply = '';
  } else if (mode === 'budget-then-echo') {
    if (thisCall === 1) {
      stopReason = 'max_tokens';
      reply = '';
    } else {
      reply = 'PAYLOAD-END-' + (end || '');
    }
  }

  const body = JSON.stringify({
    id: 'msg_control',
    type: 'message',
    role: 'assistant',
    stop_reason: stopReason,
    content: [{ type: 'text', text: reply }],
    usage: { input_tokens: 12345, output_tokens: 8 },
  });
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json' },
  });
};
`;

// ---------------------------------------------------------------------------
// 断言脚手架
// ---------------------------------------------------------------------------

const cases = [];
let failed = 0;

function check(name, ok, detail) {
  cases.push({ name, ok: Boolean(ok), detail: String(detail) });
  if (!ok) failed += 1;
}

/**
 * 闸门的判据。必须和 run-round.mjs 里 `runProviderProbe()` 用的一致——
 * 那边的写法是 `Boolean(measured && measured.completed === true)`。
 * 下面的「接线」那条用例会核对源码里的判据没变。
 */
function gateVerdict(measured) {
  return Boolean(measured && measured.completed === true);
}

const tmpRoot = mkdtempSync(join(tmpdir(), 'p12-control-'));
const fakePath = join(tmpRoot, 'fake-provider-fetch.mjs');
writeFileSync(fakePath, FAKE_FETCH_SOURCE);

let captureSeq = 0;
const tempRepoDirs = [];

function cleanup() {
  for (const dir of [tmpRoot, ...tempRepoDirs]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      // 清理失败要说出来：不然仓库里会留下没人认领的临时目录。
      process.stderr.write(`清理临时目录失败 ${dir}: ${err.message}\n`);
    }
  }
}
process.on('exit', cleanup);

const NODE_OPTIONS = [
  process.env.NODE_OPTIONS || '',
  `--import ${pathToFileURL(fakePath).href}`,
]
  .join(' ')
  .trim();

/**
 * 真跑一次探针（HTTP 被假 provider 顶掉）。
 */
function runProbe({
  probePath = PROBE_SRC,
  status = 200,
  mode = 'echo',
  cwd = ROOT,
  timeout = 120000,
} = {}) {
  const capturePath = join(tmpRoot, `capture-${captureSeq++}.json`);
  const r = spawnSync(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', probePath],
    {
      cwd,
      encoding: 'utf8',
      timeout,
      env: {
        ...process.env,
        NODE_OPTIONS,
        FAKE_PROVIDER_STATUS: String(status),
        FAKE_PROVIDER_MODE: mode,
        FAKE_PROVIDER_CAPTURE: capturePath,
      },
    },
  );
  let measured = null;
  try {
    measured = JSON.parse(r.stdout);
  } catch {
    measured = null;
  }
  let capture = null;
  try {
    capture = JSON.parse(readFileSync(capturePath, 'utf8'));
  } catch {
    capture = null;
  }
  return {
    code: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    measured,
    capture,
  };
}

/**
 * 造一份「上下文更大/更小」的探针副本。
 *
 * 副本必须放在仓库里（离 src/ 两级），探针里的 `../../src/...` 才解析得到；
 * 放在仓库里也意味着它量的就是同一套代码，不是另写一份。
 * 副本旁边放一个伪造的 transcript，用它的字节数来定「这一轮多大」。
 */
function makeProbeCopy(contextBytes) {
  const dir = join(
    ROOT,
    'incident',
    `.p12-control-${process.pid}-${contextBytes}`,
  );
  mkdirSync(join(dir, 'session-transcripts'), { recursive: true });
  copyFileSync(PROBE_SRC, join(dir, 'probe.ts'));
  writeFileSync(
    join(dir, 'session-transcripts', 'context.jsonl'),
    Buffer.alloc(contextBytes, 0x61),
  );
  tempRepoDirs.push(dir);
  return join(dir, 'probe.ts');
}

// ---------------------------------------------------------------------------
// 1. 探针通过 → 闸门判通过
// ---------------------------------------------------------------------------

const passRun = runProbe({ status: 200, mode: 'echo' });
check(
  '探针通过 → 闸门判通过',
  passRun.code === 0 &&
    passRun.measured?.completed === true &&
    gateVerdict(passRun.measured) === true,
  `exit=${passRun.code} completed=${passRun.measured?.completed} channel=${passRun.measured?.channel}`,
);

// ---------------------------------------------------------------------------
// 2. 探针失败 → 闸门判失败
// ---------------------------------------------------------------------------

const failRun = runProbe({ status: 429, mode: 'echo' });
check(
  '探针失败 → 闸门判失败',
  failRun.code !== 0 &&
    failRun.measured?.completed !== true &&
    gateVerdict(failRun.measured) === false,
  `exit=${failRun.code} completed=${failRun.measured?.completed} failure_class=${failRun.measured?.failure_class}`,
);

// ---------------------------------------------------------------------------
// 3. 上面两条必须成对：同一判据下，通过与失败各判一次
// ---------------------------------------------------------------------------

check(
  '判据成对：通过与失败各判一次（缺一条等于没测）',
  gateVerdict(passRun.measured) === true &&
    gateVerdict(failRun.measured) === false,
  `通过判成 ${gateVerdict(passRun.measured)}；失败判成 ${gateVerdict(failRun.measured)}`,
);

// ---------------------------------------------------------------------------
// 4-6. 失败分类：429 是额度；401 是鉴权；500 是 provider 故障
//    （后两条是近邻负对照：证明 429 的分类不是「什么都归额度」）
// ---------------------------------------------------------------------------

check(
  '429 归类成额度/限流（不是别的错误）',
  failRun.measured?.failure_class === 'quota_or_rate_limit',
  `failure_class=${failRun.measured?.failure_class}`,
);

const authRun = runProbe({ status: 401, mode: 'echo' });
check(
  '近邻负对照：401 归类成鉴权，不是额度',
  authRun.measured?.failure_class === 'auth' &&
    authRun.measured?.failure_class !== 'quota_or_rate_limit' &&
    gateVerdict(authRun.measured) === false,
  `failure_class=${authRun.measured?.failure_class} exit=${authRun.code}`,
);

const serverRun = runProbe({ status: 500, mode: 'echo' });
check(
  '近邻负对照：500 归类成 provider 故障，不是额度',
  serverRun.measured?.failure_class === 'provider_error' &&
    serverRun.measured?.failure_class !== 'quota_or_rate_limit' &&
    gateVerdict(serverRun.measured) === false,
  `failure_class=${serverRun.measured?.failure_class} exit=${serverRun.code}`,
);

// ---------------------------------------------------------------------------
// 7-8. 载荷没被吃进去 → 探针必须判失败（判据不是恒真的）
// ---------------------------------------------------------------------------

const wrongRun = runProbe({ status: 200, mode: 'wrong' });
check(
  '载荷没被回显 → 探针判失败（不是只看 HTTP 200）',
  wrongRun.code !== 0 &&
    wrongRun.measured?.completed === false &&
    wrongRun.measured?.failure_class === 'payload_not_echoed' &&
    gateVerdict(wrongRun.measured) === false,
  `exit=${wrongRun.code} completed=${wrongRun.measured?.completed} failure_class=${wrongRun.measured?.failure_class}`,
);

const partialRun = runProbe({ status: 200, mode: 'head-only' });
check(
  '只回显了载荷开头 → 判成截断，不是通过',
  partialRun.code !== 0 &&
    partialRun.measured?.completed === false &&
    partialRun.measured?.failure_class === 'payload_truncated' &&
    gateVerdict(partialRun.measured) === false,
  `exit=${partialRun.code} failure_class=${partialRun.measured?.failure_class}`,
);

// 近邻负对照：同样「没有回显」，但两种原因必须分开报。
// 2026-11-06 实测踩过：模型的 thinking token 吃光了探针自己的 max_tokens
// （64），回复里没有标记 → 探针报 payload_not_echoed → 闸门把一个
// provider 完全接得住的轮次拦下来（假阴性）。所以「探针自己没预算了」
// 必须单独成一类，不能算成 provider 的锅。
const budgetRun = runProbe({ status: 200, mode: 'budget' });
check(
  '探针自己的输出预算用完 → 归成 probe_output_truncated，不是 payload_not_echoed',
  budgetRun.code !== 0 &&
    budgetRun.measured?.completed === false &&
    budgetRun.measured?.failure_class === 'probe_output_truncated' &&
    budgetRun.measured?.failure_class !== 'payload_not_echoed' &&
    gateVerdict(budgetRun.measured) === false,
  `exit=${budgetRun.code} stop_reason=${budgetRun.measured?.stop_reason} failure_class=${budgetRun.measured?.failure_class}`,
);

check(
  '近邻负对照：同样没回显但 stop_reason 正常 → 归成 payload_not_echoed',
  wrongRun.measured?.stop_reason === 'end_turn' &&
    wrongRun.measured?.failure_class === 'payload_not_echoed',
  `stop_reason=${wrongRun.measured?.stop_reason} failure_class=${wrongRun.measured?.failure_class}`,
);

// ---------------------------------------------------------------------------
// 8b. 探针自查重试：自己的输出预算用完了，换个更大的预算再问一次
//
// 这一条存在的理由是 2026-11-06 那次**假阴性**：模型思考 token 吃光了探针
// 自己的 max_tokens，回复里没有标记，探针就把一个 provider 完全接得住的
// 轮次拦在了门外。现在探针遇到 stop_reason=max_tokens 会自查重试。
//
// 判据分两面，缺一不可：
//   - 正向：重试之后真的量到了 → completed=true，且记录了重试这件事。
//   - 近邻负对照：重试**也**预算用尽 → 仍然必须判失败，不能因为「重试过」
//     就放行。
// ---------------------------------------------------------------------------

const retryRun = runProbe({ status: 200, mode: 'budget-then-echo' });
const retryRequests = retryRun.capture?.requests ?? [];
check(
  '探针自查重试：第一次预算用尽 → 换更大预算重试 → 判通过',
  retryRun.code === 0 &&
    retryRun.measured?.completed === true &&
    gateVerdict(retryRun.measured) === true &&
    retryRun.measured?.probe_retry?.reason ===
      'probe_output_budget_exhausted' &&
    retryRequests.length === 2 &&
    Number(retryRequests[1]?.max_tokens) > Number(retryRequests[0]?.max_tokens),
  `exit=${retryRun.code} completed=${retryRun.measured?.completed} 请求 ${retryRequests.length} 次，` +
    `max_tokens ${retryRequests[0]?.max_tokens}→${retryRequests[1]?.max_tokens}；` +
    `probe_retry=${JSON.stringify(retryRun.measured?.probe_retry ?? null)}`,
);

const retryFailRun = runProbe({ status: 200, mode: 'budget-then-budget' });
const retryFailRequests = retryFailRun.capture?.requests ?? [];
check(
  '近邻负对照：重试仍然预算用尽 → 仍判失败，且分类仍是 probe_output_truncated',
  retryFailRun.code !== 0 &&
    retryFailRun.measured?.completed === false &&
    retryFailRun.measured?.failure_class === 'probe_output_truncated' &&
    retryFailRun.measured?.failure_class !== 'payload_not_echoed' &&
    gateVerdict(retryFailRun.measured) === false &&
    retryFailRequests.length === 2,
  `exit=${retryFailRun.code} failure_class=${retryFailRun.measured?.failure_class} ` +
    `stop_reason=${retryFailRun.measured?.stop_reason} 请求 ${retryFailRequests.length} 次`,
);

check(
  '探针自查重试：没发生重试时不留下 probe_retry（否则记录会骗人）',
  passRun.measured?.probe_retry === undefined &&
    wrongRun.measured?.probe_retry === undefined,
  `通过那次 probe_retry=${JSON.stringify(passRun.measured?.probe_retry ?? null)}`,
);

// ---------------------------------------------------------------------------
// 9. 估算随上下文变大而变大
// ---------------------------------------------------------------------------

const smallRun = runProbe({ probePath: makeProbeCopy(40 * 1024) });
const largeRun = runProbe({ probePath: makeProbeCopy(160 * 1024) });
const smallTokens = smallRun.measured?.approx_input_tokens ?? 0;
const largeTokens = largeRun.measured?.approx_input_tokens ?? 0;
check(
  '估算逻辑：上下文变大 → 估算值变大',
  smallRun.code === 0 &&
    largeRun.code === 0 &&
    largeTokens > smallTokens &&
    smallTokens === Math.round((40 * 1024) / 4) &&
    largeTokens === Math.round((160 * 1024) / 4),
  `40KB→${smallTokens} token；160KB→${largeTokens} token`,
);

check(
  '估算有出处（量的是归档 transcript，不是默认规模）',
  String(smallRun.measured?.reference_round_source ?? '').includes(
    'transcript',
  ) &&
    String(largeRun.measured?.reference_round_source ?? '').includes(
      'transcript',
    ),
  `source=${smallRun.measured?.reference_round_source}`,
);

// ---------------------------------------------------------------------------
// 10. 探针真的把那一份轮次规模的载荷发出去了
//     （估算写进了 manifest，但请求本身缩了，这条要挡住）
// ---------------------------------------------------------------------------

check(
  '请求真的带上了轮次规模的载荷（估算不是空账）',
  Boolean(passRun.capture) &&
    passRun.capture.body_bytes >= passRun.measured?.payload_bytes &&
    // JSON 信封 + 换行转义会让请求体略大于载荷本身，但不会大出一个量级。
    passRun.capture.body_bytes <=
      (passRun.measured?.payload_bytes ?? 0) * 1.2 &&
    passRun.capture.end_marker_found === true,
  `请求体 ${passRun.capture?.body_bytes} 字节 / 载荷 ${passRun.measured?.payload_bytes} 字节（差的是 JSON 信封与转义）`,
);

// ---------------------------------------------------------------------------
// 11. 认证头必须和真实 Agent 路径一致
// ---------------------------------------------------------------------------

const agentAuthSrc = readFileSync(AGENT_AUTH_SRC, 'utf8');
const agentUsesApiKey = /apiKey:\s*process\.env\.ANTHROPIC_API_KEY/.test(
  agentAuthSrc,
);
const expectedAuthHeader = agentUsesApiKey ? 'x-api-key' : 'authorization';
check(
  '探针的认证头和真实 Agent 路径一致（同一把钥匙开同一扇门）',
  passRun.capture?.auth_header === expectedAuthHeader &&
    !(passRun.capture?.header_names ?? []).includes(
      expectedAuthHeader === 'x-api-key' ? 'authorization' : 'x-api-key',
    ),
  `Agent 路径用 ${expectedAuthHeader}；探针发出 ${passRun.capture?.auth_header}`,
);

// ---------------------------------------------------------------------------
// 12. 网络异常时，错误文本不许带出 URL 或凭据
// ---------------------------------------------------------------------------

const throwRun = runProbe({ status: 200, mode: 'throw' });
check(
  '网络异常：错误文本不带出 URL / 凭据',
  throwRun.code !== 0 &&
    throwRun.measured?.failure_class === 'network' &&
    !/https?:\/\//i.test(String(throwRun.measured?.why ?? '')) &&
    !/sk-[A-Za-z0-9]{6,}/.test(String(throwRun.measured?.why ?? '')) &&
    !/https?:\/\//i.test(throwRun.stdout),
  `failure_class=${throwRun.measured?.failure_class} why=${throwRun.measured?.why}`,
);

// ---------------------------------------------------------------------------
// 13. 探针的输出不许带出凭据 / endpoint / 模型名
// ---------------------------------------------------------------------------

const measuredEntries = Object.entries(passRun.measured ?? {});
const leakyKey = measuredEntries.find(([k]) =>
  /(api_?key|secret|password|authorization|endpoint|base_?url|credential)/i.test(
    k,
  ),
);
const leakyValue = measuredEntries.find(
  ([, v]) =>
    typeof v === 'string' &&
    (/https?:\/\//i.test(v) ||
      /bearer\s/i.test(v) ||
      /sk-[A-Za-z0-9]{6,}/.test(v)),
);
check(
  '探针输出不带出凭据 / endpoint / 模型名 / 回复原文',
  !leakyKey &&
    !leakyValue &&
    !/bearer\s/i.test(passRun.stdout) &&
    !/sk-[A-Za-z0-9]{6,}/.test(passRun.stdout),
  leakyKey
    ? `字段名 ${leakyKey[0]}`
    : leakyValue
      ? `字段 ${leakyValue[0]} 的值像凭据/地址`
      : `共 ${measuredEntries.length} 个字段，都干净`,
);

// ---------------------------------------------------------------------------
// 14. 闸门接线：run-round.mjs 还是按这个契约消费探针结果
// ---------------------------------------------------------------------------

const roundSrc = readFileSync(ROUND_SRC, 'utf8');
const wiring = [
  ['调用探针', 'incident/runs/provider-probe.ts'],
  ['判据是 completed === true', 'measured.completed === true'],
  ['结果写进 manifest.provider_probes', 'provider_probes'],
  ['开跑前再探一次', "runProviderProbe('P12b')"],
  ['中途额度错误判轮次无效', 'invalidate('],
];
const missingWiring = wiring.filter(([, needle]) => !roundSrc.includes(needle));
check(
  '闸门接线：run-round.mjs 仍按探针契约消费结果',
  missingWiring.length === 0,
  missingWiring.length === 0
    ? `契约项 ${wiring.length} 条都在`
    : `缺：${missingWiring.map(([n]) => n).join('、')}`,
);

// ---------------------------------------------------------------------------
// 14b. 两类截断的判据要在**两处**都成立
//
// P12（前置）和 P12b（开跑前）跑的是同一个探针，但只有一处记 stop_reason
// 的话，开跑前那次仍然可能假阴性——判据漏了一半，闸门还是会在「探针自己的
// 预算用完了」这一档上误判。所以两处的记录里都必须带上 stop_reason。
//
// 这条只查源码里的接线，所以配一条近邻正对照：那个把 stop_reason 写进记录
// 的辅助函数必须真的产出 stop_reason 字样（不然一个空壳函数也能蒙混过去）。
// ---------------------------------------------------------------------------

const p12HasVerdict = roundSrc.includes('probeVerdictNote(p12.measured)');
const p12bHasVerdict = roundSrc.includes('probeVerdictNote(p12b.measured)');
const verdictHelperEmitsStopReason =
  /function probeVerdictNote[\s\S]{0,600}stop_reason/.test(roundSrc);
check(
  'P12 与 P12b 两处的记录都带 stop_reason（判据不能在只落在一处）',
  p12HasVerdict && p12bHasVerdict && verdictHelperEmitsStopReason,
  `P12=${p12HasVerdict} P12b=${p12bHasVerdict} 辅助函数真的产出 stop_reason=${verdictHelperEmitsStopReason}`,
);

const probeSrcText = readFileSync(PROBE_SRC, 'utf8');
const retryContract =
  /PROBE_RETRY_MAX_TOKENS/.test(probeSrcText) &&
  /stop_reason === 'max_tokens'/.test(probeSrcText) &&
  /probe_retry/.test(probeSrcText);
check(
  '探针自己带着自查重试（重试这件事必须留在输出里，不能悄悄发生）',
  retryContract,
  `PROBE_RETRY_MAX_TOKENS=${/PROBE_RETRY_MAX_TOKENS/.test(probeSrcText)} ` +
    `触发条件=${/stop_reason === 'max_tokens'/.test(probeSrcText)} ` +
    `输出字段=${/probe_retry/.test(probeSrcText)}`,
);

// ---------------------------------------------------------------------------
// 15. 端到端：--dry-run 里 P12 真的把估算写进了 manifest
//     （需要实验台在跑：容器、服务、工作区都在）
// ---------------------------------------------------------------------------

const manifestBefore = new Set(
  readdirSync(RUNS).filter((f) => f.startsWith('round-manifest-')),
);

/**
 * 「真轮次不会被误标成 dry-run」的正对照怎么查。
 *
 * 归档的老 manifest 是在 `dry_run` 字段存在之前写的，它们本来就没有这个
 * 字段——拿它们断言 `dry_run !== true` 是**恒真**的，等于没测。
 * 所以这条对照改为核对源码：manifest 建的时候必须按 `--dry-run` 这个开关
 * 如实写（真轮次 → false，dry-run → true），而不是等跑完再补。
 *
 * 为什么改成「建的时候写」：dry-run 中途失败走的是中止分支，补写的代码
 * 根本执行不到，留下的 manifest 就自称不是 dry-run——实测踩过这个形状。
 */
function realRoundsStayUnmarked() {
  const src = readFileSync(ROUND_SRC, 'utf8');
  const literal = /dry_run:\s*DRY_RUN/.test(src);
  const flagDerived = /const DRY_RUN = flag\('--dry-run'\)/.test(src);
  const setters = (src.match(/manifest\.dry_run\s*=\s*true/g) || []).length;
  return { literal, flagDerived, setters };
}
const dryRun = spawnSync(
  process.execPath,
  ['incident/runs/run-round.mjs', '--dry-run'],
  {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 600000,
    env: { ...process.env, NODE_OPTIONS },
  },
);
const newManifests = readdirSync(RUNS).filter(
  (f) => f.startsWith('round-manifest-') && !manifestBefore.has(f),
);
let dryManifest = null;
let dryManifestFile = null;
const removedManifests = [];
for (const f of newManifests) {
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(join(RUNS, f), 'utf8'));
  } catch {
    parsed = null;
  }
  if (!parsed) continue;
  dryManifest = parsed;
  dryManifestFile = f;
  // 清理这一轮 dry-run 的产物。判据用 manifest **自己声明的** `dry_run` 标志，
  // 不再靠「setup/agent 都是 null」这种形状猜——形状是间接证据，标志是自述。
  // 真正跑起来的轮次 `dry_run` 是 false，不会被命中。
  if (parsed.dry_run === true) {
    rmSync(join(RUNS, f), { force: true });
    removedManifests.push(f);
  }
}
const dryP12 = (dryManifest?.preflight ?? []).find((p) => p.id === 'P12');
const dryProbe = (dryManifest?.provider_probes ?? [])[0];
check(
  '端到端：--dry-run 的 P12 把估算写进了 manifest.provider_probes',
  Boolean(dryP12) &&
    dryP12.ok === true &&
    Boolean(dryProbe) &&
    Number(dryProbe.measured?.approx_input_tokens) > 0 &&
    Number(dryProbe.measured?.payload_bytes) > 0,
  dryManifest
    ? `P12 ok=${dryP12?.ok}；provider_probes[0].measured.approx_input_tokens=${dryProbe?.measured?.approx_input_tokens}；aborted=${dryManifest.aborted ?? '无'}；已清理 dry-run manifest：${removedManifests.join('、') || '无'}`
    : `没拿到新 manifest（退出码 ${dryRun.status}；stdout 末尾：${(dryRun.stdout || '').slice(-200)}）`,
);

// dry-run 不是一轮成绩，manifest 必须自己说清楚。
// 2026-11-06 的 0910Z 就是反例：agent/score 全是 null，`round_valid` 却是 true，
// 这份文件读起来像「一轮跑完了而且有效」。闸门绿 ≠ 整轮可跑，这条断言就是钉它。
check(
  'dry-run 的 manifest 自述「不是一轮成绩」（dry_run=true 且 round_valid=false）',
  dryManifest?.dry_run === true &&
    dryManifest?.round_valid === false &&
    /dry-run/.test(String(dryManifest?.invalid_reason ?? '')),
  `dry_run=${dryManifest?.dry_run} round_valid=${dryManifest?.round_valid} invalid_reason=${String(dryManifest?.invalid_reason ?? '').slice(0, 60)}`,
);
check(
  '近邻正对照：真跑的轮次不会被打上 dry_run=true（建 manifest 时就按 --dry-run 如实写）',
  realRoundsStayUnmarked().literal &&
    realRoundsStayUnmarked().flagDerived &&
    realRoundsStayUnmarked().setters === 1,
  `manifest 字面量按开关写 = ${realRoundsStayUnmarked().literal}；` +
    `开关来自 --dry-run = ${realRoundsStayUnmarked().flagDerived}；` +
    `后补置 true 的地方 ${realRoundsStayUnmarked().setters} 处`,
);

// 归档的 manifest 必须**按字段**能判出是不是 dry-run，不能靠读源码字面量。
// 那些文件是在 `dry_run` 字段存在之前写的，补上 false 之后，检查就能落在
// 数据本身：一份归档 manifest 缺这个字段，就说明它还没被补齐——那是缺陷，
// 不是「无关紧要的历史」。
const archivedManifests = readdirSync(RUNS).filter((f) =>
  /^round-manifest-.*\.json$/.test(f),
);
const archivedDryRunFlags = archivedManifests.map((f) => {
  try {
    const parsed = JSON.parse(readFileSync(join(RUNS, f), 'utf8'));
    return { f, has: 'dry_run' in parsed, value: parsed.dry_run };
  } catch {
    return { f, has: false, value: null, broken: true };
  }
});
const archivedMissing = archivedDryRunFlags
  .filter((x) => !x.has)
  .map((x) => x.f);
const archivedTrue = archivedDryRunFlags
  .filter((x) => x.value === true)
  .map((x) => x.f);
check(
  '归档的 manifest 都带 dry_run 字段，且全是 false（按字段就能判，不必读源码）',
  archivedManifests.length > 0 &&
    archivedMissing.length === 0 &&
    archivedTrue.length === 0,
  `归档 ${archivedManifests.length} 份；缺字段 ${archivedMissing.length} 份` +
    `${archivedMissing.length ? '（' + archivedMissing.join('、') + '）' : ''}；` +
    `标成 true 的 ${archivedTrue.length} 份`,
);

// 清理判据必须能真的命中：否则上面的断言只在「恰好没清掉」时成立。
check(
  'dry-run 的 manifest 确实按 dry_run 标志被识别并清理',
  removedManifests.length === 1,
  `清理了 ${removedManifests.length} 份：${removedManifests.join('、') || '（无）'}`,
);

// ---------------------------------------------------------------------------

for (const c of cases) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  [${c.detail}]`);
}
console.log(`\n${cases.length - failed}/${cases.length} 通过`);

if (failed > 0) process.exit(1);
