# IncidentAgent — 断点存档

最后更新：2026-10-23 18:50。本文件是**唯一下次会话的入口**，先读它再动手。

## 一句话状态

故障实验室、8 个诊断 Skill、Agent Profile 全部就绪并验证通过；
**唯一没跑通的是「Miniclaw 内 Agent 实际诊断」这一步**，卡在 agent-runner 依赖树损坏，
该问题已定位且已修复（`npm ci` 后 `npm run build` 通过），只差再发一次消息。

## 已完成且验证过

### 1. 故障实验室（branch `incident-lab`，commit `b80664f`）

`incident/` 目录下：Docker Compose 栈（target-service + Prometheus 2.54.1 + Alertmanager 0.27.0）、
Spring Boot 3.3.5 目标服务、故障注入脚本、只读观测 CLI。

当前状态（已验证）：

- 容器全部 up，`target-service` healthy
- F2 已注入并提交（commit `0d6d0d4`）：`OrderService.loadOrder` 去掉 null 判空
- 5xx 比例 **8.57%**，`HighServerErrorRate` firing critical，`activeAt=2026-10-23T10:07:04Z`
- 部署相关性：commit `10:04:13Z` → 首个 NPE `10:06:37Z`，**相差 2.4 分钟，判定相关**

### 2. 时区归一（commit `9cf0487`）

容器日志 UTC、git 提交用宿主机偏移，两者直接比对会算出**负数 delta**，
从而错误地排除掉真正的肇因部署，基准就废了。三处一起改才生效：

- `docker-compose.yml` 里 `TZ: UTC`
- `incident-readonly.mjs` 用 `%aI` 取严格 ISO，再在 Node 里 `new Date(...).toISOString()`
- 同文件 `parseLogTimestamp()` 给日志时间戳补 `Z`

### 3. 8 个诊断 Skill

`data/skills/68fcc7c5-f8ca-4265-acd5-f215f5aa24a4/`（用户 `l_h_c` 的 managed 层）：
`alert-triage`、`metric-triage`、`log-triage`、`deployment-window`、
`git-diff-analysis`、`spring-diagnostics`、`historical-incident-lookup`、`root-cause-report`

`deployment-window` 里写死了相关性判定表和**过度归因防护**：
`T_dep ≤ T_err ≤ T_dep + 15min` 才算高度相关，否则默认结论是「无关」。

### 4. Agent Profile（已通过 API 建好）

- profile id：`bbc54f27-afd9-454a-be99-842531057c43`，name `IncidentAgent`
- 源文件：`incident/agent-profile/identity.json`，`prompt_schema_version: 2`
- SOUL 里那条是重点：**不因为「最近发过版」就认定发布是原因**

### 5. 工作区（已建好）

- folder `flow-mvkttud1-ah1b`，jid `web:8ff36e4b-e8da-4dfd-be0a-b55d70fd9edb`
- `execution_mode: host`，`custom_cwd` = 本仓库 `incident/`
- 需要 `config/mount-allowlist.json` 加一条 `/persistent/home/fs-user/IdeaProjects` 才允许该 cwd

### 6. 本地 API 访问方式（**不要打印凭据**）

WebSocket 是唯一的发消息通道，HTTP API 都要 Cookie。构造方式见下，
密钥和 token 全程不落日志：

```
token  = data/db/messages.db 里 user_sessions.id（admin 那条，未过期）
secret = data/config/session-secret.key
cookie = miniclaw_session=<token>.<HMAC-SHA256(token, secret)>
```

Cookie 名是 `miniclaw_session`（非 HTTPS），签名格式 `token.signature`，见 `src/auth.ts:32`。

WebSocket 端点是 `ws://127.0.0.1:3000/ws`，握手带 Cookie 头。
消息格式 `{"type":"send_message","chatJid":"<jid>","content":"..."}`。
**Agent 文本在 `agent_reply` 事件里**，不在 `message`/`stream` 里——这个坑踩过一次。

## 卡住的地方（已定位，已修复，未复验）

