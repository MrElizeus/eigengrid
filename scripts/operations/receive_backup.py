#!/usr/bin/env python3
"""Receive a bounded encrypted backup without consuming the disk reserve.

The sender must decrypt and verify the stored bytes afterwards. This receiver
does not attest database or artifact integrity, and never removes old backups.
"""

import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import sys
import uuid


def check_capacity(directory_fd, incoming_bytes, reserve_bytes, reserve_percent):
    usage = os.fstatvfs(directory_fd)
    free = usage.f_bavail * usage.f_frsize
    total = usage.f_blocks * usage.f_frsize
    remaining = free - incoming_bytes
    if remaining < reserve_bytes or remaining * 100 < total * reserve_percent:
        raise RuntimeError("incoming backup would consume the storage reserve")


def receive(directory, name, source, *, max_bytes, reserve_bytes, reserve_percent):
    if not re.fullmatch(r"[0-9]{8}T[0-9]{6}Z\.tar\.gpg", name):
        raise ValueError("invalid snapshot name")
    if max_bytes <= 0 or reserve_bytes <= 0 or not 0 < reserve_percent < 100:
        raise ValueError("positive size bound and storage reserve required")
    path = Path(directory)
    if not path.is_absolute() or path.resolve(strict=True) != path:
        raise ValueError("a canonical existing private directory is required")
    directory_fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    temporary = f".{name}.{uuid.uuid4().hex}.part"
    created = False
    try:
        metadata = os.fstat(directory_fd)
        if metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) != 0o700:
            raise ValueError("backup directory must be owned by the receiver with mode 0700")
        fcntl.flock(directory_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise FileExistsError("snapshot already exists")
        check_capacity(directory_fd, max_bytes, reserve_bytes, reserve_percent)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW |
                     os.O_CLOEXEC, 0o600, dir_fd=directory_fd)
        created = True
        count = 0
        with os.fdopen(fd, "wb", buffering=0) as output:
            while True:
                chunk = source.read(min(1024 * 1024, max_bytes - count + 1))
                if not chunk:
                    break
                if count + len(chunk) > max_bytes:
                    raise RuntimeError("encrypted stream exceeds its declared size bound")
                check_capacity(directory_fd, len(chunk), reserve_bytes, reserve_percent)
                pending = memoryview(chunk)
                while pending:
                    written = output.write(pending)
                    if written is None or written <= 0:
                        raise OSError("short backup write")
                    pending = pending[written:]
                count += len(chunk)
            if count == 0:
                raise RuntimeError("empty backup stream")
            output.flush()
            os.fsync(output.fileno())
        # link is atomic and refuses to replace a file from a concurrent receiver.
        os.link(temporary, name, src_dir_fd=directory_fd, dst_dir_fd=directory_fd,
                follow_symlinks=False)
        os.unlink(temporary, dir_fd=directory_fd)
        created = False
        os.fsync(directory_fd)
        return {"stored": True, "snapshot": name, "bytes": count, "integrityVerified": False}
    finally:
        if created:
            os.unlink(temporary, dir_fd=directory_fd)
        os.close(directory_fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--max-bytes", required=True, type=int)
    parser.add_argument("--reserve-bytes", type=int, default=100 * 1024**3)
    parser.add_argument("--reserve-percent", type=int, default=20)
    args = parser.parse_args()
    print(json.dumps(receive(args.directory, args.name, sys.stdin.buffer,
                            max_bytes=args.max_bytes, reserve_bytes=args.reserve_bytes,
                            reserve_percent=args.reserve_percent)))


if __name__ == "__main__":
    main()
