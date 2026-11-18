#!/bin/bash
set -Eeuo pipefail
export PATH="/tmp:$PATH"
ROOT=/www/aborder-hosted
mkdir -p "$ROOT/config"
cd "$ROOT"
umask 077
for file in application.env database.env control.env signing.pem; do echo fixture > "config/$file"; done
chown 0:10001 config/signing.pem
chmod 440 config/signing.pem
make_pins() {
  printf 'HOSTED_APP_IMAGE=sha256:%064d\nHOSTED_CONTROL_IMAGE=sha256:%064d\nHOSTED_POSTGRES_IMAGE=sha256:%064d\n' "$1" "$2" 3
}
make_pins 1 2 > original.env
make_pins 4 5 > incoming.env
cp original.env config/compose.env
echo 'exit 0' > smoke-host.sh
cat > /tmp/docker <<'MOCK'
#!/bin/bash
set -eu
case "$1" in
  ps) exit 0 ;;
  volume|network) exit 1 ;;
  image)
    case "$4" in
      *role*) case "${!#}" in *1|*4) echo hosted-app ;; *2|*5) echo control-plane ;; *) exit 99 ;; esac ;;
      *version*) echo 1.5.4 ;;
      *) echo linux/amd64 ;;
    esac ;;
  run) echo 'postgres (PostgreSQL) 16.1' ;;
  inspect)
    case "$3" in
      *project*) echo aborder-hosted ;;
      *service*) echo "$4" ;;
      *Status*) echo exited ;;
      *) test "$3" = '{{.State.Running}}'; echo true ;;
    esac ;;
  rm) rm "$2.stopped" ;;
  exec) test -e "$2.running"; echo "healthy $2" >> calls ;;
  compose)
    shift
    [[ $1 != version ]] || exit 0
    while [[ $# -gt 0 && $1 != -f ]]; do shift; done
    shift 2
    case "$1" in
      ps) service=${!#}; if [[ -e $service.running || $2 = -a && -e $service.stopped ]]; then echo "$service"; fi ;;
      stop)
        if [[ -f worker.running ]]; then touch worker.stopped; fi
        rm -f worker.running
        [[ $(cat scenario) != partial-stop ]] || exit 9
        if [[ -f app.running ]]; then touch app.stopped; fi
        rm -f app.running ;;
      start)
        echo "start $2" >> calls
        [[ $(cat scenario) != failed-start || $2 != app ]] || exit 8
        touch "$2.running" ;;
      up)
        service=${!#}
        echo "up $service" >> calls
        if [[ $service != control ]]; then touch "$service.running"; fi ;;
      run)
        shift 4
        case "$1 $2" in
          'tooling backup')
            case "$(cat scenario)" in
              disk|failed-start) exit 9 ;;
              dump) echo partial > "backups/$3/database.dump"; exit 9 ;;
            esac ;;
          'control-tools backup') [[ $(cat scenario) != control ]] || exit 9 ;;
          'tooling ledger') [[ $(cat scenario) != ledger ]] || exit 9; if [[ -e migrated ]]; then echo '[1]'; else echo '[]'; fi ;;
          'control-tools schema') [[ $(cat scenario) != schema ]] || exit 9; echo fixture ;;
          'tooling check')
            [[ $(cat scenario) != incompatible ]] || exit 7
            [[ $(cat scenario) != bad-migration || ! -e migrated ]] || exit 7 ;;
          'tooling migrate') touch migrated ;;
          'control-tools check'|'tooling check-control') ;;
          *) echo "unexpected tool $1 $2" >&2; exit 99 ;;
        esac ;;
      *) echo "unexpected compose action $1" >&2; exit 99 ;;
    esac ;;
  *) echo "unexpected docker action $1" >&2; exit 99 ;;
esac
MOCK
chmod 700 /tmp/docker
check() {
  local scenario=$1 app=$2 worker=$3 operation=$4 status
  echo "$scenario" > scenario
  : > calls
  rm -f app.running worker.running app.stopped worker.stopped
  if [[ $app = on ]]; then touch app.running; fi
  if [[ $worker = on ]]; then touch worker.running; fi
  status=0
  bash /fixture/container/manage-host.sh "$operation" "$ROOT/incoming.env" --run > log 2>&1 || status=$?
  if [[ $status != 9 ]]; then cat log >&2; echo "unexpected result for $scenario: $status" >&2; return 1; fi
  cmp original.env config/compose.env
  test -z "$(find backups -name COMPLETE -print -quit)"
  for service in app worker; do
    if [[ ${!service} = on ]]; then
      grep -qx "start $service" calls
      if [[ $scenario = failed-start && $service = app ]]; then
        grep -q 'needs operator attention' log
        continue
      fi
      grep -qx "healthy $service" calls
      test -e "$service.running"
    else
      if grep -q "$service" calls || [[ -e $service.running ]]; then return 1; fi
    fi
  done
}
check disk on on deploy
check dump on off rollback
check control off on deploy
check ledger off off deploy
check schema on on rollback
check partial-stop on on deploy
check failed-start on on deploy
for scenario in incompatible success bad-migration; do
  echo "$scenario" > scenario
  : > calls
  cp original.env config/compose.env
  rm -f migrated worker.running app.stopped worker.stopped
  touch app.running
  status=0
  bash /fixture/container/manage-host.sh deploy "$ROOT/incoming.env" --run > log 2>&1 || status=$?
  if [[ $scenario = success ]]; then
    test "$status" = 0
    cmp incoming.env config/compose.env
    test -e app.running
    test -e worker.running
  elif [[ $scenario = incompatible ]]; then
    test "$status" = 7
    cmp original.env config/compose.env
    test -e app.running
    test ! -e worker.running
    grep -q 'restored prior images' log
  else
    test "$status" = 7
    test ! -e app.running
    test ! -e worker.running
    grep -q 'Schema/configuration changed' log
  fi
  test "$(stat -c %a config/compose.env)" = 600
done
test "$(find backups -name COMPLETE | wc -l)" = 3
echo success > scenario
cp original.env config/compose.env
sed 's/^HOSTED_POSTGRES_IMAGE=.*/HOSTED_POSTGRES_IMAGE=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/' incoming.env > published.env
status=0
bash /fixture/container/manage-host.sh deploy "$ROOT/published.env" --run > log 2>&1 || status=$?
test "$status" != 0
cmp original.env config/compose.env
bash /fixture/container/manage-host.sh deploy-release "$ROOT/published.env" --run > log 2>&1
cmp incoming.env config/compose.env
test "$(find config -name '.release.*' | wc -l)" = 0
echo 'upgrade backup recovery scenarios passed'
