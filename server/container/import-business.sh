#!/bin/bash
set -Eeuo pipefail
umask 077
ROOT=/www/aborder-hosted
PROJECT=aborder-hosted
IMPORT_DIR="$ROOT/backups/initial-import"
DUMP="$IMPORT_DIR/database.dump"
if [[ $# != 2 || $1 != --run || ! $2 =~ ^[a-f0-9]{64}$ ]]; then
  printf '%s\n' 'Usage: bash import-business.sh --run EXPECTED_DUMP_SHA256' \
    'Reads only /www/aborder-hosted/backups/initial-import/database.dump; target must be empty.' >&2
  exit 1
fi
test "$(id -u)" = 0
test "$(readlink -f "$ROOT")" = "$ROOT"
test "$(stat -c '%u:%a' "$ROOT")" = 0:700
test "$(readlink -f "$IMPORT_DIR")" = "$IMPORT_DIR"
test "$(stat -c '%u:%a' "$IMPORT_DIR")" = 0:700
private_file() { test ! -L "$1" && test -f "$1" && test "$(stat -c '%u:%a' "$1")" = 0:600; }
private_file "$DUMP"
for file in application.env database.env control.env compose.env; do private_file "$ROOT/config/$file"; done
exec 9>"$ROOT/.operation.lock"
flock -n 9 || { echo 'Another hosted operation is active; nothing imported.' >&2; exit 1; }
test "$(sha256sum "$DUMP" | cut -d ' ' -f 1)" = "$2" || { echo 'Source dump checksum mismatch; nothing imported.' >&2; exit 1; }
cd -- "$ROOT"
compose() { docker compose --project-directory "$ROOT" --env-file "$ROOT/config/compose.env" -p "$PROJECT" -f "$ROOT/compose.yml" "$@"; }
docker compose version >/dev/null
# Validate ownership before inspecting or invoking any existing project service.
project_containers=$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")
while IFS= read -r container; do
  test -z "$container" && continue
  test "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$container")" = "$ROOT"
done <<< "$project_containers"
for service in app worker; do
  service_containers=$(compose ps -a -q "$service")
  while IFS= read -r container; do
    test -z "$container" && continue
    test "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$container")" = "$PROJECT"
    test "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$container")" = "$service"
    status=$(docker inspect --format '{{.State.Status}}' "$container")
    [[ $status = exited || $status = created ]] || { echo 'Application/worker is not stopped; nothing imported.' >&2; exit 1; }
  done <<< "$service_containers"
done
for service in database control; do
  container=$(compose ps -q "$service")
  test -n "$container"
  test "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$container")" = "$PROJECT"
  test "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$container")" = "$service"
  test "$(docker inspect --format '{{.State.Running}}' "$container")" = true
  test "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container")" = healthy
done
compose run --rm --no-deps -T --entrypoint node tooling --input-type=module - "$2" <<'NODE'
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
process.umask(0o077);
const file = '/backups/initial-import/database.dump';
const log = '/backups/initial-import/import-business-private.log';
let pgpass;
try {
  const expected = process.argv[2];
  if (!/^[a-f0-9]{64}$/.test(expected || '')) throw new Error('Invalid expected source checksum.');
  const sum = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) sum.update(chunk);
  if (sum.digest('hex') !== expected) throw new Error('Source changed or checksum mismatch.');
  let url;
  try { url = new URL(process.env.DATABASE_URL); } catch { throw new Error('Invalid private database configuration.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== 'database' || (url.port && url.port !== '5432')
    || url.pathname !== '/aborder' || decodeURIComponent(url.username) !== 'aborder'
    || (url.searchParams.has('schema') && url.searchParams.get('schema') !== 'public')) {
    throw new Error('Unexpected initial import target.');
  }
  pgpass = '/tmp/initial-import-pgpass-' + randomBytes(12).toString('hex');
  const escape = value => String(value).replace(/\\/g, '\\\\').replace(/:/g, '\\:');
  fs.writeFileSync(pgpass, ['database', '5432', 'aborder', 'aborder', decodeURIComponent(url.password)]
    .map(escape).join(':') + '\n', { mode: 0o600, flag: 'wx' });
  // Only application credentials are passed to libpq. POSTGRES_PASSWORD from
  // the tooling environment never substitutes the application identity.
  const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', PGHOST: 'database', PGPORT: '5432', PGDATABASE: 'aborder',
    PGUSER: 'aborder', PGPASSFILE: pgpass, PGCONNECT_TIMEOUT: '10' };
  const bin = '/usr/lib/postgresql/16/bin/';
  const sql = query => execFileSync(bin + 'psql', ['-X', '-q', '-A', '-t', '--no-password', '-v', 'ON_ERROR_STOP=1'],
    { env, input: query, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  if (sql('SELECT current_user') !== 'aborder'
    || sql('SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()') !== 'aborder'
    || sql('SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication FROM pg_roles WHERE rolname=current_user') !== 'f') {
    throw new Error('Application role/database ownership is not the dedicated unprivileged identity.');
  }
  const count = sql("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','S','f')");
  if (count !== '0') throw new Error('Target has user relations; refusing to import over existing data.');
  execFileSync(bin + 'pg_restore', ['--list', file], { env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16777216 });
  execFileSync(bin + 'pg_restore', ['--no-password', '--exit-on-error', '--single-transaction', '--no-owner', '--no-acl',
    '--dbname', 'aborder', file], { env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16777216 });
  const wrongOwner = sql("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f') AND pg_get_userbyid(c.relowner)<>current_user");
  if (wrongOwner !== '0') throw new Error('Restored relation ownership check failed.');
  console.log('Initial business restore committed atomically; application ownership verified.');
} catch (error) {
  try {
    const fd = fs.openSync(log, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
    fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, new Date().toISOString() + '\n' + String(error.stderr || error.message) + '\n');
    fs.closeSync(fd);
  } catch { /* Do not expose private restore details if the private log fails. */ }
  console.error('Initial business import failed; inspect the private import log. App/worker were not started.');
  process.exitCode = 1;
} finally {
  if (pgpass) { try { fs.unlinkSync(pgpass); } catch { /* Temporary container is removed. */ } }
}
NODE
# This is read-only migration compatibility checking, not migrate deploy.
# On incompatibility, imported data remains for review and both services stay off.
if ! compose run --rm --no-deps -T tooling check; then
  printf '%s\n' 'Restored database requires migration/release review; app/worker remain stopped.' >&2
  printf '%s\n' 'Post-import migration compatibility check failed.' >> "$IMPORT_DIR/import-business-private.log"
  chmod 600 "$IMPORT_DIR/import-business-private.log"
  exit 1
fi
printf '%s\n' 'Initial business data and migration compatibility verified. No application or worker was started.'
