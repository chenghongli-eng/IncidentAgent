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

case "$cmd" in
  up)       exec "${COMPOSE[@]}" up -d "$@" ;;
  recreate) exec "${COMPOSE[@]}" up -d --force-recreate --no-deps "$@" ;;
  build)    exec "${COMPOSE[@]}" up -d --build "$@" ;;
  ps)       exec "${COMPOSE[@]}" ps "$@" ;;
  down)     exec "${COMPOSE[@]}" down "$@" ;;
  logs)     exec "${COMPOSE[@]}" logs -f "$@" ;;
  *)
    echo "usage: lab.sh {up|recreate|build|ps|down|logs} [args...]" >&2
    exit 2
    ;;
esac
