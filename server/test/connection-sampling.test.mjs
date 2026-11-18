import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("connection samples observe active and idle transactions and exclude the sampler on PostgreSQL 16", () => {
  const sampler = fileURLToPath(new URL("../container/sample-connections.sh", import.meta.url)).replaceAll("\\", "/");
  const output = execFileSync("docker", ["--context", "desktop-linux", "run", "--rm", "--network", "none", "--read-only",
    "--user", "postgres", "--tmpfs", "/tmp:rw,nosuid,nodev,size=80m,mode=1777",
    "--mount", `type=bind,src=${sampler},dst=/fixture/sample.sh,readonly`, "--entrypoint", "bash", "postgres:16-alpine", "-ec", `
      initdb -D /tmp/data --locale=C --auth-local=trust --auth-host=reject >/dev/null
      pg_ctl -D /tmp/data -l /tmp/postgres.log -o "-k /tmp -c listen_addresses='' -c max_connections=10" -w start >/dev/null
      export PGHOST=/tmp
      docker() {
        [[ "$1 $2" = "compose --project-directory" ]] || return 2
        while [[ $# -gt 0 && $1 != exec ]]; do shift; done
        [[ "$1 $2 $3 $4" = "exec -T database psql" ]] || return 2
        shift 3
        "$@"
      }
      export -f docker
      bash /fixture/sample.sh 1 1
      psql -Xqc 'SELECT pg_sleep(30)' >/dev/null 2>&1 &
      { echo 'BEGIN; SELECT 1;'; sleep 30; } | psql -Xq >/dev/null 2>&1 &
      for attempt in {1..30}; do
        [[ $(psql -XAtqc "SELECT count(*) FROM pg_stat_activity WHERE state='idle in transaction'") = 1 ]] && break
        sleep 0.1
      done
      bash /fixture/sample.sh 2 1
      pg_ctl -D /tmp/data -m fast -w stop >/dev/null
    `], { encoding: "utf8", windowsHide: true, timeout: 60000 });
  assert.match(output, /samples=1 peak_clients=0 min_ordinary_headroom=7/);
  assert.match(output, /T\S+Z 2 1 1 7 5/);
  assert.match(output, /samples=2 peak_clients=2 min_ordinary_headroom=5/);
});
