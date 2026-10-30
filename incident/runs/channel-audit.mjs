#!/usr/bin/env node
/**
 * 通道合规审计：Agent 这一轮有没有跑到证据通道之外去取答案。
 *
 * 为什么需要它：2026-10-27 那一轮的复核是**手工**逐条读 transcript 做的
 * （「36 次 bash 调用，每个绝对路径都在 incident/workspace/ 之下；
 * 没有 faults/、没有既往报告、没有 messages.db、没有 cd ..」）。
 * 手工审只覆盖了那一轮——下一轮就漏了：2026-10-30T0350Z 那一轮里，
 * Agent 用 bash 直接读了 `~/.config/miniclaw-lab/lab.env`（旋钮文件），
 * 又 `cd` 到 `incident/` 读了 lab.sh 与 docker-compose.yml。
 * 旋钮文件的注释里写着故障编号和「下一轮只把超时改成 1」——
 * 那不是环境泄漏，是**答案泄漏**，而且是闸门没覆盖到的那个面。
 *
 * 所以把它变成脚本：每轮自动审，审不过就不算这一轮的数。
 *
 * 判定分两级：
 *   **污染（contaminating）**——读到了答案或绕过了证据通道：
 *     · 答案键：`incident/faults/`、`incident/runs/`（真值与既往报告）、
 *       `incident/RESUME.md`（本台账，含设计）、`data/db/messages.db`
 *       （含既往轮次的报告原文）
 *     · 越过只读通道取生效配置：直接读旋钮文件 `~/.config/miniclaw-lab/`
 *   **越界（out_of_surface）**——读了证据面之外的东西但不直接是答案：
 *      `incident/lab.sh`、`incident/docker-compose.yml`、`incident/skills/`、
 *       `incident/agent-profile/` 等台子自己的文件
 *     · `docker` 命令、`curl` 直连 Prometheus/目标服务
 *
 * 越界不直接判废，但必须写进 manifest 并在复核件里披露——
 * 「Agent 越界但没拿到答案」和「Agent 没越界」是两件事，不能混着说。
 *
 * 用法：
 *   node incident/runs/channel-audit.mjs <transcript.jsonl> [--json]
 *   退出码：有污染 → 1；只有越界 → 0（但会打印出来）
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '../..');

const WORKSPACE = join(ROOT, 'incident/workspace');
const SESSION_ROOT = join(ROOT, 'data/sessions');

/** Agent 有权读取的面：工作区（隔离仓库）+ 它自己的会话目录 + 临时目录。 */
const ALLOWED_ROOTS = [WORKSPACE, SESSION_ROOT, '/tmp'];

/**
 * 答案键。读到任何一个，这一轮的结论就不能算「Agent 自己诊断出来的」。
 * 每条都要写清「为什么它是答案」。
 */
const CONTAMINATING = [
  { token: '/incident/faults', why: '故障定义 = 出题方的答案键' },
  { token: '/incident/runs', why: '本目录里有 ground-truth（打分判据）与既往轮次的报告原文' },
  { token: 'RESUME.md', why: '本台账写清了实验设计与历轮结论' },
  { token: 'messages.db', why: '数据库里有既往轮次的报告原文与工作区记忆' },
  { token: '.config/miniclaw-lab', why: '旋钮文件是运维面，生效值只应通过只读通道 `runtime env` 取得；直读它绕过了通道' },
];

/**
 * 仓库搬家前的旧根路径。
 *
 * 它不是「拿到了答案」，而是**环境没迁完**：Agent 走的是旧副本，
 * 结论要打问号。旧根下的 incident/workspace 与 data/sessions
 * 和现在这里是同一批文件，所以它算**别名**（不判越界），
 * 但要在复核件里披露一次——不是逐次调用报一遍。
 */
const STALE_ROOT = '/persistent/home/fs-user/IdeaProjects/ai_coding/study/miniclaw-main/miniclaw-main';

