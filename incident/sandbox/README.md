# 沙箱（host 模式文件系统边界）

最后更新：**2026-11-17**。

## 这份文档解决什么

host 模式曾经没有边界：Agent 以 Miniclaw 服务同一个用户的身份跑在宿主机上，
**能直读宿主机任意文件**。落到这个实验室上，这意味着它能读到：

| 读到的东西         | 位置                                                   | 后果                         |
| ------------------ | ------------------------------------------------------ | ---------------------------- |
| 故障真值、既往报告 | `~/incident-lab-archive/`                              | 提前知道答案，轮次作废       |
| 判据、故障注入清单 | 仓库 `incident/runs/ground-truth/`、`incident/faults/` | 同上                         |
| 故障旋钮           | `~/.config/miniclaw-lab/lab.env`                       | 绕过观测通道，审计归因失效   |
| 公司凭据           | `~/.config/miniclaw-lab/systems.env`                   | Jenkins / Rancher token 泄露 |

台子原来的做法是**事后**发现：闸门 W + 通道审计 + 泄漏扫描。这条路在单人跑时够用，
**给别人跑之前不够**——审计只保证"这一轮没作弊"，不保证"这一轮没法作弊"。

所以现在补的是**事前阻断**：Agent 在沙箱里跑，沙箱只放行它真正需要的东西。

## 怎么做的：三层

```
Miniclaw host 模式（产品）
  └─ bubblewrap 沙箱（产品能力，opt-in）
       ├─ 工作区 / 会话目录 / IPC 目录：读写
       ├─ 系统目录（/usr /etc /opt）、node、agent-runner：只读
       ├─ HOME：换成空的 tmpfs
       └─ 其余一概不可见
  ↓
沙箱里的 docker（shim，只放行两个 inspect 格式）
  ↓ unix socket
靶子事实服务（跑在沙箱外面，有 docker 权限）
  → 只回答：容器启动时刻、容器生效环境变量
```

### 1. 沙箱本身是产品能力

`src/host-sandbox.ts` + 工作区的 `container_config.hostSandbox`：

```json
{
  "version": 1,
  "hostSandbox": {
    "provider": "bwrap",
    "readablePaths": ["/mnt/my-work/incident-lab/sandbox"],
    "env": { "PATH": "...", "INCIDENT_FACTS_SOCKET": "..." }
  }
}
```

- **不配就一个字都不变**：没有 `hostSandbox` 的工作区，spawn 路径与从前一模一样。
- **配置坏了就拒绝跑**：不静默回退到无沙箱 spawn。沙箱丢了一条路径 = 沙箱没生效。
- 姿态是**白名单**：只 bind 跑起来真正需要的路径，其余一律看不见。
- `HOME` 换成空 tmpfs。家目录是凭据与答案键最爱待的地方。
- **不隔离 PID 命名空间**：`/proc` 要留着——只读通道用 `lsof` 推靶子的进程锚点，
  隔离 PID 会让那个通道说谎。
- **不隔离网络**：靶子、Prometheus、模型端点都要通。

### 2. docker shim：授能力，不授 socket

沙箱里没有 `/var/run/docker.sock`。给了 socket 就等于给了宿主机 root
（`docker run -v /:/mnt` 能把整个文件系统读出来，沙箱当场作废）。

但 `runtime env` 与 `runtime started` 这两个**合法通道**要问靶子容器两件事。
不能靠删通道换安全，正确做法是把这个能力从"整个 docker API"缩成"两件事"：

- 沙箱里的 `docker` 是 [bin/docker](bin/docker) 这个 shim，只认
  `docker inspect <容器> --format <格式>`，且容器名与格式都要在放行名单里。
- shim 把请求转给 unix socket 上的**靶子事实服务**
  （[target-facts-server.mjs](target-facts-server.mjs)），那个进程跑在沙箱外面，
  有 docker 权限，由它代答。
- 其余子命令、其余容器、其余格式一律拒绝。

于是沙箱授的是**一个能力**，不是一个能提权的 socket。

### 3. 控制（负对照）

[sandbox-control.mjs](sandbox-control.mjs) 用**产品真实的那段代码**搭沙箱，
把探针塞进去逐条断言：

- 该不可见的路径确实不可见（答案键、凭据、注入脚本、docker socket、家目录）
- 该可见的路径确实可见（工作区）
- 合法通道仍然可用（metrics / logs / git / runtime env / runtime started）
- shim 只放行两个格式，其余一律拒绝
- **负对照**：同一串探针**不带沙箱**跑一遍，必须读到本该读不到的东西。
  读不到洞 = 这把尺子测不出东西 = 刚才的"全绿"不算数。

```bash
node incident/sandbox/sandbox-control.mjs
```

## 怎么用

```bash
# 1. 部署沙箱副本（仓库外）
node incident/runs/sync-sandbox.mjs

# 2. 起事实服务（沙箱里 docker shim 的后端）
incident/lab.sh facts start

# 3. 给三个工作区装上沙箱配置
node incident/sandbox/apply-sandbox.mjs --apply

# 4. 验证
node incident/sandbox/sandbox-control.mjs
```

`run-round.mjs` 的 **P13 闸门**守第 2、3 步：沙箱没开、或事实服务不通，
那一轮**不开跑**。理由是事实服务挂了以后 `runtime env` 会在轮次中途静默失效，
Agent 只会说"证据不足"——没人看得出那是台子的问题，不是诊断的问题。

## 已知边界

- **沙箱是文件系统边界，不是网络边界**。沙箱里的 Agent 仍能访问宿主机的网络
  （公司内网也在内）。要收紧得另做（Landlock 网络规则要 ABI v4+，本机内核 6.6
  只有 v3；或者走网络命名空间 + 代理）。
- **`/proc` 可见**，所以沙箱里的 Agent 看得到宿主机的进程表。
- **白名单里的路径等于对 Agent 开放**。给沙箱加 `readablePaths` 之前先问一句：
  这条路径里有没有答案键。
- **host 模式本身仍然是 admin 权限**。沙箱是给实验台用的边界，不是给普通用户的
  权限模型；普通用户的工作区该走容器模式。
