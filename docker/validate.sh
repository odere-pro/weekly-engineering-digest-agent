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

# The Compose settings that the container work (W2-06) relies on.
check_compose_settings() {
  config="$(DIGEST_HOST_OS=darwin DIGEST_HOST_ARCH=arm64 compose config)" ||
    fail "compose config failed with the host variables set"
  for setting in 'DIGEST_HOST_OS: darwin' 'DIGEST_HOST_ARCH: arm64' 'stop_grace_period: 30m'; do
    printf '%s\n' "$config" | grep -q "$setting" || fail "digest service lacks '$setting'"
  done
  compose --profile linux config | grep -q 'OLLAMA_MAX_LOADED_MODELS: "1"' ||
    fail "the ollama service must set OLLAMA_MAX_LOADED_MODELS=1"
  pass "digest gets the host OS and CPU and a long stop grace period; ollama keeps one model loaded"

  # Compose reads .env for interpolation, so a copied example must not set the endpoint.
  if grep -q '^[[:space:]]*OLLAMA_URL=' .env.example; then
    fail ".env.example sets OLLAMA_URL: a copied .env would override the Compose default"
  fi
  pass ".env.example leaves OLLAMA_URL unset"
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

# `make docker-init` creates empty files and mounts them one by one: renaming a temp file onto a
# single-file bind mount fails, and /app is not writable for the node user.
check_init() {
  dir="$(mktemp -d)"
  : >"$dir/digest.config.json"
  (umask 077 && : >"$dir/.env")
  if ! docker run --rm --user "$(id -u):$(id -g)" -e DIGEST_HOST_OS=darwin -e TZ=Europe/Berlin \
    -v "$dir/digest.config.json:/app/digest.config.json" -v "$dir/.env:/app/.env" \
    "$IMAGE" init --yes >/dev/null; then
    rm -rf "$dir"
    fail "init --yes failed on empty single-file bind mounts"
  fi
  grep -q '"timeZone": "Europe/Berlin"' "$dir/digest.config.json" ||
    { rm -rf "$dir"; fail "init did not write schedule.timeZone"; }
  grep -q '^OLLAMA_URL=http://host.docker.internal:11434$' "$dir/.env" ||
    { rm -rf "$dir"; fail "init did not point a Mac host at host.docker.internal"; }
  mode="$(stat -c %a "$dir/.env" 2>/dev/null || stat -f %Lp "$dir/.env")"
  rm -rf "$dir"
  [ "$mode" = "600" ] || fail ".env must stay mode 600, got $mode"
  pass "init --yes writes both single-file bind mounts in place, .env stays 600"
}

check_compose
check_compose_settings
check_pull_script
check_image
check_init
echo "All container checks passed."
