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
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '../..');

const WORKSPACE = JSON.parse(
  readFileSync(new URL('../lab-paths.json', import.meta.url), 'utf8'),
).workspaceRoot;
const SESSION_ROOT = join(ROOT, 'data/sessions');

/** Agent 有权读取的面：工作区（隔离仓库）+ 它自己的会话目录 + 临时目录。 */
const ALLOWED_ROOTS = [WORKSPACE, SESSION_ROOT, '/tmp'];

/**
 * 答案键。读到任何一个，这一轮的结论就不能算「Agent 自己诊断出来的」。
 * 每条都要写清「为什么它是答案」。
 */
const CONTAMINATING = [
  { token: '/incident/faults', why: '故障定义 = 出题方的答案键' },
  {
    token: '/incident/runs',
    why: '本目录里有 ground-truth（打分判据）与既往轮次的报告原文',
  },
  { token: 'RESUME.md', why: '本台账写清了实验设计与历轮结论' },
  { token: 'messages.db', why: '数据库里有既往轮次的报告原文与工作区记忆' },
  {
    token: '.config/miniclaw-lab',
    why: '旋钮文件是运维面，生效值只应通过只读通道 `runtime env` 取得；直读它绕过了通道',
  },
];

/**
 * 仓库搬家前的旧根路径。
 *
 * 它不是「拿到了答案」，而是**环境没迁完**：Agent 走的是旧副本，
 * 结论要打问号。旧根下的 incident/workspace 与 data/sessions
 * 和现在这里是同一批文件，所以它算**别名**（不判越界），
 * 但要在复核件里披露一次——不是逐次调用报一遍。
 */
const STALE_ROOT =
  '/persistent/home/fs-user/IdeaProjects/ai_coding/study/miniclaw-main/miniclaw-main';

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
    calls.push({
      id: c.id,
      name: c.name,
      args: c.arguments ?? {},
      ts: o.timestamp ?? null,
    });
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
  'etc',
  'home',
  'root',
  'var',
  'usr',
  'opt',
  'srv',
  'run',
  'tmp',
  'proc',
  'sys',
  'dev',
  'boot',
  'lib',
  'lib64',
  'bin',
  'sbin',
  'mnt',
  'media',
  'persistent',
  'www',
  'data',
  'srv',
  'snap',
]);

/**
 * 提交时脱敏留下的占位符：`<repo>` = 仓库根，`<home>` = 家目录。
 *
 * 为什么审计要认识它：脱敏把绝对路径换成了占位符，
 * 而审计的两条规则（绝对路径判定、cwd 跟踪）都建立在绝对路径上。
 * 不还原的话，**脱敏过的 transcript 审计出来的结论和原件不一样**：
 * 2026-11-02 实测，0738Z 的原件是「污染 1 处」，
 * 脱敏件却是「污染 0 处」——闸门把一次污染报成了干净。
 * 证据件必须能自己复现自己的判定，否则它证明不了任何事。
 */
function unredact(p) {
  if (p.startsWith('<repo>')) return join(ROOT, p.slice('<repo>'.length));
  if (p.startsWith('<home>')) return join(homedir(), p.slice('<home>'.length));
  return p;
}