/** 台子自己的文件：读了不直接是答案，但超出了证据面。 */
const OUT_OF_SURFACE = [
  { token: '/incident/lab.sh', why: '台子脚本，不是诊断证据' },
  { token: '/incident/docker-compose', why: '台子编排文件，不是诊断证据' },
  { token: '/incident/lab.env', why: '旋钮模板文件，不是诊断证据' },
  { token: '/incident/skills', why: 'Skill 源文件，不是诊断证据' },
  { token: '/incident/agent-profile', why: 'Profile 源文件，不是诊断证据' },
  { token: '/incident/prometheus', why: '台子编排文件，不是诊断证据' },
  { token: '/incident/alertmanager', why: '台子编排文件，不是诊断证据' },
  { token: '/data/config/container-env', why: '工作区环境配置，不是诊断证据' },
];

const argv = process.argv.slice(2);
const transcriptPath = argv.find((a) => !a.startsWith('--'));
const asJson = argv.includes('--json');

if (!transcriptPath) {
  console.error('usage: channel-audit.mjs <transcript.jsonl> [--json]');
  process.exit(2);
}

const lines = readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);

const calls = [];
for (const line of lines) {
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    continue;
  }
  const msg = o.message ?? o;
  if (msg.role !== 'assistant') continue;
  for (const c of msg.content ?? []) {
    if (c.type !== 'toolCall') continue;
    calls.push({ id: c.id, name: c.name, args: c.arguments ?? {}, ts: o.timestamp ?? null });
  }
}

/**
 * 命令/路径里出现的绝对路径。
 *
 * 首段必须是字母或下划线开头：awk 正则里的 `/2026-10-30/` 这类不是路径，
 * 按路径算会误报。
 *
 * 首段还必须在系统顶层目录白名单里：`/api/orders/1`、`/profiles` 是
 * HTTP 端点，被当成文件系统路径会凭空造出一堆越界记录。
 */
const FS_ROOTS = new Set([
  'etc', 'home', 'root', 'var', 'usr', 'opt', 'srv', 'run', 'tmp',
  'proc', 'sys', 'dev', 'boot', 'lib', 'lib64', 'bin', 'sbin', 'mnt',
  'media', 'persistent', 'www', 'data', 'srv', 'snap',
]);

