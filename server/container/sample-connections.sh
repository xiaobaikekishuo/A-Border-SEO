#!/bin/bash
set -euo pipefail

samples=${1:-60}
interval=${2:-5}
if [[ $# -gt 2 || ! $samples =~ ^[1-9][0-9]{0,2}$ || ! $interval =~ ^[1-9][0-9]?$ ]] || ((samples > 720 || interval > 60)); then
  echo 'Usage: bash sample-connections.sh [samples: 1..720] [interval_seconds: 1..60]' >&2
  exit 2
fi
root=/www/aborder-hosted
compose=(docker compose --project-directory "$root" --env-file "$root/config/compose.env" -p aborder-hosted -f "$root/compose.yml")
sql="SELECT count(*), count(*) FILTER (WHERE state = 'active'),
       count(*) FILTER (WHERE state LIKE 'idle in transaction%'),
       current_setting('max_connections')::int - current_setting('superuser_reserved_connections')::int
         - current_setting('reserved_connections')::int
     FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()"
peak=0
minimum_free=
printf 'utc clients active idle_in_transaction ordinary_limit ordinary_headroom\n'
for ((i=1; i<=samples; i++)); do
  row=$("${compose[@]}" exec -T database psql -XAtqw -U postgres -d postgres -v ON_ERROR_STOP=1 -F ' ' -c "$sql")
  read -r clients active idle limit <<< "$row"
  [[ $row =~ ^[0-9]+\ [0-9]+\ [0-9]+\ [0-9]+$ ]] || { echo 'Invalid connection sample.' >&2; exit 1; }
  free=$((limit - clients))
  if ((free < 0)); then free=0; fi
  if ((clients > peak)); then peak=$clients; fi
  if [[ -z $minimum_free ]] || ((free < minimum_free)); then minimum_free=$free; fi
  printf '%s %s %s\n' "$(date -u +%FT%TZ)" "$row" "$free"
  if ((i < samples)); then sleep "$interval"; fi
done
printf 'samples=%d peak_clients=%d min_ordinary_headroom=%d\n' "$samples" "$peak" "$minimum_free"
