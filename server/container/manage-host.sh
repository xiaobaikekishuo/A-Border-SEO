#!/bin/bash
set -Eeuo pipefail
umask 077
ROOT=/www/aborder-hosted
PROJECT=aborder-hosted
if [[ $# -lt 2 || ${!#} != --run ]]; then
  printf '%s\n' 'Usage: bash manage-host.sh import-control SHA256 --run' \
    '  bash manage-host.sh prepare --run' '  bash manage-host.sh deploy NEW_PINS.env --run' \
    '  bash manage-host.sh deploy-release RELEASE_PINS.env --run' \
    '  bash manage-host.sh rollback OLD_PINS.env --run' '  bash manage-host.sh backup --run' \
    '  bash manage-host.sh restore BACKUP_ID aborder_restore_NAME --run'
  exit 1
fi
test "$(id -u)" = 0
test "$(readlink -f "$ROOT")" = "$ROOT"
test "$(stat -c %u "$ROOT")" = 0
docker compose version >/dev/null
mkdir -p -m 700 "$ROOT/backups" "$ROOT/import"
exec 9>"$ROOT/.operation.lock"
flock -n 9 || { echo 'Another hosted deployment/backup is active.' >&2; exit 1; }
cd -- "$ROOT"
command=$1
compose() { docker compose --project-directory "$ROOT" --env-file "$ROOT/config/compose.env" -p "$PROJECT" -f "$ROOT/compose.yml" "$@"; }
private_file() { test "$(stat -c '%u:%a' "$1")" = 0:600 && test ! -L "$1"; }
for file in application.env database.env control.env compose.env; do private_file "$ROOT/config/$file"; done
test "$(stat -c '%u:%g:%a' "$ROOT/config/signing.pem")" = 0:10001:440
test ! -L "$ROOT/config/signing.pem"
valid_pins() {
  private_file "$1"
  test "$(grep -Ec '^HOSTED_(APP|CONTROL|POSTGRES)_IMAGE=sha256:[a-f0-9]{64}$' "$1")" = 3
  test "$(grep -Ec '^[^#[:space:]]' "$1")" = 3
  for kind in APP CONTROL POSTGRES; do test "$(grep -c "^HOSTED_${kind}_IMAGE=" "$1")" = 1; done
}
image_for() { sed -n "s/^HOSTED_${1}_IMAGE=//p" "$2"; }
install_pins() {
  local temporary
  temporary=$(mktemp "$ROOT/config/.compose.env.XXXXXXXX") || return
  if cp "$1" "$temporary" && mv -f -- "$temporary" "$ROOT/config/compose.env"; then return 0; fi
  rm -f -- "$temporary"
  return 1
}
owned_resources() {
  local container volume network
  while IFS= read -r container; do
    test -z "$container" && continue
    test "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$container")" = "$ROOT"
  done < <(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")
  for volume in "${PROJECT}_database-data" "${PROJECT}_control-data" "${PROJECT}_app-cache"; do
    if docker volume inspect "$volume" >/dev/null 2>&1; then
      test "$(docker volume inspect --format '{{index .Labels "com.docker.compose.project"}}' "$volume")" = "$PROJECT"
    fi
  done
  network="${PROJECT}_business"
  if docker network inspect "$network" >/dev/null 2>&1; then
    test "$(docker network inspect --format '{{index .Labels "com.docker.compose.project"}}' "$network")" = "$PROJECT"
  fi
}
running_state() {
  local id running
  id=$(compose ps -q "$1") || return
  if [[ -z $id ]]; then echo no; return; fi
  running=$(docker inspect --format '{{.State.Running}}' "$id") || return
  case "$running" in true) echo yes ;; false) echo no ;; *) return 1 ;; esac
}
tool() { compose run --rm --no-deps -T tooling "$@"; }
control_tool() { compose run --rm --no-deps -T control-tools "$@"; }
config_hashes() { sha256sum config/application.env config/database.env config/control.env config/signing.pem; }
stop_business() { compose stop -t 60 worker app >/dev/null; }
remove_stopped_business() {
  local service id status
  for service in worker app; do
    id=$(compose ps -a -q "$service") || return
    test -z "$id" && continue
    test "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$id")" = "$PROJECT" || return
    test "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$id")" = "$service" || return
    status=$(docker inspect --format '{{.State.Status}}' "$id") || return
    [[ $status = exited || $status = created ]] || return 1
    # Exact, stopped business containers only. Never remove a volume or DB.
    docker rm "$id" >/dev/null || return
  done
}
new_destination() {
  BACKUP_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
  mkdir -m 700 "$ROOT/backups/$BACKUP_ID"
  cp -p config/compose.env config/application.env config/database.env config/control.env config/signing.pem "$ROOT/backups/$BACKUP_ID/"
  chmod 600 "$ROOT/backups/$BACKUP_ID/"*.env "$ROOT/backups/$BACKUP_ID/signing.pem"
  config_hashes > "$ROOT/backups/$BACKUP_ID/config.before"
}
backup_all() {
  new_destination
  tool backup "$BACKUP_ID"
  control_tool backup "$BACKUP_ID"
  tool ledger > "$ROOT/backups/$BACKUP_ID/migrations.before"
  control_tool schema > "$ROOT/backups/$BACKUP_ID/control-schema.before"
  local marker="$ROOT/backups/$BACKUP_ID/COMPLETE"
  printf 'Database, control snapshot, secrets and image pins verified.\n' > "$marker.tmp"
  mv -- "$marker.tmp" "$marker"
  printf 'Verified backup: %s\n' "$ROOT/backups/$BACKUP_ID"
}
verify_images() {
  local file=$1 app control database
  valid_pins "$file"
  app=$(image_for APP "$file"); control=$(image_for CONTROL "$file"); database=$(image_for POSTGRES "$file")
  test "$(docker image inspect --format '{{index .Config.Labels "com.aborder-seo.role"}}' "$app")" = hosted-app
  test "$(docker image inspect --format '{{index .Config.Labels "com.aborder-seo.role"}}' "$control")" = control-plane
  test "$(docker image inspect --format '{{index .Config.Labels "com.aborder-seo.version"}}' "$app")" = "$(docker image inspect --format '{{index .Config.Labels "com.aborder-seo.version"}}' "$control")"
  for image in "$app" "$control" "$database"; do
    test "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")" = linux/amd64
  done
  bash "$ROOT/smoke-host.sh" --run "$app"
  bash "$ROOT/smoke-host.sh" --run "$control"
  docker run --rm --network none --read-only --entrypoint postgres "$database" --version | grep -Eq 'PostgreSQL\) 16\.'
}
health_app() {
  local expected id
  expected=$(docker image inspect --format '{{index .Config.Labels "com.aborder-seo.version"}}' "$(image_for APP config/compose.env)")
  for ((i=0;i<75;i++)); do
    id=$(compose ps -q app)
    if test -n "$id" && docker exec "$id" node -e \
      'fetch("http://127.0.0.1:18330/api/health").then(async r=>{const x=await r.json();process.exit(r.ok&&x.status==="ok"&&x.hostedMode===true&&x.version===process.argv[1]?0:1)}).catch(()=>process.exit(1))' "$expected"; then return 0; fi
    sleep 1
  done
  return 1
}
health_worker() {
  local id
  for ((i=0;i<40;i++)); do
    id=$(compose ps -q worker)
    if test -n "$id" && docker exec "$id" node -e \
      'try{process.exit(Date.now()-require("fs").statSync("/tmp/worker-alive").mtimeMs<40000?0:1)}catch{process.exit(1)}'; then return 0; fi
    sleep 1
  done
  return 1
}
start_selected() {
  local app=$1 worker=$2
  if test "$app" = yes; then compose up -d --no-deps --force-recreate app >/dev/null || return; health_app || return; fi
  if test "$worker" = yes; then compose up -d --no-deps --force-recreate worker >/dev/null || return; health_worker || return; fi
}
resume_before_image_change() {
  local service failed=0
  for service in app worker; do
    if [[ $service = app && $active_app = no || $service = worker && $active_worker = no ]]; then continue; fi
    # The original containers still exist, including after a partially failed stop.
    if compose start "$service" >/dev/null && "health_$service"; then
      printf 'Prior %s service is healthy.\n' "$service" >&2
    else
      printf 'Failed to resume or verify the prior %s service.\n' "$service" >&2
      failed=1
    fi
  done
  return "$failed"
}
owned_resources
valid_pins config/compose.env
case "$command" in
  import-control)
    test $# = 3
    [[ $2 =~ ^[a-f0-9]{64}$ ]]
    private_file "$ROOT/import/control.sqlite"
    control_tool import "$2"
    ;;
  prepare)
    test $# = 2
    verify_images config/compose.env
    control_tool check
    new_destination
    control_tool backup "$BACKUP_ID"
    control_tool init-cache
    # This starts only this project's private PostgreSQL and control services.
    # The imported control snapshot has been backed up before CP can migrate it.
    compose up -d --wait database control
    tool bootstrap
    tool check-control
    echo 'Private database/control prepared. Business services remain stopped.'
    ;;
  backup)
    test $# = 2
    backup_all
    ;;
  restore)
    test $# = 4
    [[ $2 =~ ^[A-Za-z0-9_-]{1,80}$ && $3 =~ ^aborder_restore_[a-z0-9_]{1,40}$ ]]
    test -f "$ROOT/backups/$2/COMPLETE"
    tool restore "$2" "$3"
    ;;
  deploy|deploy-release|rollback)
    test $# = 3
    incoming=$(readlink -f "$2")
    release_pins=
    if [[ $command = deploy-release ]]; then
      # Published releases can carry a newer PG16 image for fresh installations.
      # Keep the currently running database pin during an application upgrade.
      valid_pins "$incoming"
      release_pins=$(mktemp "$ROOT/config/.release.XXXXXXXX")
      trap 'rm -f -- "$release_pins"' EXIT
      {
        printf 'HOSTED_APP_IMAGE=%s\n' "$(image_for APP "$incoming")"
        printf 'HOSTED_CONTROL_IMAGE=%s\n' "$(image_for CONTROL "$incoming")"
        printf 'HOSTED_POSTGRES_IMAGE=%s\n' "$(image_for POSTGRES config/compose.env)"
      } > "$release_pins"
      incoming=$release_pins
    fi
    verify_images "$incoming"
    # This operation never changes the PostgreSQL engine image or reinitializes
    # its volume. Engine upgrades require a separate reviewed procedure.
    test "$(image_for POSTGRES "$incoming")" = "$(image_for POSTGRES config/compose.env)"
    active_app=$(running_state app)
    active_worker=$(running_state worker)
    before=
    recovery() {
      local exit_code=$?
      trap - EXIT HUP INT TERM
      if [[ -n $release_pins ]]; then rm -f -- "$release_pins" || true; fi
      if [[ -z $before ]]; then
        echo 'Upgrade interrupted before image replacement. Resuming previously running services.' >&2
        resume_before_image_change || echo 'Service recovery needs operator attention.' >&2
        exit "$exit_code"
      fi
      stop_business || true
      local unchanged=yes
      config_hashes > "$before/config.after" || unchanged=no
      cmp -s "$before/config.before" "$before/config.after" || unchanged=no
      tool ledger > "$before/migrations.after" || unchanged=no
      cmp -s "$before/migrations.before" "$before/migrations.after" || unchanged=no
      control_tool schema > "$before/control-schema.after" || unchanged=no
      cmp -s "$before/control-schema.before" "$before/control-schema.after" || unchanged=no
      if test "$unchanged" = yes; then
        if install_pins "$before/compose.env" && remove_stopped_business && control_tool check && compose up -d --no-deps --wait control && start_selected "$active_app" "$active_worker"; then
          echo 'Failed deployment restored prior images and only previously active services.' >&2
        else stop_business || true; echo 'Recovery health failed; business remains stopped.' >&2; fi
      else echo 'Schema/configuration changed or could not be verified; business remains stopped, no database rollback performed.' >&2; fi
      printf 'Recovery backup: %s\n' "$before" >&2
      exit "$exit_code"
    }
    trap recovery EXIT
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM
    stop_business
    backup_all
    before="$ROOT/backups/$BACKUP_ID"
    if test "$incoming" != "$ROOT/config/compose.env"; then install_pins "$incoming"; fi
    control_tool check
    if test "$command" = rollback; then tool check exact; else tool check; fi
    # App/worker are stopped before replacing the shared network namespace.
    remove_stopped_business
    compose up -d --no-deps --wait control
    tool check-control
    if test "$command" != rollback; then tool migrate "$BACKUP_ID"; fi
    tool check exact
    config_hashes > "$before/config.after"
    cmp -s "$before/config.before" "$before/config.after"
    start_selected yes yes
    config_hashes > "$before/config.after"
    cmp -s "$before/config.before" "$before/config.after"
    if [[ -n $release_pins ]]; then rm -f -- "$release_pins" || true; fi
    trap - EXIT HUP INT TERM
    echo 'Hosted application and worker passed health/version checks.'
    ;;
  *) echo 'Unknown hosted operation.' >&2; exit 1 ;;
esac