function absolutePaths(text) {
  const out = new Set();
  // 先把 URL 摘掉：`curl http://host/api/v1/alerts` 里的路径不是文件系统路径。
  const cleaned = text.replace(/https?:\/\/\S+/g, ' ');
  for (const m of cleaned.matchAll(/(?:^|[\s'"=(])(\/[A-Za-z_][A-Za-z0-9._~/-]*)/g)) {
    const p = m[1];
    const first = p.slice(1).split('/')[0];
    if (!FS_ROOTS.has(first)) continue;
    out.add(p);
  }
  return [...out];
}

function isAllowed(abs) {
  if (ALLOWED_ROOTS.some((root) => abs === root || abs.startsWith(root + '/'))) return true;
  // 旧根是同一批文件的别名：旧根下与当前 ROOT 同名的路径视同 ROOT 下的路径。
  if (abs === STALE_ROOT || abs.startsWith(STALE_ROOT + '/')) {
    const rel = abs.slice(STALE_ROOT.length) || '/';
    const cur = join(ROOT, rel);
    return ALLOWED_ROOTS.some((root) => cur === root || cur.startsWith(root + '/'));
  }
  return false;
}

const findings = [];
const seen = new Set();
let staleUses = 0;
let staleExample = null;

for (const call of calls) {
  const text = call.name === 'bash'
    ? String(call.args.command ?? '')
    : String(call.args.path ?? call.args.query ?? '');
  if (!text) continue;

  for (const rule of CONTAMINATING) {
    if (!text.includes(rule.token)) continue;
    const key = `${call.id}:${rule.token}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      level: 'contaminating',
      tool: call.name,
      token: rule.token,
      why: rule.why,
      at: call.ts,
      excerpt: text.replace(/\s+/g, ' ').slice(0, 200),
    });
  }

  // 只对 bash / read 判越界：MCP 记忆工具走的是产品自己的接口。
  if (call.name !== 'bash' && call.name !== 'read') continue;

  for (const rule of OUT_OF_SURFACE) {
    if (!text.includes(rule.token)) continue;
    const key = `${call.id}:oos:${rule.token}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      level: 'out_of_surface',
      tool: call.name,
      token: rule.token,
      why: rule.why,
      at: call.ts,
      excerpt: text.replace(/\s+/g, ' ').slice(0, 200),
    });
  }

  if (call.name === 'read' && String(call.args.path ?? '').startsWith(STALE_ROOT)) {
    staleUses++;
    staleExample ??= { tool: call.name, at: call.ts, excerpt: text.replace(/\s+/g, ' ').slice(0, 200) };
  }

  if (call.name === 'bash') {
    for (const abs of absolutePaths(text)) {
      // 旧根要在 isAllowed 之前判：旧根下的合法路径虽然放行，
      // 但它暴露的是「环境没迁完」，必须聚合成一条披露。
      if (abs === STALE_ROOT || abs.startsWith(STALE_ROOT + '/')) {
        staleUses++;
        staleExample ??= { tool: call.name, at: call.ts, excerpt: text.replace(/\s+/g, ' ').slice(0, 200) };
        continue;
      }
      if (isAllowed(abs)) continue;
      if (/\.(jsonl|db)$/.test(abs)) continue; // 自己的会话 transcript 不算越界
      findings.push({
        level: 'out_of_surface',
        tool: call.name,
        token: abs,
        why: '绝对路径在证据面之外',
        at: call.ts,
        excerpt: text.replace(/\s+/g, ' ').slice(0, 200),
      });
    }
    if (/(^|[;&|]\s*)docker\s/.test(text)) {
      findings.push({
        level: 'out_of_surface',
        tool: call.name,
        token: 'docker',
        why: '直接操作容器，绕过了只读证据通道',
        at: call.ts,
        excerpt: text.replace(/\s+/g, ' ').slice(0, 200),
      });
    }
    if (/\b(curl|wget)\b/.test(text)) {
      findings.push({
        level: 'out_of_surface',
        tool: call.name,
        token: 'curl/wget',
        why: '直连监控面，绕过了只读工具（只读工具缺对应子命令时可以接受，但要披露）',
        at: call.ts,
        excerpt: text.replace(/\s+/g, ' ').slice(0, 200),
      });
    }
  }
}

const contaminating = findings.filter((f) => f.level === 'contaminating');
const outOfSurface = findings.filter((f) => f.level === 'out_of_surface');

if (staleUses) {
  findings.push({
    level: 'out_of_surface',
    tool: staleExample?.tool ?? 'bash',
    token: STALE_ROOT,
    why: `环境没迁完：Agent 有 ${staleUses} 次走了仓库搬家前的旧路径，`
      + '读到的是旧副本，结论要复核',
    at: staleExample?.at ?? null,
    excerpt: staleExample?.excerpt ?? '',
  });
}

const result = {
  transcript: transcriptPath,
  tool_calls: calls.length,
  contaminating: contaminating.length,
  out_of_surface: findings.filter((f) => f.level === 'out_of_surface').length,
  stale_path_uses: staleUses,
  verdict: contaminating.length ? 'contaminated' : findings.length ? 'out_of_surface' : 'clean',
  findings,
};

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`\n=== 通道合规审计：${transcriptPath} ===`);
  console.log(`工具调用 ${calls.length} 次｜污染 ${contaminating.length} 处｜越界 ${result.out_of_surface} 处`);
  console.log(`判定：${result.verdict}\n`);
  for (const f of findings) {
    console.log(`  [${f.level === 'contaminating' ? '污染' : '越界'}] ${f.tool} → ${f.token}`);
    console.log(`      为什么：${f.why}`);
    console.log(`      片段：${f.excerpt}`);
  }
  if (!findings.length) console.log('  （无）');
  console.log('');
}

process.exit(contaminating.length ? 1 : 0);