症状链条是这样的，每一步都是上一层报的错误叫出来的：

1. `缺少 Pi agent-runner 依赖（@tintinweb/pi-subagents）`
   → `container/agent-runner/node_modules/@tintinweb/pi-subagents/` 是个**空目录**
2. `npm install` 装完，`require.resolve` 仍失败
   → 该包 package.json **既没有 `main` 也没有 `exports`**，但 `dist/index.js` 是存在的
   → 临时给 node_modules 里的 package.json 打了 `main` 补丁（**已被下面的 npm ci 覆盖，不用再补**）
3. `agent-runner 未编译` → `npm run build` 报 `TS7016: Could not find a declaration file for module 'typebox'`
   → 根因同样是安装残缺：`node_modules/typebox/build/index.d.mts` **文件不存在**
   → `typebox@1.3.7` 的 package.json 里 `exports` / `types` 都是对的，是文件没装出来
4. **`npm ci` 一次性解决 2 和 3**：`added 234 packages`，两个文件都在了，`npm run build` 退出码 0，
   `dist/pi-index.js` 产出

根因是 **`container/agent-runner` 这棵依赖树装残了**（和记忆里记的 lockfile 问题是同一类）。
以后任何「缺依赖 / 未编译」报错，先 `npm ci`，别手动补 package.json。

## 下次会话第一件事

按顺序做，每步都验证，别跳：

```bash
cd /persistent/home/fs-user/IdeaProjects/ai_coding/study/miniclaw-main/miniclaw-main

# 0. 确认 agent-runner 已构建（存档时已构建通过）
ls container/agent-runner/dist/pi-index.js

# 1. 确认实验栈还在跑、故障还在
docker compose -f incident/docker-compose.yml ps
node incident/tools/incident-readonly.mjs metrics alerts
```

若 Miniclaw 停了，重启：`node dist/index.js`（存档时 pid 617741 在跑，端口 3000）。

重建 cookie 然后发消息（脚本已随仓库提交，直接用仓库路径，`/tmp` 会被清空）：

```bash
node incident/runs/mc-auth.mjs > /tmp/mc-cookie.txt     # 注意 user_sessions.id 就是 token
node incident/runs/ws-run.mjs "web:8ff36e4b-e8da-4dfd-be0a-b55d70fd9edb" \
     incident/runs/diag-prompt.txt
```

（存档时已实测过这两个脚本：cookie 脚本退出码 0，拿到的 cookie 调 `/api/auth/me` 返回 200。
`ws-run.mjs` 把 Agent 回复写到 `/tmp/agent-out.txt`。）

跑完把 Agent 输出存到 `incident/runs/` 下作为 demo 产物。

## 判定这次跑通的标准

Agent 的报告必须满足这四条，缺一条就是没跑通：

1. 三个锚点都显式写出：告警起始 `10:07:04Z`、异常首现 `10:06:37Z`、最近部署 `10:04:13Z`
2. 明确判定该部署**相关**（2.4 分钟落在 15 分钟窗口内）
3. 根因指到 F2 的 null 判空移除，并引用具体 diff
4. 每条结论能回指到一条查询输出

跑通后把简历包里 `claim-incident-101` 从 `pending` 翻成 `confirmed`，
路径 `/home/fs-user/Desktop/文档/overleaf/miniclaw_incident相关/claim-ledger.json`。

## 还没做的

- **Task #3：只读 MCP 工具通道**（`pending`）。CLI 通道已经验证可用且够用，
  MCP 封装一直没做，因为 Pi SDK 的 MCP 兼容性和 `@modelcontextprotocol/sdk`
  都不是本项目依赖。没验证之前别急着写。
- `incident/faults/faults.mjs` 里 F4/F5（运行时故障，无 commit）**从来没跑过**。
  这两个是用来验证 Agent 会不会**正确地跳过**部署和 git 步骤的，
  是过度归因防护的对照组，比 F2 更有价值。下次跑通 F2 之后优先做这个。