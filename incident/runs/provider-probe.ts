/**
 * 轮次规模的 provider 探测。
 *
 * 为什么不是「回一句 MINICLAW_REAL_SMOKE_OK」那种小请求：
 * 小请求通过 ≠ 这一轮能跑完。额度类故障的形状恰恰是「小请求还通，大请求不通」
 * 或者「开跑时通、跑到一半不通」——2026-11-05 那轮就撞在这上面：闸门全绿，
 * 轮次跑完才发现额度用完了。那一轮的数不能算 Agent 的，也不能算台子的。
 *
 * 所以探测的规模按**一轮的一次完整上下文**来。它回答的问题是
 * 「provider 接得住一轮的上下文吗」，不是「provider 活着吗」——这两个问题
 * 不一样，闸门以前问的是后者。
 *
 * 探测体是**本地合成的**：只用仓库里的诊断 prompt 量一下真实一轮有多大，
 * 再合成同样量级的载荷发出去。不发任何项目内容：探测要证明的是「额度/
 * 限流在这一轮规模下通得过」，不是「把这些内容再发一遍」——Agent 自己会发它
 * 真正要读的那些东西。
 *
 * 探测**不能**承诺「额度够跑完整轮」——provider 没有额度查询接口
 * （/key/info、/health、/model/info 都返回 401，实测过）。所以它的结论只到
 * 「接得住一轮的上下文」为止；整轮能不能跑完，靠开跑前再探一次（P12b）
 * 和跑完后的 transcript 复查（额度类错误一律算 provider 的账）。
 *
 * 判据不能只看 HTTP 200。平台只要回 200 就放行的话，探针证明不了
 * 「那一轮规模真的被吃进去了」——2026-11-06 09:10Z 那次实测就是 206KB 载荷
 * 只报 input_tokens=81。所以载荷里埋两个一次性标记，要求回复回显尾部标记：
 * 回显了才说明整份载荷真的读到了末尾。
 *
 * 输出只有测量值和分类结论，不吐 endpoint / 模型名 / 凭据 / 回复原文。
 */
import '../../src/load-env.js';

import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getClaudeProviderConfig } from '../../src/runtime-config.js';
import { sdkQuery } from '../../src/sdk-query.js';

/**
 * 载荷里的两个一次性标记。
 *
 * - HEAD 标记埋在载荷开头，用来分辨「整份载荷都进去了」和「只有开头进去了」
 *   （后者说明平台截断了上下文，那么「接得住一轮」就是假的）。
 * - END 标记埋在载荷末尾，并要求模型回显它——回显尾标 = 载荷真的读到了末尾。
 *
 * 每次运行都换新的（随机），所以回复不可能是缓存里的旧答案。
 */
const NONCES = {
  head: randomBytes(6).toString('hex').toUpperCase(),
  end: randomBytes(6).toString('hex').toUpperCase(),
};

const QUESTION =
  '载荷最后一行是 PAYLOAD-END-<字节数>-<标记>。请只回答 PAYLOAD-END- 后面那串大写字母和数字，不要解释。';

/**
 * 「一轮的规模」怎么量：不猜，取**上一轮实际发生过的事**。
 *
 * 归档的 session transcript 就是一轮 Agent 全部对话的字节数——那就是这一轮
 * 真正送进 provider 的量级（实测 200KB 上下，约 5 万 token）。用合成载荷
 * 复现这个规模，问 provider 接不接得住。
 *
 * 没有归档可依时退回 64KB：宁可标成「按默认规模探测」，也不要假装量到了。
 */
const TRANSCRIPT_DIR = new URL('./session-transcripts/', import.meta.url);
const DEFAULT_ROUND_BYTES = 64 * 1024;

function measuredRoundBytes(): { bytes: number; source: string } {
  try {
    const dir = fileURLToPath(TRANSCRIPT_DIR);
    if (existsSync(dir)) {
      const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
      if (files.length > 0) {
        const newest = files
          .map((f) => join(dir, f))
          .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
        return { bytes: statSync(newest).size, source: '上一轮的 transcript' };
      }
    }
  } catch {
    /* 量不到就退回默认 */
  }
  return {
    bytes: DEFAULT_ROUND_BYTES,
    source: '默认规模（没有归档 transcript 可量）',
  };
}

/**
 * 合成载荷：可复现、无项目内容、长度可控。
 *
 * 内容是什么不重要——额度与限流看的是输入规模，不是内容。但标记的位置重要：
 * 尾标必须在**最后**，因为「读到了末尾」才是我们想验的那件事。
 */
