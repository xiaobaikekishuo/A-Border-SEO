#!/usr/bin/env sh
set -eu

image="$1"
version="$2"
postgres_image="${ABORDER_SMOKE_POSTGRES_IMAGE:-postgres:16-alpine}"
encryption_source="${ABORDER_SMOKE_ENCRYPTION_FILE:-source/lib/encryption.ts}"
backup="$(mktemp)"
id="aborder-ci-${backup##*.}"
network="$id"
database="$id-db"
app="$id-app"
worker="$id-worker"
db="postgresql://aborder:ci-only@$database:5432/aborder"
first_desktop_migration=20261112000000_desktop_oauth

cleanup() {
  status=$?
  if [[ "$status" -ne 0 ]]; then
    for container in "$database" "$app" "$worker"; do
      docker logs "$container" 2>/dev/null || true
    done
  fi
  docker rm -fv "$worker" "$app" "$database" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -f "$backup"
}
trap cleanup EXIT
docker network create "$network" >/dev/null
docker run -d --name "$database" --network "$network" \
  -e POSTGRES_USER=aborder -e POSTGRES_PASSWORD=ci-only -e POSTGRES_DB=aborder \
  "$postgres_image" >/dev/null

ready() {
  for attempt in $(seq 1 60); do
    if "$@"; then return 0; fi
    sleep 2
  done
  return 1
}
pg_ready() { docker exec "$database" pg_isready -U aborder -d aborder >/dev/null 2>&1; }
psql() { docker exec -i "$database" psql -X -v ON_ERROR_STOP=1 -U aborder "$@"; }

credential() {
  docker run --rm -i -e NEXTAUTH_SECRET=ci-only "$image" sh -ec '
    cat > /tmp/encryption.mts
    node --input-type=module -e "$1" "$2" "$3"
  ' credential '
    import { encrypt, decrypt } from "file:///tmp/encryption.mts";
    const [action, value] = process.argv.slice(1);
    process.stdout.write(action === "encrypt" ? encrypt(value) : decrypt(value));
  ' "$1" "$2" < "$encryption_source"
}

ready pg_ready
# Recreate the schema immediately before the first desktop migration.
docker run --rm -i --network "$network" -e DATABASE_URL="$db" "$image" sh -ec '
  baseline="$(mktemp -d)"
  node - "$baseline" "$1"
  node node_modules/prisma/build/index.js migrate deploy --schema "$baseline/schema.prisma"
' baseline "$first_desktop_migration" <<'NODE'
const fs = require("node:fs");
const [destination, boundary] = process.argv.slice(2);
const migrations = "prisma/migrations";
fs.accessSync(migrations + "/" + boundary);
fs.copyFileSync("prisma/schema.prisma", destination + "/schema.prisma");
fs.mkdirSync(destination + "/migrations");
for (const entry of fs.readdirSync(migrations, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name < boundary) {
    fs.cpSync(migrations + "/" + entry.name, destination + "/migrations/" + entry.name, { recursive: true });
  }
}
NODE

test_key=aborder-ci-credential-only
encrypted="$(credential encrypt "$test_key")"
psql -d aborder -v "credential=$encrypted" <<'SQL'
INSERT INTO "User" (id, email, "googleTokens", "updatedAt")
VALUES ('ci-user', 'migration@example.test', '{"migrationMarker":"v1.1.2"}', now());
INSERT INTO "Site" (id, "userId", domain, "updatedAt")
VALUES ('ci-site', 'ci-user', 'migration.example.test', now());
INSERT INTO "SavedKeyword" (id, "siteId", query)
VALUES ('ci-keyword', 'ci-site', 'migration check');
INSERT INTO "ApiKey" (id, "userId", provider, "encryptedPassword", "updatedAt")
VALUES ('ci-key', 'ci-user', 'bing', :'credential', now());
SQL
docker exec "$database" pg_dump -U aborder -Fc -d aborder > "$backup"
docker exec "$database" createdb -U aborder aborder_restore
docker exec -i "$database" pg_restore --exit-on-error -U aborder -d aborder_restore < "$backup"

