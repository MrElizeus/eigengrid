#!/bin/bash
# Monster Queen site adapter. No service stops, restored-session auto-start or pruning.
set -euo pipefail
umask 077
[[ $EUID == 0 ]]
exec 9>/run/eigengrid-qualification-backup.lock
flock -n 9
base=/home/cluster/backups/eigengrid-operational-snapshots
install -d -o root -g root -m 0700 "$base"
python3 /usr/local/lib/eigengrid-deploy/storage_health.py --data-mount /var/lib/eigengrid
stamp=$(date -u +%Y%m%dT%H%M%SZ)
snapshot="$base/$stamp"
export EIGENGRID_QUALIFICATION_BACKUP_DB='dbname=eigengrid_qualification user=postgres host=/var/run/postgresql'
python3 /usr/local/lib/eigengrid-deploy/operational-backup.py create \
  --database-env EIGENGRID_QUALIFICATION_BACKUP_DB --postgres-os-user postgres \
  --artifact-root /var/lib/eigengrid/head-qualification/artifacts \
  --artifact-root /var/lib/eigengrid/head/artifacts --output "$snapshot" \
  --journal-root production=/var/lib/eigengrid/head/agent-sessions \
  --journal-root legacy=/var/lib/eigengrid/agent-sessions \
  --journal-root qualification=/var/lib/eigengrid/head-qualification/agent-sessions
export RESTIC_REPOSITORY=/home/cluster/backups/restic
export RESTIC_PASSWORD_FILE=/root/cluster-backup/restic-password
export RESTIC_CACHE_DIR=/var/cache/cluster-backup/restic
restic backup --one-file-system --tag eigengrid-operational --host monsterqueen "$snapshot"
# A distinct remote directory preserves the unchanged strict database-backup namespace.
remote=/var/backups/eigengrid-operational-secondary
srun -w worker-01 -p chem -n1 -c1 --mem=128M -t 00:03:00 --chdir=/tmp bash -c \
  'set -eu; case "$(stat -f -c %T /var/backups)" in nfs*) exit 1;; esac; install -d -o root -g root -m 0700 /var/backups/eigengrid-operational-secondary'
max_bytes=$(python3 - "$snapshot" <<'BOUND'
from pathlib import Path
import stat,sys
root=Path(sys.argv[1]); total=1024*1024
for p in root.rglob('*'):
    info=p.lstat()
    if stat.S_ISDIR(info.st_mode): total += 4096
    elif stat.S_ISREG(info.st_mode): total += ((info.st_size+511)//512)*512+4096
    else: raise SystemExit('Non-regular operational snapshot member')
print((total*11+9)//10)
BOUND
)
tar -C "$base" -cf - "$stamp" | \
  gpg --batch --yes --pinentry-mode loopback --passphrase-file /etc/eigengrid/offnode-backup.pass --symmetric --cipher-algo AES256 --compress-algo none | \
  srun -w worker-01 -p chem -n1 -c1 --mem=128M -t 00:10:00 --chdir=/tmp \
    python3 /usr/local/lib/eigengrid-deploy/receive_backup.py --directory "$remote" --name "$stamp.tar.gpg" --max-bytes "$max_bytes"
work=$(mktemp -d /home/cluster/backups/.operational-verify.XXXXXXXX)
trap 'rm -rf -- "$work"' EXIT
srun -w worker-01 -p chem -n1 -c1 --mem=128M -t 00:10:00 --chdir=/tmp cat "$remote/$stamp.tar.gpg" | \
  gpg --batch --pinentry-mode loopback --passphrase-file /etc/eigengrid/offnode-backup.pass --decrypt | \
  python3 -c 'import tarfile,sys; t=tarfile.open(fileobj=sys.stdin.buffer,mode="r|"); t.extractall(path=sys.argv[1],filter="data")' "$work"
python3 /usr/local/lib/eigengrid-deploy/operational-backup.py verify --backup "$work/$stamp"
printf '{"ok":true,"node":"worker-01","snapshot":"%s","scope":"qualification-pg-cas-and-agent-journals","crossComponentAtomic":false,"integrity":"decrypt-and-verify","restoreExecuted":false}\n' "$stamp"