function syntheticPayload(bytes: number): string {
  const head =
    '以下是诊断任务的上下文片段（合成载荷，用于测量 provider 在一轮规模下的行为）。\n' +
    `PAYLOAD-HEAD-${NONCES.head}\n`;
  const tail = `\nPAYLOAD-END-${bytes}-${NONCES.end}\n`;
  const fillerUnit =
    'timestamp=2026-11-06T09:00:00Z level=INFO service=orders requestId=00000000 latencyMs=12 status=200\n';
  const needed = Math.max(0, bytes - head.length - tail.length);
  const repeats = Math.ceil(needed / fillerUnit.length);
  return head + fillerUnit.repeat(repeats).slice(0, needed) + tail;
}

/**
 * 把 provider 的失败分类。
 *
 * 只返回类别，不返回原文：上游的错误消息可能带 endpoint、账号、余额等东西，
 * 这些不该进日志，更不该进 manifest。
 */
function classify(status: number, body: string): string {
  const text = body.toLowerCase();
  if (
    status === 429 ||
    /quota|用量上限|insufficient|balance|exceeded your current quota|rate.?limit/.test(
      text,
    )
  )
    return 'quota_or_rate_limit';
  if (
    status === 401 ||
    status === 403 ||
    /unauthorized|invalid.*(key|token)/.test(text)
  )
    return 'auth';
  if (status === 404 || status === 405) return 'protocol_mismatch';
  if (status >= 500) return 'provider_error';
  return 'other';
}

/**
 * 把异常文本压成一句能进 manifest 的描述。
 *
 * 异常消息里可能带 URL（`Failed to parse URL from ...`）或凭据片段。
 * manifest 是要进仓库的文件，所以这里只留类别，不留原文。
 */
function safeWhy(err: unknown): string {
  const raw = String((err as Error)?.message ?? err ?? '');
  const kind = /fetch failed/i.test(raw)
    ? 'fetch failed'
    : /parse url|invalid url/i.test(raw)
      ? 'invalid url'
      : /timeout|timed out/i.test(raw)
        ? 'timeout'
        : 'other';
  return `网络错误（${kind}）`;
}

/**
 * 从回复里提取文本，并判断载荷里的标记有没有被回显。
 *
 * verdict：
 * - 'full'    尾标被回显 → 整份载荷读到了末尾
 * - 'partial' 只回显了头标 → 载荷很可能被截断
 * - 'none'    两个都没回显 → 模型没读到这个标记（或者根本没读载荷）
 */
function echoVerdict(text: string): 'full' | 'partial' | 'none' {
  const t = (text || '').toUpperCase();
  if (!t) return 'none';
  const head = t.includes(NONCES.head);
  const end = t.includes(NONCES.end);
  if (end) return 'full';
  if (head) return 'partial';
  return 'none';
}

function extractText(body: string): string {
  try {
    const parsed = JSON.parse(body);
    const content = parsed?.content;
    if (Array.isArray(content)) {
      return content
        .map((c: { text?: unknown }) =>
          typeof c?.text === 'string' ? c.text : '',
        )
        .join('\n');
    }
    if (typeof content === 'string') return content;
    return '';
  } catch {
    return '';
  }
}

/**
 * 直接问 provider 一轮规模的请求。
 *
 * 走 Anthropic 协议，拿到的是真实用量（input_tokens）——这是「轮次规模」唯一
 * 能量化的说法。返回 null 表示这个通道本身不通（没配 baseUrl / token / 模型），
 * 这时退回 sdkQuery：那条路是这个仓库一直在用的，行为已知。
 */