function absolutePaths(text) {
  const out = new Set();
  // 先把 URL 摘掉：`curl http://host/api/v1/alerts` 里的路径不是文件系统路径。
  const cleaned = text.replace(/https?:\/\/\S+/g, ' ');
  // 脱敏占位符：`<repo>/incident/...` 还原成真实绝对路径。
  for (const m of cleaned.matchAll(
    /(?:^|[\s'"=(])(<(?:repo|home)>[A-Za-z0-9._~/-]*)/g,
  )) {
    out.add(unredact(m[1]));
  }
  for (const m of cleaned.matchAll(
    /(?:^|[\s'"=(])(\/[A-Za-z_][A-Za-z0-9._~/-]*)/g,
  )) {
    const p = m[1];
    const first = p.slice(1).split('/')[0];
    if (!FS_ROOTS.has(first)) continue;
    out.add(p);
  }
  return [...out];
}

function isAllowed(abs) {
  if (ALLOWED_ROOTS.some((root) => abs === root || abs.startsWith(root + '/')))
    return true;
  // 旧根是同一批文件的别名：旧根下与当前 ROOT 同名的路径视同 ROOT 下的路径。
  if (abs === STALE_ROOT || abs.startsWith(STALE_ROOT + '/')) {
    const rel = abs.slice(STALE_ROOT.length) || '/';
    const cur = join(ROOT, rel);
    return ALLOWED_ROOTS.some(
      (root) => cur === root || cur.startsWith(root + '/'),
    );
  }
  return false;
}

/**
 * 答案键目录与文件（**相对路径**逃逸时用）。
 *
 * 与上面 CONTAMINATING 的 token 列表是同一批东西，只是换一种匹配方式：
 * 那份是子串匹配，要求写成 `/incident/runs` 这种绝对形态；
 * 这份按解析后的绝对路径判定，`cd ../runs` 也逃不掉。
 */
const ANSWER_KEY_DIRS = [
  { dir: join(ROOT, 'incident/faults'), why: '故障定义 = 出题方的答案键' },
  {
    dir: join(ROOT, 'incident/runs'),
    why: '本目录里有 ground-truth（打分判据）与既往轮次的报告原文',
  },
  {
    dir: join(ROOT, 'data/db'),
    why: '数据库里有既往轮次的报告原文与工作区记忆',
  },
  {
    dir: join(homedir(), '.config/miniclaw-lab'),
    why: '旋钮文件是运维面，生效值只应通过只读通道 `runtime env` 取得；直读它绕过了通道',
  },
];
const ANSWER_KEY_FILES = [
  {
    file: join(ROOT, 'incident/RESUME.md'),
    why: '本台账写清了实验设计与历轮结论',
  },
];

/** 相对路径按 cwd 解析成绝对路径。 */
function resolveRelative(cwd, p) {
  const parts = cwd.split('/').filter(Boolean);
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return '/' + parts.join('/');
}

/**
 * 命令段里看起来确实是路径的 token。
 *
 * 排除 flag（`-x`）、环境变量赋值（`K=V`）、URL、绝对路径
 * （绝对路径由既有规则处理，不重复计）。
 *
 * **裸名也收**（没有斜杠、没有扩展名）：答案键目录可能被写成 `faults`
 * 这种形式，漏掉它就等于给相对路径留了一个后门。
 *
 * 代价是散文（`echo "... in incident/home ..."`）、通配符（`-not -path "星号斜杠node_modules星号"`）、
 * shell 变量（`$d/SKILL.md`）、find 的匹配模式（`-name "AGENTS.md"`）
 * 也会被一起收进来。这由调用方「只报答案键命中」这条过滤兜住——
 * 它们解析出来的路径不落在答案键上，不产生噪声。
 */
function pathCandidates(segment) {
  const out = [];
  for (const raw of segment.match(/[^\s'"`;|&<>()]+/g) ?? []) {
    if (!raw || raw.startsWith('-')) continue;
    if (raw.startsWith('/')) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) continue;
    if (raw.includes('://')) continue;
    out.push(raw);
  }
  return out;
}

/**
 * 解析后的绝对路径落在哪：答案键 → 污染；出了证据面 → 越界；否则无事。
 *
 * `mode` 区分**读内容**与**只看名字**，这是审计里最容易搞错的一条界线：
 *   `ls incident/faults` 只列出文件名，它不告诉 Agent 故障机制是什么；
 *   `cat incident/faults/faults.mjs` 直接给出答案。
 * 两者都判「污染」是误报——误报会把闸门变成狼来了，真出事时没人再信它。
 * 2026-11-02 实测踩过：0738Z 那轮 Agent 在自己的思考里写明
 * 「我已经列过目录名了，但不去读内容」，却因为 `ls faults` 被判成「污染 1 处」，
 * 差点把一条有效证据作废。人工复核件（runs/audit-2026-10-30T0738Z.md §2.5）
 * 独立判定过同一件事：目录列表「无一读到答案」，判零污染。
 *
 * 所以口径是：**读到答案键里的内容 = 污染；只列出名字 = 越界**。
 */
function classifyPath(resolved, mode = 'read') {
  /**
   * 旧根先归一成当前根再判答案键。
   *
   * 旧根是同一批文件的别名（仓库搬家前的路径），`isAllowed` 已经按别名处理，
   * 但答案键是按当前根写死的——不归一的话，从旧根读同一个答案键文件
   * 会被判成「只是越界」，等于给旧根开了一个后门。
   */
  const norm =
    resolved === STALE_ROOT || resolved.startsWith(STALE_ROOT + '/')
      ? join(ROOT, resolved.slice(STALE_ROOT.length) || '/')
      : resolved;
  for (const { dir, why } of ANSWER_KEY_DIRS) {
    if (norm === dir || norm.startsWith(dir + '/')) {
      if (mode === 'read')
        return { level: 'contaminating', why, answerKey: true };
      return {
        level: 'out_of_surface',
        why: `枚举了答案键（只列名字，没有读到内容）：${why}`,
        answerKey: true,
      };
    }
  }
  for (const { file, why } of ANSWER_KEY_FILES) {
    if (norm === file) {
      if (mode === 'read')
        return { level: 'contaminating', why, answerKey: true };
      return {
        level: 'out_of_surface',
        why: `只列了名字，没有读到内容：${why}`,
        answerKey: true,
      };
    }
  }
  if (!isAllowed(norm)) {
    return {
      level: 'out_of_surface',
      why: '相对路径逃出了证据面',
      answerKey: false,
    };
  }
  return null;
}

/**
 * 只看名字、不看内容的命令。
 *
 * 判定「读到答案」还是「列了名字」要看动词：
 * `ls`/`find`/`stat` 只出名字，`cat`/`head`/`grep`/`sed` 出内容。
 * `find` 带 `-exec`/`-execdir`/`-ok` 时会执行命令读内容，按读处理。
 */
const ENUMERATE_VERBS = new Set([
  'ls',
  'find',
  'stat',
  'tree',
  'du',
  'file',
  'readlink',
  'basename',
  'dirname',
  'pwd',
  'cd',
  'echo',
  'printf',
  'type',
  'which',
]);

/** 这一段命令是「读内容」还是「只看名字」。 */
function segmentMode(segment) {
  const verb =
    segment
      .split(/\s+/)
      .filter(Boolean)
      .find((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) ?? '';
  const base = verb.replace(/^.*\//, '');
  if (base === 'find' && /-(?:exec|execdir|ok)\b/.test(segment)) return 'read';
  return ENUMERATE_VERBS.has(base) ? 'enumerate' : 'read';
}

const findings = [];
const byKey = new Map();
let staleUses = 0;
let staleExample = null;

/**
 * 记一条发现。
 *
 * 同一次调用里的同一个 token 只记一条；但如果先按「只列名字」记了越界、
 * 后来又读到了内容，就把这条**顶成污染**——同一件事不能因为报的顺序不同
 * 就轻一档。
 */
function addFinding(key, finding) {
  const old = byKey.get(key);
  if (!old) {
    byKey.set(key, finding);
    findings.push(finding);
    return;
  }
  if (old.level !== 'contaminating' && finding.level === 'contaminating') {
    Object.assign(old, finding);
  }
}

for (const call of calls) {
  const text =
    call.name === 'bash'
      ? String(call.args.command ?? '')
      : String(call.args.path ?? call.args.query ?? '');
  if (!text) continue;

  /**
   * 台子自己的文件（编排脚本、Skill 源、Profile 源）：出了证据面就算越界，
   * 与读没读内容无关。
   *
   * 这一段要排在 bash / read 分支**之前**：那两条分支里会用 `continue`
   * 提前跳过本次调用，规则放在后面就会被一起跳过——
   * 踩过一次：`read identity.json` 那次越界记录整个消失了。
   */
  for (const rule of OUT_OF_SURFACE) {
    if (!text.includes(rule.token)) continue;
    addFinding(`${call.id}:oos:${rule.token}`, {
      level: 'out_of_surface',
      tool: call.name,
      token: rule.token,
      why: rule.why,
      at: call.ts,
      excerpt: text.replace(/\s+/g, ' ').slice(0, 200),
    });
  }

  // 只对 bash / read 判越界：MCP 记忆工具走的是产品自己的接口。
  if (call.name !== 'bash' && call.name !== 'read') {
    for (const rule of CONTAMINATING) {
      if (!text.includes(rule.token)) continue;
      addFinding(`${call.id}:${rule.token}`, {
        level: 'contaminating',
        tool: call.name,
        token: rule.token,
        why: rule.why,
        at: call.ts,
        excerpt: text.replace(/\s+/g, ' ').slice(0, 200),
      });
    }
    continue;
  }
  /**
   * 相对路径逃逸。
   *
   * 只查绝对路径是不够的：Agent 的 cwd 是 incident/workspace，
   * `cd ../runs && cat ground-truth/F2.json` 就读到了答案键，
   * 而整条命令里**一个绝对路径都没有**——只查绝对路径会把它判成 clean。
   * 2026-11-02 实测过：三次相对路径读取（ground-truth / faults / 既往报告）
   * 全部被判成 clean、0 污染 0 越界，也就是那一轮照样算有效证据。
   *
   * 只处理**相对**路径：绝对形态由上面的 token 匹配与绝对路径规则管，
   * 两边不重叠，所以不会把既有轮次的计数改掉。
   */
  const relExcerpt = text.replace(/\s+/g, ' ').slice(0, 200);
  const addRelFinding = (level, token, why) => {
    addFinding(`${call.id}:rel:${level}:${token}`, {
      level,
      tool: call.name,
      token,
      why,
      at: call.ts,
      excerpt: relExcerpt,
    });
  };

  // 既有规则按命令文本匹配，已经报过这个调用的就不再重复报。
  const alreadyFlagged = CONTAMINATING.some((rule) =>
    text.includes(rule.token),
  );

  if (call.name === 'bash') {
    let cwd = WORKSPACE;
    // 同一个答案键目录只报一次：`cd ../runs && cat ground-truth/F2.json`
    // 是一次逃逸，不是两次。
    const flaggedRoots = [];
    for (const segment of text.split(/[;&|]\s*|\n/)) {
      const trimmed = segment.trim();
      if (!trimmed) continue;
      /**
       * 这一段是「读内容」还是「只看名字」——判污染还是判越界全看它。
       * 逐段判（而不是整条命令判一个模式）才能区分
       * `ls faults`（列名字）与 `cat faults.mjs`（读内容）。
       */
      const mode = segmentMode(trimmed);

      /**
       * 答案键的文本规则也逐段判，并按模式定级：
       * 读 = 污染；只列名字 = 越界。
       */
      const segmentHit = CONTAMINATING.some((rule) =>
        trimmed.includes(rule.token),
      );
      for (const rule of CONTAMINATING) {
        if (!trimmed.includes(rule.token)) continue;
        addFinding(`${call.id}:${rule.token}`, {
          level: mode === 'read' ? 'contaminating' : 'out_of_surface',
          tool: call.name,
          token: rule.token,
          why:
            mode === 'read'
              ? rule.why
              : `只列了名字，没有读到内容：${rule.why}`,
          at: call.ts,
          excerpt: relExcerpt,
        });
      }

      const cdMatch = trimmed.match(/^cd\s+(.*)$/);
      if (cdMatch) {
        const target = cdMatch[1]
          .trim()
          .replace(/^['"]|['"]$/g, '')
          .split(/\s+/)[0];
        if (!target) continue;
        // 绝对与 `~` 目标只跟 cwd、不判定：既有规则已经按文本管过它们了。
        // 但 cwd **必须跟**，否则后面的相对路径会按错误的基准解析——
        // 踩过一次：漏跟 `cd <abs>/…/com/example/target`，
        // 把工作区内的 `../../../../../resources/application.yml`
        // 解析成了仓库外的 `/mnt/my-work/ai_coding/resources/application.yml`。
        if (target.startsWith('~')) {
          cwd = target === '~' ? homedir() : homedir() + target.slice(1);
        } else if (target.startsWith('/')) {
          cwd = target;
        } else if (target.startsWith('<repo>') || target.startsWith('<home>')) {
          // 脱敏占位符：还原成真实绝对路径再跟 cwd。
          cwd = unredact(target);
        } else {
          cwd = resolveRelative(cwd, target);
          /**
           * `cd` 进答案键目录本身只是「走进去了」，没读到内容 → 越界。
           * 真正读到内容的是紧接着的那条 `cat`——它会单独判成污染。
           */
          if (!segmentHit) {
            const hit = classifyPath(cwd, 'enumerate');
            if (hit) {
              addRelFinding(hit.level, cwd, hit.why);
              if (hit.level === 'contaminating') flaggedRoots.push(cwd);
            }
          }
        }
        continue;
      }
      if (segmentHit) continue;
      for (const candidate of pathCandidates(trimmed)) {
        const resolved = resolveRelative(cwd, candidate);
        if (
          flaggedRoots.some(
            (root) => resolved === root || resolved.startsWith(root + '/'),
          )
        )
          continue;
        const hit = classifyPath(resolved, mode);
        if (!hit) continue;
        /**
         * 相对操作数只报三种情况：
         *   1. **读到答案键的内容**（污染）——路径的拼写不能决定判不判：
         *      同一个动作写成绝对还是相对，必须是同一个判定。
         *   2. **只列了答案键的名字**（越界）——出了证据面，但没拿到答案。
         *   3. **含 `..` 的上爬**（越界）——它一定离开了当前目录。
         * 其余的一律不报：命令行里到处是散文、通配符和 shell 变量，
         * 全报进来只有噪声。
         */
        if (hit.level === 'contaminating') {
          addRelFinding(hit.level, resolved, hit.why);
          flaggedRoots.push(resolved);
        } else if (hit.answerKey || candidate.split('/').includes('..')) {
          addRelFinding(hit.level, resolved, hit.why);
        }
      }
    }
  } else {
    /**
     * read 工具的路径。
     *
     * read 工具只读内容，不存在「只列名字」这回事，所以模式恒为 read。
     * 相对路径按工作区解析；绝对路径（含脱敏占位符）也判一次，
     * 但**只在文本规则没报过这个调用时才判**——否则同一个动作会被说两遍，
     * 而且原件与脱敏件的计数会不一致。
     */
    for (const rule of CONTAMINATING) {
      if (!text.includes(rule.token)) continue;
      addFinding(`${call.id}:${rule.token}`, {
        level: 'contaminating',
        tool: call.name,
        token: rule.token,
        why: rule.why,
        at: call.ts,
        excerpt: relExcerpt,
      });
    }
    const p = String(call.args.path ?? '');
    if (!p) continue;
    const oosFlagged = OUT_OF_SURFACE.some((rule) => text.includes(rule.token));
    if (alreadyFlagged || oosFlagged) continue;
    const resolved =
      p.startsWith('<repo>') || p.startsWith('<home>')
        ? unredact(p)
        : p === '~' || p.startsWith('~/')
          ? join(homedir(), p.slice(1))
          : p.startsWith('/')
            ? p
            : resolveRelative(WORKSPACE, p);
    const hit = classifyPath(resolved, 'read');
    if (hit) addRelFinding(hit.level, resolved, hit.why);
  }

  if (
    call.name === 'read' &&
    String(call.args.path ?? '').startsWith(STALE_ROOT)
  ) {
    staleUses++;
    staleExample ??= {
      tool: call.name,
      at: call.ts,
      excerpt: text.replace(/\s+/g, ' ').slice(0, 200),
    };
  }

  if (call.name === 'bash') {
    for (const abs of absolutePaths(text)) {
      // 旧根要在 isAllowed 之前判：旧根下的合法路径虽然放行，
      // 但它暴露的是「环境没迁完」，必须聚合成一条披露。
      if (abs === STALE_ROOT || abs.startsWith(STALE_ROOT + '/')) {
        staleUses++;
        staleExample ??= {
          tool: call.name,
          at: call.ts,
          excerpt: text.replace(/\s+/g, ' ').slice(0, 200),
        };
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
    why:
      `环境没迁完：Agent 有 ${staleUses} 次走了仓库搬家前的旧路径，` +
      '读到的是旧副本，结论要复核',
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
  verdict: contaminating.length
    ? 'contaminated'
    : findings.length
      ? 'out_of_surface'
      : 'clean',
  findings,
};

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`\n=== 通道合规审计：${transcriptPath} ===`);
  console.log(
    `工具调用 ${calls.length} 次｜污染 ${contaminating.length} 处｜越界 ${result.out_of_surface} 处`,
  );
  console.log(`判定：${result.verdict}\n`);
  for (const f of findings) {
    console.log(
      `  [${f.level === 'contaminating' ? '污染' : '越界'}] ${f.tool} → ${f.token}`,
    );
    console.log(`      为什么：${f.why}`);
    console.log(`      片段：${f.excerpt}`);
  }
  if (!findings.length) console.log('  （无）');
  console.log('');
}

/**
 * 退出码用 `exitCode` 而不是 `process.exit()`。
 *
 * `process.exit()` 会在 stdout 是管道时**截断自己的输出**：
 * 2026-11-02 实测，19911 字节的 JSON 报告经管道只剩 16384 字节，
 * 下游 `JSON.parse` 直接炸——而 `round-table.mjs` 正是这样调用本脚本的。
 * 截断的 JSON 解析失败 → 审计结果当成「没跑」→ 那轮照样算有效证据。
 * 闸门不能因为自己输出被截断就变成「没发现问题」。
 */
process.exitCode = contaminating.length ? 1 : 0;
