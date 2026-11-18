#!/bin/sh
set -eu
umask 077
backup_root=/var/backups/aborder-control
install -d -m 700 "$backup_root"
exec 9>/run/lock/aborder-control-backup.lock
flock -n 9
stamp=$(date -u +%Y%m%dT%H%M%SZ)
destination="$backup_root/$stamp"
mkdir -m 700 "$destination"
ABORDER_CONTROL_DB=/var/lib/aborder-control/control.sqlite \
  /usr/bin/node /opt/aborder-control/current/control-plane/cli.mjs backup "$destination/control.sqlite"
cp /etc/aborder-control/signing.pem "$destination/signing.pem"
cp /etc/aborder-control/control.env "$destination/control.env"
readlink -f /opt/aborder-control/current > "$destination/release.txt"
chmod 600 "$destination"/*
printf 'Management backup created: %s\n' "$destination"
