#!/usr/bin/env bash
# Wrapper for every docker compose call in the incident lab.
#
# Two reasons this exists:
#
# 1. The fault knobs live outside the repository. The diagnosis agent runs with
#    this directory as its workspace, so a knob file sitting here would be an
#    evidence path that bypasses the read-only channels — the agent could read
#    the value that is supposed to be discoverable only through `runtime env`.
# 2. `docker compose` silently resets the knobs to the defaults in
#    docker-compose.yml when it cannot find a .env file. Every call therefore
#    passes --env-file, and a missing env file is a hard error rather than a
#    silent reset that fabricates a fault.
set -euo pipefail

LAB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB_ENV="${LAB_ENV:-$HOME/.config/miniclaw-lab/lab.env}"
COMPOSE=(docker compose --env-file "$LAB_ENV" -f "$LAB_DIR/docker-compose.yml")

if [[ ! -f "$LAB_ENV" ]]; then
  echo "missing lab env file: $LAB_ENV" >&2
  echo "create it with:" >&2
  echo "  mkdir -p \"\$(dirname \"$LAB_ENV\")\" && cp \"$LAB_DIR/lab.env.example\" \"$LAB_ENV\"" >&2
  exit 1
fi

# 制品自述：构建时把 git HEAD 打进 OCI label（org.opencontainers.image.revision）。
# 这一行是部署台账里最硬的那档凭据——没有它，「哪个 commit 跑起来的」
# 只能按构建时刻猜，实测在本项目上会错。构建上下文是**工作区**里的
# target-service 仓库（路径真相源 incident/lab-paths.json）。
BUILD_CONTEXT="$(node -e '
const fs = require("node:fs");
const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
process.stdout.write(p.serviceDir);
' "$LAB_DIR/lab-paths.json")"
GIT_COMMIT="$(git -C "$BUILD_CONTEXT" rev-parse HEAD 2>/dev/null || true)"
if [[ -z "$GIT_COMMIT" ]]; then
  GIT_COMMIT="unknown"
  echo "note: 取不到构建上下文的 git HEAD，OCI label 记为 unknown" >&2
fi
export GIT_COMMIT

# 构建时刻也打进镜像自己的 label（compose build.labels 里
# io.incident-lab.build-time）。
#
# 为什么不能直接用 `docker image inspect` 的 Created：BuildKit 命中缓存时，
# 镜像 config 里的 created 是**最早那一层的**时间戳，不是这次构建的时间。
# 实测：改完内容重新构建，digest 变了，created 仍停在第一次构建那个纳秒级
# 不变的值——台账的 built_at 会在「这个 commit 是哪天构建的」这个问题上撒谎。
#
# 为什么不用 org.opencontainers.image.created 这个标准 label：基础镜像
# (ubuntu) 已经带了这个 label，它说的是**基础镜像**的构建时间，混用会把
# 基础镜像的时间当成我们的构建时间。用一个自己的命名空间，不与基础镜像撞。
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export BUILD_TIME

cmd="${1:-up}"
shift || true

# ── 靶子事实服务（沙箱的窄通道后端）───────────────────────────────────────────
#
# 沙箱里没有 docker socket（给了就等于给了宿主机 root）。但 `runtime env` 与
# `runtime started` 这两个合法通道要问靶子容器两件事：启动时刻、生效环境变量。
#
# 这两件事由本服务在**沙箱外面**回答：它跑在宿主机上（有 docker 权限），通过一
# 个 unix socket 只回答这两个问题。它不是 docker 代理——容器名与 --format 都有
# 放行名单，其余一律拒绝。
#
# 它必须活着：它挂了，沙箱里的 runtime env 会在轮次中途静默失效，Agent 只会说
# 「证据不足」，没人看得出那是台子的问题。run-round.mjs 的 P13 闸门守这一条。
FACTS_SERVER="${INCIDENT_FACTS_SERVER:-node ${LAB_DIR}/sandbox/target-facts-server.mjs}"
# 运行目录在仓库外（与部署副本同住），pid 文件跟着它走。
FACTS_STATE_DIR="$(node -e "process.stdout.write(require('${LAB_DIR}/sandbox/policy.json').stateDir)")"
FACTS_PID_FILE="${FACTS_STATE_DIR}/target-facts-server.pid"

facts_status() {
  if [[ -f "$FACTS_PID_FILE" ]] && kill -0 "$(cat "$FACTS_PID_FILE")" 2>/dev/null; then
    echo "target-facts-server: running (pid $(cat "$FACTS_PID_FILE"))"
    return 0
  fi
  echo "target-facts-server: not running"
  return 1
}

facts_start() {
  if facts_status >/dev/null; then
    echo "target-facts-server: 已在跑"
    return 0
  fi
  mkdir -p "$(dirname "$FACTS_PID_FILE")"
  nohup $FACTS_SERVER >/dev/null 2>&1 &
  echo $! > "$FACTS_PID_FILE"
  sleep 1
  facts_status
}

facts_stop() {
  if [[ -f "$FACTS_PID_FILE" ]]; then
    kill "$(cat "$FACTS_PID_FILE")" 2>/dev/null || true
    rm -f "$FACTS_PID_FILE"
  fi
  echo "target-facts-server: stopped"
}

case "$cmd" in
  up)
    exec "${COMPOSE[@]}" up -d "$@"
    ;;
  recreate) exec "${COMPOSE[@]}" up -d --force-recreate --no-deps "$@" ;;
  build)    exec "${COMPOSE[@]}" up -d --build "$@" ;;
  ps)       exec "${COMPOSE[@]}" ps "$@" ;;
  down)     exec "${COMPOSE[@]}" down "$@" ;;
  logs)     exec "${COMPOSE[@]}" logs -f "$@" ;;
  facts)
    case "${1:-status}" in
      start)   facts_start ;;
      stop)    facts_stop ;;
      status)  facts_status ;;
      check)   node "${LAB_DIR}/sandbox/target-facts-server.mjs" --check ;;
      *)
        echo "usage: lab.sh facts {start|stop|status|check}" >&2
        exit 2
        ;;
    esac
    ;;
  *)
    echo "usage: lab.sh {up|recreate|build|ps|down|logs|facts} [args...]" >&2
    exit 2
    ;;
esac
