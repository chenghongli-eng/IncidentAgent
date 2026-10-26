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