async function probeDirect(
  prompt: string,
): Promise<Record<string, unknown> | null> {
  const config = getClaudeProviderConfig();
  if (!config.anthropicBaseUrl) return null;
  const token = config.anthropicAuthToken ?? config.anthropicApiKey ?? null;
  if (!token || !config.anthropicModel) return null;

  const url = `${config.anthropicBaseUrl.replace(/\/+$/, '')}/v1/messages`;
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        // 认证头必须和**真实 Agent 路径**一致。
        //
        // container/agent-runner/src/pi-index.ts 把 provider 凭据交给 Anthropic
        // SDK 的 apiKey 字段，而 SDK 的 apiKey → `X-Api-Key` 头（`Authorization:
        // Bearer` 是 SDK 的 authToken 字段才用的）。探针要是走另一把钥匙，测的
        // 就不是 Agent 真正要走的那扇门：通过或失败都对不上真实那一轮。
        'x-api-key': token,
      },
      body: JSON.stringify({
        model: config.anthropicModel,
        // max_tokens 要给**思考**留预算，不能只给答案留。
        //
        // 实测（2026-11-06）：这个模型回答前要先花 ~225 个 thinking token，
        // 而 64 的预算在思考阶段就用完了 → 回复里没有回显 → 探针判
        // `payload_not_echoed`。那是**假阴性**：provider 其实完全接得住这一轮
        // 规模，探针却把好轮次拦了下来。
        //
        // 所以这里给 512，并且把 `stop_reason` 一起记下来：探针自己的预算用完
        // （`max_tokens`）和「平台把上下文截断了」是两回事，混在一起报就会把
        // 探针自己的锅算到 provider 头上。
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const body = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        failure_class: classify(res.status, body),
        elapsed_ms: Date.now() - startedAt,
      };
    }
    let usage: Record<string, number> = {};
    let stopReason: string | null = null;
    try {
      const parsed = JSON.parse(body);
      usage = parsed?.usage ?? {};
      stopReason = parsed?.stop_reason ?? null;
    } catch {
      /* 用量拿不到就空着，不猜 */
    }
    const answer = extractText(body);
    return {
      ok: true,
      status: res.status,
      elapsed_ms: Date.now() - startedAt,
      input_tokens: usage.input_tokens ?? null,
      output_tokens: usage.output_tokens ?? null,
      stop_reason: stopReason,
      response_chars: body.length,
      answer_chars: answer.length,
      payload_echoed: echoVerdict(answer),
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      failure_class: 'network',
      elapsed_ms: Date.now() - startedAt,
      why: safeWhy(err),
    };
  }
}

async function main(): Promise<void> {
  const round = measuredRoundBytes();
  const targetBytes = round.bytes;
  const payload = syntheticPayload(targetBytes);
  const prompt = `${payload}\n\n${QUESTION}`;

  const startedAt = Date.now();
  let result: Record<string, unknown>;
  const direct = await probeDirect(prompt);
  if (direct === null) {
    // 直接通道不可用（没配 baseUrl / 没配 token / 没配模型）：退回已知路径。
    const answer = await sdkQuery(prompt, { timeout: 180_000 });
    const verdict = echoVerdict(answer ?? '');
    result = {
      completed: Boolean(answer) && verdict === 'full',
      elapsed_ms: Date.now() - startedAt,
      response_chars: answer?.length ?? 0,
      payload_echoed: verdict,
      channel: 'sdk',
      ...(answer && verdict !== 'full'
        ? {
            failure_class:
              verdict === 'partial'
                ? 'payload_truncated'
                : 'payload_not_echoed',
          }
        : {}),
    };
  } else if (direct.ok) {
    // HTTP 200 只说明「平台收了」；尾标被回显才说明「一整轮规模的载荷真的
    // 被读进去了」。后者才是这条闸门要证明的东西。
    const verdict = direct.payload_echoed as 'full' | 'partial' | 'none';
    // 探针自己的输出预算用完了 → 不是「没回显」，是「没来得及回显」。
    // 这两种必须分开报，否则会把探针的锅算成 provider 的锅。
    const budgetSpent = direct.stop_reason === 'max_tokens';
    result = {
      ...direct,
      completed: verdict === 'full',
      channel: 'direct',
      ...(verdict === 'full'
        ? {}
        : {
            failure_class: budgetSpent
              ? 'probe_output_truncated'
              : verdict === 'partial'
                ? 'payload_truncated'
                : 'payload_not_echoed',
          }),
    };
  } else if (direct.failure_class === 'protocol_mismatch') {
    // 我的直连协议对不上（不是 provider 坏了）：退回已知路径再问一次。
    const answer = await sdkQuery(prompt, { timeout: 180_000 });
    const verdict = echoVerdict(answer ?? '');
    result = {
      completed: Boolean(answer) && verdict === 'full',
      elapsed_ms: Date.now() - startedAt,
      response_chars: answer?.length ?? 0,
      payload_echoed: verdict,
      channel: 'sdk-fallback',
      direct_failure_class: direct.failure_class,
      ...(answer && verdict !== 'full'
        ? {
            failure_class:
              verdict === 'partial'
                ? 'payload_truncated'
                : 'payload_not_echoed',
          }
        : {}),
    };
  } else {
    result = { ...direct, completed: false, channel: 'direct' };
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        payload_bytes: payload.length,
        // 粗略的 token 量级：只用于说明「这一探测有多大」，不是账单。
        approx_input_tokens: Math.round(payload.length / 4),
        reference_round_bytes: targetBytes,
        reference_round_source: round.source,
        ...result,
      },
      null,
      2,
    )}\n`,
  );

  if (!result.completed) process.exitCode = 1;
}

void main().catch(() => {
  process.stderr.write('provider probe failed\n');
  process.exitCode = 1;
});
