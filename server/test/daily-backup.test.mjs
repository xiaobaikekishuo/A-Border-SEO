import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("daily backup preserves existing backups, records private failures, and stops before backup on low storage", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aborder-daily-backup-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("aborder-daily-backup-"));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  fs.copyFileSync(fileURLToPath(new URL("../container/daily-backup.sh", import.meta.url)), path.join(directory, "daily-backup.sh"));
  fs.writeFileSync(path.join(directory, "docker"), `#!/bin/bash
set -eu
[[ $1 = volume && $2 = inspect && $5 = aborder-hosted_database-data ]]
case "$*" in *Mountpoint*) echo /www/aborder-hosted/database-fixture ;; *) echo aborder-hosted ;; esac
`);
  fs.writeFileSync(path.join(directory, "df"), `#!/bin/bash
case "$(cat /www/aborder-hosted/scenario)" in low*) blocks=500000 ;; warning) blocks=3000000 ;; *) blocks=9000000 ;; esac
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\nfixture 10000000 1 %s 1%% /www\n' "$blocks"
`);
  fs.writeFileSync(path.join(directory, "logger"), "#!/bin/bash\nprintf '%s\\n' \"$*\" >> /www/aborder-hosted/syslog-fixture\n");
  fs.writeFileSync(path.join(directory, "manage-host.sh"), `#!/bin/bash
set -eu
[[ $1 = backup && $2 = --run && $# = 2 ]]
touch /www/aborder-hosted/backup-called
if [[ $(cat /www/aborder-hosted/scenario) = failure ]]; then echo 'PRIVATE_FIXTURE_DETAIL'; exit 9; fi
mkdir -m 700 /www/aborder-hosted/backups/new-fixture
touch /www/aborder-hosted/backups/new-fixture/COMPLETE
`);
  fs.writeFileSync(path.join(directory, "run.sh"), `#!/bin/bash
set -Eeuo pipefail
mkdir -p /www/aborder-hosted
chmod 700 /www/aborder-hosted
cp /fixture/manage-host.sh /www/aborder-hosted/manage-host.sh
chmod 600 /www/aborder-hosted/manage-host.sh
mkdir -m 700 /www/aborder-hosted/backups /www/aborder-hosted/database-fixture
mkdir -m 700 /www/aborder-hosted/backups/retained
printf 'do-not-delete' > /www/aborder-hosted/backups/retained/original
for binary in docker df logger; do cp "/fixture/$binary" "/usr/local/sbin/$binary"; chmod 755 "/usr/local/sbin/$binary"; done
for scenario in success warning low_space failure; do
  printf '%s' "$scenario" > /www/aborder-hosted/scenario
  rm -f /www/aborder-hosted/backup-called
  if test -d /www/aborder-hosted/backups/new-fixture; then rm /www/aborder-hosted/backups/new-fixture/COMPLETE; rmdir /www/aborder-hosted/backups/new-fixture; fi
  set +e
  bash /fixture/daily-backup.sh --run
  result=$?
  if test "$result" != 0; then cat /www/aborder-hosted/logs/* || true; fi
  set -e
  case "$scenario" in
    success) test "$result" = 0; grep -qx state=success /www/aborder-hosted/logs/backup.status ;;
    warning) test "$result" = 0; grep -qx state=success_low_space /www/aborder-hosted/logs/backup.status ;;
    low_space) test "$result" = 2; test ! -e /www/aborder-hosted/backup-called; grep -qx state=low_space /www/aborder-hosted/logs/backup.status ;;
    failure) test "$result" = 9; grep -qx state=failed /www/aborder-hosted/logs/backup.status; grep -ql PRIVATE_FIXTURE_DETAIL /www/aborder-hosted/logs/backup-*.log ;;
  esac
  test "$(cat /www/aborder-hosted/backups/retained/original)" = do-not-delete
  test "$(stat -c '%u:%a' /www/aborder-hosted/logs)" = 0:700
  for file in /www/aborder-hosted/logs/*; do test "$(stat -c '%u:%a' "$file")" = 0:600; done
done
! grep -q PRIVATE_FIXTURE_DETAIL /www/aborder-hosted/syslog-fixture
echo 'four daily backup scenarios passed'
`);
  const output = execFileSync("docker", ["--context", "desktop-linux", "run", "--rm", "--network", "none", "--read-only",
    "--tmpfs", "/www:rw,nosuid,nodev,size=32m", "--tmpfs", "/usr/local/sbin:rw,nosuid,nodev,exec,size=1m",
    "--mount", `type=bind,src=${directory.replaceAll("\\", "/")},dst=/fixture,readonly`,
    "--entrypoint", "bash", "node:24-bookworm-slim", "/fixture/run.sh"],
  { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  assert.match(output, /four daily backup scenarios passed/);
});
