#!/bin/bash
set -euo pipefail
umask 077
if [[ $# != 3 || $1 != --run || ! $2 =~ ^[a-f0-9]{64}$ || ! $3 =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo 'Usage: bash build-on-host.sh --run BUNDLE_SHA256 RELEASE_VERSION' >&2
  exit 1
fi
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
test -f bundle.tar.gz
printf '%s  bundle.tar.gz\n' "$2" | sha256sum --check -
version=$3
docker build --platform linux/amd64 -f Dockerfile.runtime --build-arg "BUNDLE_SHA256=$2" \
  --build-arg "RELEASE_VERSION=$version" -t "aborder-hosted-app:$version" .
docker build --platform linux/amd64 -f Dockerfile.control --build-arg "RELEASE_VERSION=$version" \
  -t "aborder-hosted-control:$version" .
docker pull --platform linux/amd64 postgres:16-bookworm
postgres_id=$(docker image inspect --format '{{.Id}}' postgres:16-bookworm)
docker tag "$postgres_id" "aborder-hosted-postgres:16-${postgres_id:7:12}"
{
  printf 'HOSTED_APP_IMAGE=%s\n' "$(docker image inspect --format '{{.Id}}' "aborder-hosted-app:$version")"
  printf 'HOSTED_CONTROL_IMAGE=%s\n' "$(docker image inspect --format '{{.Id}}' "aborder-hosted-control:$version")"
  printf 'HOSTED_POSTGRES_IMAGE=%s\n' "$postgres_id"
} > compose.pins.env
chmod 600 compose.pins.env
echo 'Images built; immutable pins saved to compose.pins.env. No service was started or replaced.'
