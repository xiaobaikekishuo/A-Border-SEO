#!/bin/bash
set -euo pipefail
umask 077
if [[ ${1:-} != --run || $# -gt 2 ]]; then
  printf '%s\n' 'Usage: bash smoke-host.sh --run [node:24-bookworm-slim-or-runtime-image]'
  exit 1
fi
test "$(id -u)" = 0
base=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
image=${2:-node:24-bookworm-slim}
# No services, existing containers or volumes are changed. The temporary
# container has no network and a read-only root, with only a private tmpfs.
docker run --rm --network none --read-only --tmpfs /tmp:rw,nosuid,nodev,size=64m \
  --memory 192m --cpus 0.25 --pids-limit 64 \
  --mount "type=bind,src=$base/smoke.mjs,dst=/smoke.mjs,readonly" \
  --entrypoint node "$image" /smoke.mjs
