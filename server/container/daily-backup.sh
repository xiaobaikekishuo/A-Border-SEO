#!/bin/bash
set -Eeuo pipefail
umask 077
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C
ROOT=/www/aborder-hosted
PROJECT=aborder-hosted
WARN_BYTES=$((5 * 1024 * 1024 * 1024))
STOP_BYTES=$((1024 * 1024 * 1024))
[[ $# = 1 && $1 = --run ]] || { echo 'Usage: bash daily-backup.sh --run' >&2; exit 1; }
test "$(id -u)" = 0
test "$(readlink -f "$ROOT")" = "$ROOT"
test "$(stat -c '%u:%a' "$ROOT")" = 0:700
test ! -L "$ROOT/manage-host.sh"
test "$(stat -c '%u:%a' "$ROOT/manage-host.sh")" = 0:600
for directory in logs backups; do
  if test ! -e "$ROOT/$directory"; then mkdir -m 700 "$ROOT/$directory"; fi
  test ! -L "$ROOT/$directory"
  test "$(readlink -f "$ROOT/$directory")" = "$ROOT/$directory"
  test "$(stat -c '%u:%a' "$ROOT/$directory")" = 0:700
done
test ! -L "$ROOT/.daily-backup.lock"
exec 8>"$ROOT/.daily-backup.lock"
flock -n 8 || { echo 'Daily hosted backup is already running.' >&2; exit 75; }
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
LOG="$ROOT/logs/backup-$RUN_ID.log"
(set -o noclobber; : > "$LOG")
chmod 600 "$LOG"
exec >>"$LOG" 2>&1
STATUS="$ROOT/logs/backup.status"
test ! -L "$STATUS"
status() {
  local state=$1 message=$2 temporary="$ROOT/logs/.backup-status-$RUN_ID"
  (set -o noclobber; printf 'time=%s\nstate=%s\nmessage=%s\nlog=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$state" "$message" "$LOG" > "$temporary")
  mv -f -- "$temporary" "$STATUS"
  # Syslog receives only a fixed summary, never tool output or configuration.
  logger -t aborder-hosted-backup -- "$state: $message; private log $LOG" || true
}
failed() {
  local code=$?
  trap - ERR
  status failed 'Backup failed; retained all previous backups; inspect private log.' || true
  exit "$code"
}
trap failed ERR
status running 'Daily backup started.'
volume="${PROJECT}_database-data"
test "$(docker volume inspect --format '{{index .Labels "com.docker.compose.project"}}' "$volume")" = "$PROJECT"
DATABASE_PATH=$(docker volume inspect --format '{{.Mountpoint}}' "$volume")
[[ $DATABASE_PATH = /* && $(readlink -f "$DATABASE_PATH") = "$DATABASE_PATH" ]]
available_bytes() {
  local value
  value=$(df -Pk -- "$1" | awk 'NR==2 {printf "%.0f", $4 * 1024}')
  [[ $value =~ ^[0-9]+$ ]] && printf '%s\n' "$value"
}
warning=no
for location in "$ROOT/backups" "$DATABASE_PATH"; do
  available=$(available_bytes "$location")
  printf 'Storage check: %s available_bytes=%s\n' "$location" "$available"
  if (( available < STOP_BYTES )); then
    status low_space 'Less than 1 GiB free on backup or database filesystem; backup skipped; no files deleted.'
    exit 2
  fi
  if (( available < WARN_BYTES )); then warning=yes; fi
done
if test "$warning" = yes; then
  status warning 'Less than 5 GiB free on backup or database filesystem; monitor storage; backup continues.'
fi
# manage-host.sh has the shared deployment flock and project ownership checks.
# Its PG preflight additionally requires max(256 MiB, 1.5 x database size).
# It creates COMPLETE only after PG, CP, configuration and image pins succeed.
bash "$ROOT/manage-host.sh" backup --run
if test "$warning" = yes; then
  status success_low_space 'Backup completed; free space is below 5 GiB; retain and monitor backups.'
else
  status success 'Backup completed; previous backups retained.'
fi
trap - ERR
