#!/bin/sh
# Validates the container setup (W1-20). Needs a running Docker daemon; builds the image locally,
# never pushes it. Usage: docker/validate.sh [image-tag]
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${1:-eng-digest:validate}"
cd "$ROOT"

# Run the same way on every machine: no profile or project .env from the caller.
unset COMPOSE_PROFILES
compose() { docker compose --env-file /dev/null "$@"; }

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
pass() { echo "ok:   $*"; }

# docker compose config only reads files; it needs neither a daemon nor .env.
services() { compose "$@" config --services | sort | tr '\n' ' '; }

check_compose() {
  for profile in "" linux tracing; do
    if [ -n "$profile" ]; then set -- --profile "$profile"; else set --; fi
    compose "$@" config -q || fail "compose config invalid for profile '${profile:-default}'"
    pass "compose config valid for profile '${profile:-default}'"
  done
  [ "$(services)" = "digest " ] || fail "default profile must start only digest, got: $(services)"
  [ "$(services --profile linux)" = "digest model-pull ollama " ] ||
    fail "linux profile services: $(services --profile linux)"
  [ "$(services --profile tracing)" = "digest jaeger " ] ||
    fail "tracing profile services: $(services --profile tracing)"
  pass "each profile starts the expected services"
}

check_pull_script() {
  sh -n docker/pull-models.sh || fail "docker/pull-models.sh has a syntax error"
  expected="$(pnpm --silent exec tsx docker/printLinuxModels.mjs)"
  actual="$(DIGEST_CONFIG=/nonexistent sh docker/pull-models.sh --list)"
  [ "$expected" = "$actual" ] ||
    fail "pull-models.sh is out of sync with src/config/profiles.ts: wanted [$expected] got [$actual]"
  pass "pull-models.sh matches the Linux model set in profiles.ts"

  override="$(mktemp)"
  printf '{ "models": {\n "writers": [\n "qwen3.8:27b",\n "gemma4:31b"\n ] } }\n' >"$override"
  actual="$(DIGEST_CONFIG="$override" sh docker/pull-models.sh --list | tr '\n' ' ')"
  rm -f "$override"
  [ "$actual" = "clef:latest granite4.1-guardian:8b qwen3.8:27b gemma4:31b " ] ||
    fail "pull-models.sh ignores models.writers from the config: got [$actual]"
  pass "pull-models.sh honors models.writers from the config"
}

check_image() {
  docker build --tag "$IMAGE" . || fail "docker build failed"
  pass "docker build succeeded"

  help="$(docker run --rm "$IMAGE" --help)" || fail "--help exited non-zero"
  for command in init doctor run eval history serve; do
    printf '%s\n' "$help" | grep -q "^  $command" || fail "--help does not list '$command'"
  done
  pass "--help lists every command"

  uid="$(docker run --rm --entrypoint id "$IMAGE" -u)"
  [ "$uid" != "0" ] || fail "image runs as root"
  user="$(docker image inspect --format '{{.Config.User}}' "$IMAGE")"
  [ -n "$user" ] && [ "$user" != "root" ] && [ "$user" != "0" ] ||
    fail "image USER is '${user}', expected a non-root user"
  pass "image runs as non-root uid $uid ($user)"

  docker run --rm --entrypoint sh "$IMAGE" -c \
    'test -z "$(find / -xdev \( -name ".env" -o -name ".env.*" -o -name "digest.config.json" \) -not -path "/proc/*" 2>/dev/null)"' ||
    fail "the image contains a .env or digest.config.json"
  pass "the image contains no .env or digest.config.json"
}

check_compose
check_pull_script
check_image
echo "All container checks passed."
