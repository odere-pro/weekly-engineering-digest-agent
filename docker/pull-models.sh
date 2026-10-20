#!/bin/sh
# Pulls the Ollama models the digest service needs inside Docker (Compose profile `linux`).
# Runs in the ollama/ollama image: POSIX sh, the `ollama` CLI and sed only (no node, no jq).
#
# KEEP IN SYNC with NON_MAC_FALLBACK in src/config/profiles.ts. The container is Linux, so every
# profile resolves to that fallback (see resolveProfile); only `models.writers` from the config
# changes the set. test/integration/pullModels.test.ts (part of `pnpm check`) and, with docker,
# docker/validate.sh compare this list with profiles.ts.
#
# Usage: pull-models.sh [--list]     (--list prints the tags instead of pulling)
# Environment: DIGEST_CONFIG (default /app/digest.config.json), OLLAMA_HOST (read by the CLI),
# REFRESH_MODELS=1 (pull models that are already present; by default they are skipped, so a
# restart works offline once the models are cached).
set -eu

CONFIG="${DIGEST_CONFIG:-/app/digest.config.json}"

# classify and guardPolicy (clef), guardRisk (granite), then the default writer.
FIXED_MODELS="clef:latest granite4.1-guardian:8b"
DEFAULT_WRITERS="gemma4:31b"

# The strings in `models.writers`, one per line. Empty when the config has no override.
configured_writers() {
  [ -r "$CONFIG" ] || return 0
  tr -d '\n' <"$CONFIG" |
    sed -n 's/.*"writers"[[:space:]]*:[[:space:]]*\[\([^]]*\)\].*/\1/p' |
    tr ',' '\n' |
    sed 's/^[[:space:]]*"//; s/"[[:space:]]*$//' |
    grep -v '^$' || true
}

# The unique tags, in pull order.
required_models() {
  writers="$(configured_writers)"
  [ -n "$writers" ] || writers="$DEFAULT_WRITERS"
  {
    for tag in $FIXED_MODELS; do echo "$tag"; done
    printf '%s\n' "$writers"
  } | awk '!seen[$0]++'
}

if [ "${1:-}" = "--list" ]; then
  required_models
  exit 0
fi

if [ ! -r "$CONFIG" ]; then
  echo "No readable config at $CONFIG: pulling the default models." >&2
fi

required_models | while read -r tag; do
  if [ -z "${REFRESH_MODELS:-}" ] && ollama show "$tag" >/dev/null 2>&1 </dev/null; then
    echo "Already present: $tag"
    continue
  fi
  echo "Pulling $tag"
  ollama pull "$tag" </dev/null
done
echo "All models are ready."
