"""Wheel contract fixtures contain payload/RECORD bytes, not executable scientific software."""

import importlib.util
import io
import stat
import struct
import tempfile
import unittest
import warnings
import zipfile
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[2] / "scripts/release/normalize-wheel.py"
SPEC = importlib.util.spec_from_file_location("normalize_wheel", SOURCE)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
EPOCH = 1792584000
PAYLOAD = {
    "example/__init__.py": b"contract fixture\n",
    "example-1.0.dist-info/RECORD": b"example/__init__.py,sha256=retained,17\n",
}


def wheel_bytes(mode: int, *, system: int = 3, names=None) -> bytes:
    stream = io.BytesIO()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name in PAYLOAD if names is None else names:
                entry = zipfile.ZipInfo(name, (2020, 1, 2, 3, 4, 6))
                entry.compress_type = zipfile.ZIP_DEFLATED
                entry.create_system = system
                entry.external_attr = mode << 16
                archive.writestr(entry, PAYLOAD.get(name, b"fixture"))
    return stream.getvalue()


def compressed_payloads(data: bytes):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        result = {}
        for entry in archive.infolist():
            name_size, extra_size = struct.unpack_from(
                "<HH", data, entry.header_offset + 26
            )
            start = entry.header_offset + 30 + name_size + extra_size
            result[entry.filename] = data[start : start + entry.compress_size]
        return result


class WheelNormalizationTests(unittest.TestCase):
    def test_equivalent_private_and_public_modes_produce_identical_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = [Path(directory) / "private.whl", Path(directory) / "public.whl"]
            paths[0].write_bytes(wheel_bytes(stat.S_IFREG | 0o600))
            paths[1].write_bytes(wheel_bytes(stat.S_IFREG | 0o644, system=0))
            originals = [path.read_bytes() for path in paths]
            self.assertNotEqual(*originals)
            for path in paths:
                MODULE.normalize_wheel(path, EPOCH)
            for path, original in zip(paths, originals):
                self.assertEqual(
                    compressed_payloads(path.read_bytes()),
                    compressed_payloads(original),
                )
            self.assertEqual(paths[0].read_bytes(), paths[1].read_bytes())
            with zipfile.ZipFile(paths[0]) as archive:
                self.assertEqual(
                    {
                        entry.filename: archive.read(entry)
                        for entry in archive.infolist()
                    },
                    PAYLOAD,
                )
                for entry in archive.infolist():
                    self.assertEqual(entry.create_system, 3)
                    self.assertEqual(entry.external_attr, (stat.S_IFREG | 0o644) << 16)
                    self.assertEqual(entry.date_time, (2026, 10, 21, 12, 0, 0))
            before = paths[0].read_bytes()
            MODULE.normalize_wheel(paths[0], EPOCH)
            self.assertEqual(paths[0].read_bytes(), before)

    def test_unsafe_duplicate_symlink_and_malformed_wheels_remain_unchanged(self):
        cases = [
            b"not a zip",
            wheel_bytes(stat.S_IFREG | 0o644)[:-10],
            wheel_bytes(
                stat.S_IFREG | 0o644,
                names=["../escape", "example-1.0.dist-info/RECORD"],
            ),
            wheel_bytes(
                stat.S_IFREG | 0o644,
                names=["/absolute", "example-1.0.dist-info/RECORD"],
            ),
            wheel_bytes(
                stat.S_IFREG | 0o644,
                names=[
                    "example/__init__.py",
                    "example/__init__.py",
                    "example-1.0.dist-info/RECORD",
                ],
            ),
            wheel_bytes(stat.S_IFLNK | 0o777),
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "unsafe.whl"
            for data in cases:
                with self.subTest(size=len(data)):
                    path.write_bytes(data)
                    with self.assertRaises((ValueError, zipfile.BadZipFile)):
                        MODULE.normalize_wheel(path, EPOCH)
                    self.assertEqual(path.read_bytes(), data)
            self.assertEqual(sorted(Path(directory).iterdir()), [path])

    def test_rejects_timestamp_outside_zip_range(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "timestamp.whl"
            data = wheel_bytes(stat.S_IFREG | 0o644)
            path.write_bytes(data)
            for epoch in (0, 10_000_000_000):
                with self.assertRaises(ValueError):
                    MODULE.normalize_wheel(path, epoch)
            self.assertEqual(path.read_bytes(), data)


if __name__ == "__main__":
    unittest.main()
