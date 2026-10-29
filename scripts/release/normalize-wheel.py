"""Normalize wheel ZIP metadata without recompressing or changing payload bytes."""

import argparse
import datetime
import io
import os
import stat
import struct
import tempfile
import zipfile
from pathlib import Path


def _inspect(data: bytes) -> tuple[list[zipfile.ZipInfo], int]:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        names: set[str] = set()
        records = 0
        for entry in entries:
            name = entry.filename
            if (
                not name
                or entry.orig_filename != name
                or name.startswith("/")
                or "\\" in name
                or ":" in name
                or any(
                    ord(character) < 32 or ord(character) == 127 for character in name
                )
                or any(part in ("", ".", "..") for part in name.split("/"))
                or name in names
                or entry.is_dir()
                or entry.external_attr & 0x10
                or stat.S_IFMT(entry.external_attr >> 16) not in (0, stat.S_IFREG)
                or entry.flag_bits & 1
            ):
                raise ValueError(f"Unsafe or duplicate wheel entry: {name!r}")
            names.add(name)
            records += name.endswith(".dist-info/RECORD")
            # Decompress and verify CRC before trusting any entry or modifying the wheel.
            with archive.open(entry) as stream:
                while stream.read(1024 * 1024):
                    pass
        if (
            not entries
            or records != 1
            or min(entry.header_offset for entry in entries) != 0
        ):
            raise ValueError("Expected an ordinary wheel with exactly one RECORD")
        return entries, archive.start_dir


def normalize_wheel(path: Path, source_date_epoch: int) -> None:
    """Atomically normalize ordinary ZIP entries; preserve compressed bytes and RECORD."""
    if path.suffix != ".whl" or not path.is_file() or path.is_symlink():
        raise ValueError("Expected a regular .whl file")
    timestamp = datetime.datetime.fromtimestamp(
        source_date_epoch, datetime.timezone.utc
    )
    if not 1980 <= timestamp.year <= 2107:
        raise ValueError(
            "SOURCE_DATE_EPOCH must fit the ZIP timestamp range (1980–2107)"
        )
    dos_time = timestamp.hour << 11 | timestamp.minute << 5 | timestamp.second // 2
    dos_date = (timestamp.year - 1980) << 9 | timestamp.month << 5 | timestamp.day
    original = path.read_bytes()
    entries, central_offset = _inspect(original)
    normalized = bytearray(original)
    for entry in entries:
        local = entry.header_offset
        if original[local : local + 4] != b"PK\x03\x04":
            raise ValueError("Invalid local ZIP header")
        struct.pack_into("<HH", normalized, local + 10, dos_time, dos_date)
        if original[central_offset : central_offset + 4] != b"PK\x01\x02":
            raise ValueError("Invalid central ZIP header")
        name_size, extra_size, comment_size = struct.unpack_from(
            "<HHH", original, central_offset + 28
        )
        # The high byte of 'version made by' is the host system; retain its ZIP version.
        normalized[central_offset + 5] = 3
        struct.pack_into("<HH", normalized, central_offset + 12, dos_time, dos_date)
        struct.pack_into(
            "<I", normalized, central_offset + 38, (stat.S_IFREG | 0o644) << 16
        )
        central_offset += 46 + name_size + extra_size + comment_size
    # ZIP64 and unexpected directory trailers need an explicit implementation, not guesses.
    if original[central_offset : central_offset + 4] != b"PK\x05\x06":
        raise ValueError("Unsupported or malformed ZIP directory trailer")
    after, _ = _inspect(normalized)
    for entry in after:
        if (
            entry.create_system != 3
            or entry.external_attr != (stat.S_IFREG | 0o644) << 16
        ):
            raise ValueError("Wheel metadata normalization failed")
    temporary: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            prefix=f".{path.name}.", suffix=".tmp", dir=path.parent, delete=False
        ) as stream:
            temporary = stream.name
            stream.write(normalized)
            stream.flush()
            os.fsync(stream.fileno())
            os.fchmod(stream.fileno(), 0o644)
        if path.read_bytes() != original:
            raise ValueError("Wheel changed during normalization")
        os.replace(temporary, path)
        temporary = None
    finally:
        if temporary is not None:
            os.unlink(temporary)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wheel", type=Path)
    args = parser.parse_args()
    try:
        source_date_epoch = int(os.environ["SOURCE_DATE_EPOCH"])
        normalize_wheel(args.wheel, source_date_epoch)
    except (KeyError, ValueError, OverflowError, OSError, zipfile.BadZipFile) as error:
        parser.exit(1, f"Wheel normalization failed: {error}\n")


if __name__ == "__main__":
    main()
