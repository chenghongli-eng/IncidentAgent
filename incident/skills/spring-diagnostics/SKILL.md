---
name: spring-diagnostics
description: 通过 Actuator 端点采集运行时证据（健康、线程栈、配置、连接池、日志级别）。当怀疑资源类或外部依赖类故障、或日志不足以定位时使用。
---

# spring-diagnostics

日志之外的第二条证据通道，专治**日志说不清**的场景：线程卡住、连接池打满、配置漂移。

## 端点

```bash
LAB='node "$INCIDENT_LAB"'

$LAB actuator health        # 组件健康，依赖是否 DOWN
$LAB actuator threaddump    # 线程栈，看是否有请求阻塞在连接获取或下游调用
$LAB actuator env           # 生效配置，看 timeout / pool size / 开关
$LAB actuator configprops   # 配置项来源与生效值
$LAB actuator metrics       # JVM、Hikari、HTTP 指标
$LAB runtime env            # 旋钮的生效值（actuator 读不到，用这个）
```

## 判断启发

| 观察 | 指向 |
| --- | --- |
| `health` 中某依赖 DOWN | 外部依赖故障 → **优先怀疑它，不要先查发布** |
| threaddump 中大量线程阻塞在 `HikariPool.getConnection` | 连接池耗尽，属于资源类 |
| threaddump 中线程停在 socketRead / 下游调用 | 下游超时或不可用 |
| `runtime env` 中 pool size 被压到极小、timeout 被调小 | 配置类变更，且是**当前生效值**，不是仓库里的值 |
| `metrics` 中堆内存持续增长 | 泄漏类，需要引入泄漏采样 |
| `health` 正常但错误率仍高 | 故障在应用逻辑层，回到日志与代码 |

> `actuator env` 与 `actuator configprops` 的**值全部被掩码成 `******`**
> （`show-values=never`），它们只能证明"配置项存在"，不能证明"生效值是多少"。
> 要拿生效值就用 `runtime env`。**不要**因为 actuator 读不到就去容器外面找配置文件读。

## 输出

给出**一条**决定性的运行时观察，加支撑它的端点输出片段：

```text
运行时证据：health 报 db DOWN / 线程 42 个阻塞在 HikariPool.getConnection
结论方向：资源或依赖类故障，非发布类
```

## 边界

这些端点是**只读 GET**。不要尝试 `POST`、`DELETE`、shutdown 或修改 logger 级别——
本次诊断不授予任何写权限，误触会越过人工审批边界。

`actuator/env` 可能包含连接串或密钥。**引用时只摘取与故障相关的配置项，不要整段粘贴。**