docker run --rm --network "$network" -e DATABASE_URL="$db" "$image" \
  node node_modules/prisma/build/index.js migrate deploy
test "$(psql -d aborder -tAc "SELECT to_regclass('\"DesktopOAuthAttempt\"') IS NOT NULL" </dev/null)" = t
for test_db in aborder aborder_restore; do
  preserved="$(psql -d "$test_db" -tAc \
    "SELECT u.\"googleTokens\" ->> 'migrationMarker' FROM \"User\" u
     JOIN \"Site\" s ON s.\"userId\" = u.id
     JOIN \"SavedKeyword\" k ON k.\"siteId\" = s.id WHERE k.id = 'ci-keyword'" </dev/null)"
  test "$preserved" = v1.1.2
  ciphertext="$(psql -d "$test_db" -tAc "SELECT \"encryptedPassword\" FROM \"ApiKey\" WHERE id = 'ci-key'" </dev/null)"
  test "$(credential decrypt "$ciphertext")" = "$test_key"
done

docker run -d --name "$app" --network "$network" -p 127.0.0.1::3000 \
  -e DATABASE_URL="$db" -e NEXTAUTH_SECRET=ci-only -e NEXTAUTH_URL=http://localhost:3000 \
  -e ABORDER_DESKTOP_MODE=1 -e WORKER_MODE=off \
  -e ABORDER_DESKTOP_MAINTENANCE_FILE=/tmp/aborder-smoke-maintenance \
  -e LOCAL_CONTENT_WORKER_TOKEN=ci-worker-only-01234567890123456789 \
  "$image" >/dev/null
healthy() {
  docker exec "$app" node -e '
    fetch("http://127.0.0.1:3000/api/health").then(async response => {
      const health = await response.json();
      if (!response.ok || health.status !== "ok" || health.version !== process.argv[1] || health.desktopMode !== true) {
        process.exitCode = 1;
      }
    }).catch(() => { process.exitCode = 1; });
  ' "$version"
}
ready healthy
test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$image")" = "$version"
docker exec "$app" touch /tmp/aborder-smoke-maintenance
healthy
docker exec -i "$app" node - <<'NODE'
const assert = require("node:assert/strict");
async function test() {
  const origin = "http://127.0.0.1:3000";
  const blocked = await fetch(origin + "/api/desktop/oauth", { method: "POST" });
  assert.equal(blocked.status, 503);
  const bridge = await fetch(origin + "/api/local-content-worker", {
    method: "POST",
    headers: {
      authorization: "Bearer " + process.env.LOCAL_CONTENT_WORKER_TOKEN,
      "content-type": "application/json",
    },
    body: JSON.stringify({ action: "heartbeat", workerId: "ci-host-worker" }),
  });
  assert.equal(bridge.status, 200);
  assert.equal((await bridge.json()).ok, true);
}
test().catch(error => { console.error(error); process.exitCode = 1; });
NODE
docker exec "$app" rm /tmp/aborder-smoke-maintenance

docker run -d --name "$worker" --network "$network" \
  -e DATABASE_URL="$db" -e NEXTAUTH_SECRET=ci-only -e WORKER_MODE=worker -e SCHEDULER_ENABLED=false \
  "$image" node worker.cjs >/dev/null
worker_rows() {
  docker exec "$database" psql -U aborder -d aborder -tAc \
    "SELECT count(*) FROM \"WorkerHeartbeat\" WHERE mode = 'worker'"
}
worker_registered() { [[ "$(worker_rows)" = "1" ]]; }
ready worker_registered
docker stop -t 30 "$worker" >/dev/null
test "$(docker inspect -f '{{.State.ExitCode}}' "$worker")" = "0"
test "$(worker_rows)" = "0"
printf 'Boot, migrations, app and worker verified for %s.\n' "$image"
