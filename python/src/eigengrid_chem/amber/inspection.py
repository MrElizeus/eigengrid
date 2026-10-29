"""Bounded, byte-derived AMBER artifact inspection.

This module deliberately supports the small, portable AMBER subset required by
the Production V1 pilot: formatted ``rst7`` files and classic NetCDF CDF-1/2
restart/trajectory files, plus formatted ``prmtop`` topology identity data.
It does not shell out to ``ncdump`` or rely on an undeclared Python package.

The result is an observation of the file descriptor's bytes.  Expected atom
counts, expected time cadence, artifact identity, and scientific criteria are
intentionally *not* inputs to this decoder; higher layers may compare their
predeclared contracts to this observation afterwards.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import stat
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Iterator, Literal

AMBER_BYTE_INSPECTION_SCHEMA_VERSION = "eigengrid.amber-byte-inspection/v1"
AMBER_MINIMIZATION_PARSE_SCHEMA_VERSION = "eigengrid.amber-minimization-parse/v1"
AMBER_BYTE_INSPECTOR_ID = "eigengrid_chem.amber.byte-inspector"
AMBER_BYTE_INSPECTOR_VERSION = "0.1.3"

_BLOCK_BYTES = 1024 * 1024
_MAX_TEXT_BYTES = 64 * 1024 * 1024
_MAX_HEADER_BYTES = 8 * 1024 * 1024
_MAX_HEADER_ITEMS = 4096
_MAX_NAME_BYTES = 1024
_MAX_ATTRIBUTE_BYTES = 1024 * 1024
_MAX_INSPECTABLE_BYTES = 1 << 40  # 1 TiB hard safety bound; decoding remains streaming.

_NETCDF_DIMENSION = 10
_NETCDF_VARIABLE = 11
_NETCDF_ATTRIBUTE = 12
_NC_BYTE = 1
_NC_CHAR = 2
_NC_SHORT = 3
_NC_INT = 4
_NC_FLOAT = 5
_NC_DOUBLE = 6
_NC_TYPE_SIZES = {
    _NC_BYTE: 1,
    _NC_CHAR: 1,
    _NC_SHORT: 2,
    _NC_INT: 4,
    _NC_FLOAT: 4,
    _NC_DOUBLE: 8,
}
_NC_NUMERIC_FORMATS = {
    _NC_BYTE: "b",
    _NC_SHORT: "h",
    _NC_INT: "i",
    _NC_FLOAT: "f",
    _NC_DOUBLE: "d",
}
_NUMERIC_TOKEN = re.compile(
    r"[-+]?(?:nan|inf(?:inity)?|(?:\d+(?:\.\d*)?|\.\d+)(?:[EeDd][-+]?\d+)?)",
    re.IGNORECASE,
)
_PRMTOP_FORMAT = re.compile(r"^%FORMAT\((\d+)([A-Za-z])(\d+)(?:\.\d+)?\)\s*$")
_MINIMIZATION_HEADER = re.compile(
    r"^\s*NSTEP\s+ENERGY\s+RMS\s+GMAX\s+NAME\s+NUMBER\s*$", re.IGNORECASE
)
_MINIMIZATION_ROW = re.compile(r"^\s*(\d+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+(\d+)\s*$")


class AmberInspectionError(Exception):
    """A decoder failure with a stable, non-scientific diagnostic code."""

    def __init__(self, code: str, message: str, read_status: str = "unreadable") -> None:
        super().__init__(message)
        self.code = code
        self.read_status = read_status


class _TruncatedArtifact(AmberInspectionError):
    def __init__(self, message: str) -> None:
        super().__init__("truncated_artifact", message, "truncated")


@dataclass(frozen=True)
class _Snapshot:
    digest: str
    size: int
    device: int
    inode: int
    mtime_ns: int
    ctime_ns: int


@dataclass(frozen=True)
class _Dimension:
    name: str
    size: int
    unlimited: bool


@dataclass(frozen=True)
class _Variable:
    name: str
    dimension_ids: tuple[int, ...]
    attributes: dict[str, str]
    nc_type: int
    vsize: int
    begin: int


class _HeaderReader:
    def __init__(self, stream: BinaryIO, size: int) -> None:
        self.stream = stream
        self.size = size
        self.offset = 0

    def read(self, count: int) -> bytes:
        if count < 0 or count > _MAX_HEADER_BYTES or self.offset + count > self.size:
            raise _TruncatedArtifact("NetCDF header extends beyond artifact bytes")
        value = self.stream.read(count)
        if len(value) != count:
            raise _TruncatedArtifact("NetCDF header ended before its declared length")
        self.offset += count
        if self.offset > _MAX_HEADER_BYTES:
            raise AmberInspectionError("netcdf_header_too_large", "NetCDF header exceeds bound")
        return value

    def u32(self) -> int:
        return struct.unpack(">I", self.read(4))[0]

    def u64(self) -> int:
        return struct.unpack(">Q", self.read(8))[0]

    def padded(self, count: int) -> bytes:
        value = self.read(count)
        padding = (-count) % 4
        if padding:
            self.read(padding)
        return value

    def name(self) -> str:
        length = self.u32()
        if length > _MAX_NAME_BYTES:
            raise AmberInspectionError("netcdf_name_too_large", "NetCDF name exceeds bound")
        try:
            return self.padded(length).decode("ascii")
        except UnicodeDecodeError as error:
            raise AmberInspectionError("invalid_netcdf_name", "NetCDF name is not ASCII") from error


def _diagnostic(code: str, severity: str, message: str) -> dict[str, str]:
    return {"code": code, "severity": severity, "message": message[:2048]}


def _empty_time(status: str = "not_applicable") -> dict[str, Any]:
    return {
        "status": status,
        "cadenceStatus": "not_applicable" if status == "not_applicable" else "missing",
        "count": 0,
        "firstPs": None,
        "lastPs": None,
        "minDeltaPs": None,
        "maxDeltaPs": None,
        "precisionPs": None,
    }


def _empty_cell(status: str = "not_applicable") -> dict[str, Any]:
    return {"status": status, "frameCount": None, "variableAcrossFrames": None}


def _base_result(
    *,
    artifact_kind: str,
    snapshot: _Snapshot,
    artifact_format: str,
    inspection_level: str,
    read_status: str,
    diagnostics: list[dict[str, str]],
) -> dict[str, Any]:
    return {
        "schemaVersion": AMBER_BYTE_INSPECTION_SCHEMA_VERSION,
        "decoder": {"id": AMBER_BYTE_INSPECTOR_ID, "version": AMBER_BYTE_INSPECTOR_VERSION},
        "artifactKind": artifact_kind,
        "observedContentDigest": snapshot.digest,
        "byteLength": snapshot.size,
        "format": artifact_format,
        "inspectionLevel": inspection_level,
        "readStatus": read_status,
        "convention": None,
        "atomCount": None,
        "frameCount": None,
        "hasPeriodicBox": None,
        "hasVelocities": None,
        "finiteValues": None,
        "dimensions": {},
        "time": _empty_time(),
        "cell": _empty_cell(),
        "atomIdentityDigest": None,
        "diagnostics": diagnostics,
    }


def _snapshot(stream: BinaryIO) -> _Snapshot:
    before = os.fstat(stream.fileno())
    if before.st_size < 0 or before.st_size > _MAX_INSPECTABLE_BYTES:
        raise AmberInspectionError(
            "artifact_too_large", "Artifact exceeds the inspection safety bound"
        )
    stream.seek(0)
    digest = hashlib.sha256()
    size = 0
    while True:
        chunk = stream.read(_BLOCK_BYTES)
        if not chunk:
            break
        size += len(chunk)
        digest.update(chunk)
    after = os.fstat(stream.fileno())
    if size != before.st_size or (
        after.st_dev,
        after.st_ino,
        after.st_size,
        after.st_mtime_ns,
        after.st_ctime_ns,
    ) != (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns):
        raise AmberInspectionError("artifact_changed", "Artifact changed while its digest was read")
    stream.seek(0)
    return _Snapshot(
        digest=digest.hexdigest(),
        size=size,
        device=before.st_dev,
        inode=before.st_ino,
        mtime_ns=before.st_mtime_ns,
        ctime_ns=before.st_ctime_ns,
    )


def _open_regular_readonly(path: str | Path) -> BinaryIO:
    """Open one immutable-ish regular file without following a path indirection.

    This decoder is not a generic file reader.  A future CAS-aware adapter
    must pass an already-authorized artifact descriptor; this local boundary
    nevertheless refuses symlinks, FIFOs, devices, and directories so a CLI
    invocation cannot turn inspection into a blocking or unbounded stream.
    """

    flags = os.O_RDONLY
    for name in ("O_CLOEXEC", "O_NOFOLLOW", "O_NONBLOCK"):
        flags |= getattr(os, name, 0)
    try:
        descriptor = os.open(os.fspath(path), flags)
    except OSError as error:
        raise AmberInspectionError(
            "artifact_open_failed", "Artifact could not be opened as a safe regular file"
        ) from error
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise AmberInspectionError(
                "artifact_not_regular", "AMBER inspection accepts only regular files"
            )
        return os.fdopen(descriptor, "rb", closefd=True)
    except BaseException:
        os.close(descriptor)
        raise


def _assert_stable(stream: BinaryIO, snapshot: _Snapshot) -> None:
    current = os.fstat(stream.fileno())
    if (
        current.st_dev,
        current.st_ino,
        current.st_size,
        current.st_mtime_ns,
        current.st_ctime_ns,
    ) != (
        snapshot.device,
        snapshot.inode,
        snapshot.size,
        snapshot.mtime_ns,
        snapshot.ctime_ns,
    ):
        raise AmberInspectionError("artifact_changed", "Artifact changed during inspection")
    stream.seek(0)


def _read_attribute_list(reader: _HeaderReader) -> dict[str, str]:
    tag = reader.u32()
    count = reader.u32()
    if tag == 0:
        if count != 0:
            raise AmberInspectionError(
                "invalid_netcdf_list", "Absent attribute list has a nonzero count"
            )
        return {}
    if tag != _NETCDF_ATTRIBUTE or count > _MAX_HEADER_ITEMS:
        raise AmberInspectionError("invalid_netcdf_attributes", "Invalid NetCDF attribute list")
    attributes: dict[str, str] = {}
    names: set[str] = set()
    for _ in range(count):
        name = reader.name()
        if name in names:
            raise AmberInspectionError(
                "duplicate_netcdf_attribute", "NetCDF attributes are not unique"
            )
        names.add(name)
        nc_type = reader.u32()
        element_count = reader.u32()
        item_size = _NC_TYPE_SIZES.get(nc_type)
        if item_size is None:
            raise AmberInspectionError(
                "unsupported_netcdf_type", "Unsupported NetCDF attribute type"
            )
        value_size = item_size * element_count
        if value_size > _MAX_ATTRIBUTE_BYTES:
            raise AmberInspectionError(
                "netcdf_attribute_too_large", "NetCDF attribute exceeds bound"
            )
        raw = reader.padded(value_size)
        if nc_type == _NC_CHAR:
            try:
                attributes[name] = raw.decode("ascii")
            except UnicodeDecodeError:
                attributes[name] = raw.decode("ascii", errors="replace")
    return attributes


def _parse_netcdf_header(
    stream: BinaryIO, size: int
) -> tuple[int, int, list[_Dimension], list[_Variable]]:
    reader = _HeaderReader(stream, size)
    magic = reader.read(4)
    if magic not in (b"CDF\x01", b"CDF\x02"):
        raise AmberInspectionError(
            "unsupported_netcdf_format", "Only NetCDF classic CDF-1/2 is supported"
        )
    version = magic[-1]
    record_count = reader.u32()

    dimension_tag = reader.u32()
    dimension_count = reader.u32()
    if dimension_tag == 0:
        if dimension_count != 0:
            raise AmberInspectionError(
                "invalid_netcdf_list", "Absent dimension list has a nonzero count"
            )
        dimensions: list[_Dimension] = []
    elif dimension_tag != _NETCDF_DIMENSION or dimension_count > _MAX_HEADER_ITEMS:
        raise AmberInspectionError("invalid_netcdf_dimensions", "Invalid NetCDF dimension list")
    else:
        dimensions = []
        unlimited = 0
        for _ in range(dimension_count):
            name = reader.name()
            raw_size = reader.u32()
            is_unlimited = raw_size == 0
            if is_unlimited:
                unlimited += 1
            dimensions.append(_Dimension(name=name, size=raw_size, unlimited=is_unlimited))
        if unlimited > 1:
            raise AmberInspectionError(
                "unsupported_netcdf_dimensions", "More than one unlimited dimension"
            )

    _read_attribute_list(reader)  # Global attributes are re-read below from the same header span.

    variable_tag = reader.u32()
    variable_count = reader.u32()
    if variable_tag == 0:
        if variable_count != 0:
            raise AmberInspectionError(
                "invalid_netcdf_list", "Absent variable list has a nonzero count"
            )
        return version, record_count, dimensions, []
    if variable_tag != _NETCDF_VARIABLE or variable_count > _MAX_HEADER_ITEMS:
        raise AmberInspectionError("invalid_netcdf_variables", "Invalid NetCDF variable list")
    variables: list[_Variable] = []
    for _ in range(variable_count):
        name = reader.name()
        ndims = reader.u32()
        if ndims > len(dimensions):
            raise AmberInspectionError(
                "invalid_netcdf_variable", "NetCDF variable has too many dimensions"
            )
        dimension_ids = tuple(reader.u32() for _ in range(ndims))
        if any(identifier >= len(dimensions) for identifier in dimension_ids):
            raise AmberInspectionError(
                "invalid_netcdf_variable", "NetCDF variable references an unknown dimension"
            )
        attributes = _read_attribute_list(reader)
        nc_type = reader.u32()
        if nc_type not in _NC_TYPE_SIZES:
            raise AmberInspectionError(
                "unsupported_netcdf_type", "Unsupported NetCDF variable type"
            )
        vsize = reader.u32()
        begin = reader.u64() if version == 2 else reader.u32()
        variables.append(
            _Variable(
                name=name,
                dimension_ids=dimension_ids,
                attributes=attributes,
                nc_type=nc_type,
                vsize=vsize,
                begin=begin,
            )
        )
    _validate_netcdf_layout(dimensions, variables, record_count, reader.offset, size)
    return version, record_count, dimensions, variables


def _validate_netcdf_layout(
    dimensions: list[_Dimension],
    variables: list[_Variable],
    record_count: int,
    header_end: int,
    file_size: int,
) -> None:
    """Reject aliasing headers/payloads before any numeric observation is made."""
    fixed: list[tuple[int, int]] = []
    records: list[tuple[int, int]] = []
    for variable in variables:
        if any(dimensions[index].unlimited for index in variable.dimension_ids[1:]):
            raise AmberInspectionError("invalid_netcdf_layout", "Unlimited dimension is not first")
        record = _is_record_variable(variable, dimensions)
        shape = _variable_shape(variable, dimensions, record_count)
        count = _safe_product(shape[1:] if record else shape)
        byte_count = count * _NC_TYPE_SIZES[variable.nc_type]
        padded_size = (byte_count + 3) & ~3
        if variable.vsize != padded_size or variable.begin % 4 or variable.begin < header_end:
            raise AmberInspectionError(
                "invalid_netcdf_layout", "Variable size/alignment overlaps or disagrees with header"
            )
        (records if record else fixed).append((variable.begin, variable.begin + padded_size))
    fixed.sort()
    records.sort()
    for ranges in (fixed, records):
        if any(right[0] < left[1] for left, right in zip(ranges, ranges[1:])):
            raise AmberInspectionError("invalid_netcdf_layout", "NetCDF variable payloads overlap")
    if records:
        if any(right[0] != left[1] for left, right in zip(records, records[1:])):
            raise AmberInspectionError(
                "invalid_netcdf_layout", "Record variables are not contiguous"
            )
        if fixed and fixed[-1][1] > records[0][0]:
            raise AmberInspectionError("invalid_netcdf_layout", "Fixed payload overlaps records")
        stride = records[-1][1] - records[0][0]
        if records[0][0] + stride * record_count > file_size:
            raise _TruncatedArtifact("NetCDF record payload is incomplete")
    if fixed and fixed[-1][1] > file_size:
        raise _TruncatedArtifact("NetCDF fixed payload is incomplete")


def _read_global_attributes(stream: BinaryIO, size: int) -> dict[str, str]:
    """Read just enough header a second time to retain global attributes.

    The primary header parser keeps the variable code compact.  Re-reading a
    bounded header avoids carrying an otherwise unused global attribute object
    through every variable operation.
    """

    stream.seek(0)
    reader = _HeaderReader(stream, size)
    reader.read(4)
    reader.u32()
    tag = reader.u32()
    count = reader.u32()
    if tag == _NETCDF_DIMENSION:
        for _ in range(count):
            reader.name()
            reader.u32()
    elif tag != 0 or count != 0:
        raise AmberInspectionError("invalid_netcdf_dimensions", "Invalid NetCDF dimension list")
    return _read_attribute_list(reader)


def _variable_shape(
    variable: _Variable,
    dimensions: list[_Dimension],
    record_count: int,
) -> tuple[int, ...]:
    shape: list[int] = []
    for identifier in variable.dimension_ids:
        dimension = dimensions[identifier]
        shape.append(record_count if dimension.unlimited else dimension.size)
    return tuple(shape)


def _safe_product(values: tuple[int, ...]) -> int:
    result = 1
    for value in values:
        if value < 0:
            raise AmberInspectionError("invalid_netcdf_dimension", "Negative NetCDF dimension")
        result *= value
        if result > _MAX_INSPECTABLE_BYTES:
            raise AmberInspectionError(
                "netcdf_dimension_too_large", "NetCDF dimension product exceeds bound"
            )
    return result


def _is_record_variable(variable: _Variable, dimensions: list[_Dimension]) -> bool:
    return bool(variable.dimension_ids) and dimensions[variable.dimension_ids[0]].unlimited


def _record_stride(variables: list[_Variable], dimensions: list[_Dimension]) -> int:
    values = [variable.vsize for variable in variables if _is_record_variable(variable, dimensions)]
    stride = sum(values)
    if values and stride <= 0:
        raise AmberInspectionError(
            "invalid_netcdf_record_stride", "NetCDF record variables have no stride"
        )
    return stride


def _variable_ranges(
    variable: _Variable,
    dimensions: list[_Dimension],
    record_count: int,
    record_stride: int,
    file_size: int,
) -> Iterator[tuple[int, int]]:
    shape = _variable_shape(variable, dimensions, record_count)
    item_size = _NC_TYPE_SIZES[variable.nc_type]
    if _is_record_variable(variable, dimensions):
        per_record = _safe_product(shape[1:]) * item_size
        if variable.vsize < per_record:
            raise AmberInspectionError(
                "invalid_netcdf_vsize", "NetCDF record variable size is too small"
            )
        for record in range(record_count):
            offset = variable.begin + record * record_stride
            if offset + per_record > file_size:
                raise _TruncatedArtifact("NetCDF record variable ends before all records")
            yield offset, per_record
        return
    count = _safe_product(shape)
    byte_count = count * item_size
    if variable.begin + byte_count > file_size:
        raise _TruncatedArtifact("NetCDF variable ends before its declared payload")
    yield variable.begin, byte_count


@dataclass
class _NumericStats:
    count: int = 0
    finite: bool = True
    minimum: float | None = None
    maximum: float | None = None

    def add(self, value: float) -> None:
        self.count += 1
        if not math.isfinite(value):
            self.finite = False
            return
        self.minimum = value if self.minimum is None else min(self.minimum, value)
        self.maximum = value if self.maximum is None else max(self.maximum, value)


@dataclass
class _TimeStats(_NumericStats):
    first: float | None = None
    last: float | None = None
    previous: float | None = None
    min_delta: float | None = None
    max_delta: float | None = None
    duplicate: bool = False
    nonmonotonic: bool = False
    precision: float | None = None

    def add_time(self, value: float, nc_type: int) -> None:
        self.add(value)
        if not math.isfinite(value):
            return
        if self.first is None:
            self.first = value
        if self.previous is not None:
            delta = value - self.previous
            if delta == 0:
                self.duplicate = True
            elif delta < 0:
                self.nonmonotonic = True
            else:
                self.min_delta = delta if self.min_delta is None else min(self.min_delta, delta)
                self.max_delta = delta if self.max_delta is None else max(self.max_delta, delta)
        self.previous = value
        self.last = value
        exponent = -23 if nc_type == _NC_FLOAT else -52
        floor = 2.0 ** (-149 if nc_type == _NC_FLOAT else -1074)
        observed = max(abs(value) * (2.0**exponent), floor)
        self.precision = observed if self.precision is None else max(self.precision, observed)


def _numeric_values(
    stream: BinaryIO,
    variable: _Variable,
    dimensions: list[_Dimension],
    record_count: int,
    record_stride: int,
    file_size: int,
) -> Iterator[float]:
    code = _NC_NUMERIC_FORMATS.get(variable.nc_type)
    if code is None:
        raise AmberInspectionError("non_numeric_netcdf_variable", f"{variable.name} is not numeric")
    item_size = _NC_TYPE_SIZES[variable.nc_type]
    block_size = max(item_size, (_BLOCK_BYTES // item_size) * item_size)
    for offset, byte_count in _variable_ranges(
        variable, dimensions, record_count, record_stride, file_size
    ):
        stream.seek(offset)
        remaining = byte_count
        while remaining:
            take = min(remaining, block_size)
            chunk = stream.read(take)
            if len(chunk) != take:
                raise _TruncatedArtifact("NetCDF variable changed or ended during decode")
            for (value,) in struct.iter_unpack(f">{code}", chunk):
                yield float(value)
            remaining -= take


def _inspect_numeric(
    stream: BinaryIO,
    variable: _Variable,
    dimensions: list[_Dimension],
    record_count: int,
    record_stride: int,
    file_size: int,
    *,
    time: bool = False,
) -> _NumericStats | _TimeStats:
    stats: _NumericStats | _TimeStats = _TimeStats() if time else _NumericStats()
    for value in _numeric_values(
        stream, variable, dimensions, record_count, record_stride, file_size
    ):
        if isinstance(stats, _TimeStats):
            stats.add_time(value, variable.nc_type)
        else:
            stats.add(value)
    return stats


def _variable_by_name(variables: list[_Variable], name: str) -> _Variable | None:
    return next((variable for variable in variables if variable.name == name), None)


def _time_summary(stats: _TimeStats | None) -> dict[str, Any]:
    if stats is None:
        return _empty_time("missing")
    if not stats.finite:
        status = "non_finite"
    elif stats.count == 0:
        status = "missing"
    elif stats.count == 1:
        status = "single_frame"
    elif stats.nonmonotonic:
        status = "nonmonotonic"
    elif stats.duplicate:
        status = "duplicate"
    else:
        status = "strictly_increasing"
    if stats.count <= 1:
        cadence = "single_frame" if stats.count == 1 else "missing"
    elif stats.min_delta is None or stats.max_delta is None:
        cadence = "missing"
    else:
        tolerance = (stats.precision or 0.0) * 4.0
        cadence = "uniform" if stats.max_delta - stats.min_delta <= tolerance else "irregular"
    return {
        "status": status,
        "cadenceStatus": cadence,
        "count": stats.count,
        "firstPs": stats.first,
        "lastPs": stats.last,
        "minDeltaPs": stats.min_delta,
        "maxDeltaPs": stats.max_delta,
        "precisionPs": stats.precision,
    }


def _physical_cell(values: tuple[float, ...] | list[float]) -> bool:
    if len(values) != 6 or not all(math.isfinite(value) for value in values):
        return False
    if any(value <= 0 for value in values[:3]) or any(not 0 < value < 180 for value in values[3:]):
        return False
    a, b, c = (math.cos(math.radians(value)) for value in values[3:])
    return 1 + 2 * a * b * c - a * a - b * b - c * c > 0


def _inspect_netcdf(
    stream: BinaryIO,
    snapshot: _Snapshot,
    artifact_kind: str,
) -> dict[str, Any]:
    stream.seek(0)
    _, record_count, dimensions, variables = _parse_netcdf_header(stream, snapshot.size)
    global_attributes = _read_global_attributes(stream, snapshot.size)
    _assert_stable(stream, snapshot)
    by_name = {variable.name: variable for variable in variables}
    if len(by_name) != len(variables):
        raise AmberInspectionError(
            "duplicate_netcdf_variable", "NetCDF variable names are not unique"
        )
    dimension_map = {dimension.name: dimension for dimension in dimensions}
    if len(dimension_map) != len(dimensions):
        raise AmberInspectionError(
            "duplicate_netcdf_dimension", "NetCDF dimension names are not unique"
        )
    record_stride = _record_stride(variables, dimensions)
    result = _base_result(
        artifact_kind=artifact_kind,
        snapshot=snapshot,
        artifact_format="amber_netcdf",
        inspection_level="decoded",
        read_status="complete",
        diagnostics=[],
    )
    result["convention"] = global_attributes.get("Conventions")
    if result["convention"] != ("AMBER" if artifact_kind == "trajectory" else "AMBERRESTART"):
        raise AmberInspectionError(
            "invalid_netcdf_convention", "Unexpected AMBER NetCDF convention"
        )
    result["dimensions"] = {
        dimension.name: (record_count if dimension.unlimited else dimension.size)
        for dimension in dimensions
    }
    coordinates = by_name.get("coordinates")
    if coordinates is None:
        raise AmberInspectionError("missing_coordinates", "AMBER NetCDF artifact lacks coordinates")
    coordinate_shape = _variable_shape(coordinates, dimensions, record_count)
    coordinate_dim_names = tuple(dimensions[index].name for index in coordinates.dimension_ids)
    if coordinates.nc_type not in (_NC_FLOAT, _NC_DOUBLE):
        raise AmberInspectionError(
            "invalid_coordinates_type", "Coordinates must use float or double"
        )
    expected_coordinate_names: tuple[str, ...]
    if artifact_kind == "trajectory":
        expected_coordinate_names = ("frame", "atom", "spatial")
        if coordinate_dim_names != expected_coordinate_names:
            raise AmberInspectionError(
                "invalid_trajectory_dimensions",
                "AMBER trajectory coordinates must use frame, atom, spatial dimensions",
            )
        if not dimensions[coordinates.dimension_ids[0]].unlimited:
            raise AmberInspectionError(
                "invalid_trajectory_dimensions",
                "AMBER trajectory frame dimension must be unlimited",
            )
        frame_count = coordinate_shape[0]
        atom_count = coordinate_shape[1]
    elif artifact_kind == "restart":
        expected_coordinate_names = ("atom", "spatial")
        if coordinate_dim_names != expected_coordinate_names:
            raise AmberInspectionError(
                "invalid_restart_dimensions",
                "AMBER restart coordinates must use atom, spatial dimensions",
            )
        frame_count = 1
        atom_count = coordinate_shape[0]
    else:
        raise AmberInspectionError(
            "invalid_artifact_kind", "NetCDF inspection supports restart or trajectory"
        )
    if atom_count <= 0 or coordinate_shape[-1] != 3 or dimension_map.get("spatial") is None:
        raise AmberInspectionError(
            "invalid_coordinate_shape", "AMBER coordinates require a nonempty xyz shape"
        )
    if artifact_kind == "trajectory" and frame_count <= 0:
        raise AmberInspectionError("empty_trajectory", "AMBER trajectory contains no frames")
    coordinates_stats = _inspect_numeric(
        stream, coordinates, dimensions, record_count, record_stride, snapshot.size
    )
    if not coordinates_stats.finite:
        result["diagnostics"].append(
            _diagnostic(
                "non_finite_coordinates", "error", "Coordinate bytes contain NaN or infinity"
            )
        )

    velocity_stats: _NumericStats | None = None
    velocities = by_name.get("velocities")
    if velocities is not None:
        velocity_shape = _variable_shape(velocities, dimensions, record_count)
        velocity_dimension_names = tuple(
            dimensions[index].name for index in velocities.dimension_ids
        )
        if (
            velocities.nc_type not in (_NC_FLOAT, _NC_DOUBLE)
            or velocity_dimension_names != coordinate_dim_names
            or velocity_shape != coordinate_shape
        ):
            raise AmberInspectionError(
                "invalid_velocity_dimensions",
                "AMBER velocity coordinates must have the same numeric shape as coordinates",
            )
        velocity_stats = _inspect_numeric(
            stream, velocities, dimensions, record_count, record_stride, snapshot.size
        )
        if not velocity_stats.finite:
            result["diagnostics"].append(
                _diagnostic(
                    "non_finite_velocities", "error", "Velocity bytes contain NaN or infinity"
                )
            )

    time_variable = by_name.get("time")
    time_stats: _TimeStats | None = None
    if time_variable is not None:
        time_names = tuple(dimensions[index].name for index in time_variable.dimension_ids)
        if time_variable.nc_type not in (_NC_FLOAT, _NC_DOUBLE) or time_names != (
            ("frame",) if artifact_kind == "trajectory" else ()
        ):
            raise AmberInspectionError(
                "invalid_time_dimensions", "Time variable has invalid shape/type"
            )
        time_stats_value = _inspect_numeric(
            stream,
            time_variable,
            dimensions,
            record_count,
            record_stride,
            snapshot.size,
            time=True,
        )
        assert isinstance(time_stats_value, _TimeStats)
        time_stats = time_stats_value
        if time_variable.attributes.get("units") != "picosecond":
            result["diagnostics"].append(
                _diagnostic(
                    "unexpected_time_units", "error", "AMBER NetCDF time units must be picosecond"
                )
            )
        if artifact_kind == "trajectory" and time_stats.count != frame_count:
            result["diagnostics"].append(
                _diagnostic(
                    "time_frame_count_mismatch", "error", "Time sample count differs from frames"
                )
            )
    elif artifact_kind == "trajectory":
        result["diagnostics"].append(
            _diagnostic("missing_time", "error", "AMBER trajectory lacks its time variable")
        )

    cell_lengths = by_name.get("cell_lengths")
    cell_angles = by_name.get("cell_angles")
    if cell_lengths is None and cell_angles is None:
        cell = _empty_cell("not_present")
        has_periodic_box = False
    elif cell_lengths is None or cell_angles is None:
        cell = _empty_cell("partial")
        has_periodic_box = False
        result["diagnostics"].append(
            _diagnostic("partial_periodic_box", "error", "Only one AMBER cell variable is present")
        )
    else:
        for variable, last_dimension in (
            (cell_lengths, "cell_spatial"),
            (cell_angles, "cell_angular"),
        ):
            names = tuple(dimensions[index].name for index in variable.dimension_ids)
            expected_names = (
                ("frame", last_dimension) if artifact_kind == "trajectory" else (last_dimension,)
            )
            shape = _variable_shape(variable, dimensions, record_count)
            if (
                variable.nc_type not in (_NC_FLOAT, _NC_DOUBLE)
                or names != expected_names
                or shape[-1] != 3
            ):
                raise AmberInspectionError(
                    "invalid_cell_dimensions", "Cell variables have invalid shape/type"
                )
        length_stats = _inspect_numeric(
            stream, cell_lengths, dimensions, record_count, record_stride, snapshot.size
        )
        angle_stats = _inspect_numeric(
            stream, cell_angles, dimensions, record_count, record_stride, snapshot.size
        )
        cell_frames = frame_count if artifact_kind == "trajectory" else 1
        expected_cell_values = cell_frames * 3
        expected_cell_count = (
            length_stats.count == expected_cell_values and angle_stats.count == expected_cell_values
        )
        physical = (
            length_stats.minimum is not None
            and length_stats.minimum > 0
            and angle_stats.minimum is not None
            and angle_stats.minimum > 0
            and angle_stats.maximum is not None
            and angle_stats.maximum < 180
        )
        variable_across_frames = False
        first_cell: tuple[float, ...] | None = None
        lengths = iter(
            _numeric_values(
                stream, cell_lengths, dimensions, record_count, record_stride, snapshot.size
            )
        )
        angles = iter(
            _numeric_values(
                stream, cell_angles, dimensions, record_count, record_stride, snapshot.size
            )
        )
        for _ in range(cell_frames):
            cell_values = tuple(next(lengths) for _ in range(3)) + tuple(
                next(angles) for _ in range(3)
            )
            if first_cell is None:
                first_cell = cell_values
            elif cell_values != first_cell:
                variable_across_frames = True
            physical = physical and _physical_cell(cell_values)
        cell_complete = (
            expected_cell_count and length_stats.finite and angle_stats.finite and physical
        )
        cell = {
            "status": (
                "complete"
                if cell_complete
                else "non_finite"
                if not length_stats.finite or not angle_stats.finite
                else "malformed"
            ),
            "frameCount": cell_frames,
            "variableAcrossFrames": variable_across_frames,
        }
        has_periodic_box = cell_complete
        if not cell_complete:
            result["diagnostics"].append(
                _diagnostic(
                    "invalid_periodic_box", "error", "Cell variables are non-finite or malformed"
                )
            )

    result["atomCount"] = atom_count
    result["frameCount"] = frame_count
    result["hasPeriodicBox"] = has_periodic_box
    result["hasVelocities"] = velocities is not None
    result["finiteValues"] = (
        coordinates_stats.finite
        and (velocity_stats is None or velocity_stats.finite)
        and (time_stats is None or time_stats.finite)
        and cell["status"] not in ("non_finite", "partial", "malformed")
    )
    result["time"] = _time_summary(time_stats)
    result["cell"] = cell
    if result["time"]["status"] in ("duplicate", "nonmonotonic", "non_finite"):
        result["diagnostics"].append(
            _diagnostic(
                "invalid_trajectory_time",
                "error",
                f"Trajectory time sequence is {result['time']['status']}",
            )
        )
    if result["time"]["cadenceStatus"] == "irregular":
        result["diagnostics"].append(
            _diagnostic(
                "irregular_trajectory_cadence",
                "warning",
                "Observed time cadence is irregular; compare it to the approved stage cadence",
            )
        )
    _assert_stable(stream, snapshot)
    return result


def _read_bounded_text(stream: BinaryIO, snapshot: _Snapshot) -> str:
    if snapshot.size > _MAX_TEXT_BYTES:
        raise AmberInspectionError(
            "text_artifact_too_large", "Formatted AMBER artifact exceeds text bound"
        )
    stream.seek(0)
    chunks: list[bytes] = []
    remaining = snapshot.size
    while remaining:
        chunk = stream.read(min(_BLOCK_BYTES, remaining))
        if not chunk:
            raise _TruncatedArtifact("Formatted AMBER artifact ended during decode")
        chunks.append(chunk)
        remaining -= len(chunk)
    _assert_stable(stream, snapshot)
    try:
        return b"".join(chunks).decode("ascii")
    except UnicodeDecodeError as error:
        raise AmberInspectionError(
            "invalid_formatted_amber", "Formatted AMBER artifact is not ASCII"
        ) from error


def _decimal_precision(token: str) -> float | None:
    normalized = token.strip().lower().replace("d", "e")
    if not normalized or "nan" in normalized or "inf" in normalized:
        return None
    mantissa = normalized.split("e", 1)[0]
    decimals = len(mantissa.split(".", 1)[1]) if "." in mantissa else 0
    exponent = int(normalized.split("e", 1)[1]) if "e" in normalized else 0
    return 10.0 ** (exponent - decimals)


def _float_token(token: str) -> float:
    try:
        return float(token.replace("D", "E").replace("d", "e"))
    except ValueError as error:
        raise AmberInspectionError(
            "invalid_numeric_value", f"Invalid AMBER numeric value {token!r}"
        ) from error


def _inspect_ascii_restart(stream: BinaryIO, snapshot: _Snapshot) -> dict[str, Any]:
    text = _read_bounded_text(stream, snapshot)
    lines = text.splitlines()
    if len(lines) < 2:
        raise _TruncatedArtifact("Formatted restart lacks title or atom-count line")
    fields = lines[1].split()
    if not fields or len(fields) > 2 or not re.fullmatch(r"\d+", fields[0]):
        raise AmberInspectionError(
            "invalid_restart_atom_count", "Formatted restart lacks an integer atom count"
        )
    atom_count = int(fields[0])
    if atom_count <= 0:
        raise AmberInspectionError(
            "invalid_restart_atom_count", "Formatted restart atom count must be positive"
        )
    payload = "\n".join(lines[2:])
    if _NUMERIC_TOKEN.sub("", payload).strip():
        raise AmberInspectionError(
            "invalid_restart_payload", "Restart contains non-numeric payload text"
        )
    numeric_tokens = _NUMERIC_TOKEN.findall(payload)
    values = [_float_token(token) for token in numeric_tokens]
    coordinate_values = atom_count * 3
    count = len(values)
    valid_counts = {
        coordinate_values: (False, False),
        coordinate_values + 6: (False, True),
        coordinate_values * 2: (True, False),
        coordinate_values * 2 + 6: (True, True),
    }
    if count < coordinate_values:
        raise _TruncatedArtifact("Formatted restart ends before all coordinate values")
    if count not in valid_counts:
        raise AmberInspectionError(
            "invalid_restart_payload",
            "Formatted restart has an invalid coordinate/velocity/box count",
        )
    has_velocities, has_box = valid_counts[count]
    if atom_count == 2 and count == 12:
        raise AmberInspectionError(
            "ambiguous_restart_payload", "Two-atom restart cannot distinguish a box from velocities"
        )
    finite = all(math.isfinite(value) for value in values)
    box_finite = not has_box or all(math.isfinite(value) for value in values[-6:])
    box_valid = not has_box or _physical_cell(values[-6:])
    diagnostics: list[dict[str, str]] = []
    if not finite:
        diagnostics.append(
            _diagnostic(
                "non_finite_restart_value", "error", "Restart bytes contain NaN or infinity"
            )
        )
    if not box_valid:
        diagnostics.append(
            _diagnostic(
                "invalid_periodic_box", "error", "Restart cell is non-finite or nonphysical"
            )
        )
        finite = False
    time = _empty_time("missing")
    if len(fields) > 1:
        restart_time = _float_token(fields[1])
        if not math.isfinite(restart_time):
            finite = False
            diagnostics.append(
                _diagnostic("non_finite_restart_time", "error", "Restart time is NaN or infinity")
            )
        precision = _decimal_precision(fields[1])
        time = {
            "status": "single_frame" if math.isfinite(restart_time) else "non_finite",
            "cadenceStatus": "single_frame",
            "count": 1,
            "firstPs": restart_time if math.isfinite(restart_time) else None,
            "lastPs": restart_time if math.isfinite(restart_time) else None,
            "minDeltaPs": None,
            "maxDeltaPs": None,
            "precisionPs": precision,
        }
    result = _base_result(
        artifact_kind="restart",
        snapshot=snapshot,
        artifact_format="amber_ascii_restart",
        inspection_level="decoded",
        read_status="complete",
        diagnostics=diagnostics,
    )
    result.update(
        {
            "convention": "AMBER ASCII restart",
            "atomCount": atom_count,
            "frameCount": 1,
            "hasPeriodicBox": has_box,
            "hasVelocities": has_velocities,
            "finiteValues": finite,
            "dimensions": {"atom": atom_count, "spatial": 3},
            "time": time,
            "cell": {
                "status": (
                    "complete"
                    if has_box and box_valid
                    else "non_finite"
                    if has_box and not box_finite
                    else "malformed"
                    if has_box
                    else "not_present"
                ),
                "frameCount": 1 if has_box else None,
                "variableAcrossFrames": False if has_box else None,
            },
        }
    )
    return result


def _prmtop_sections(text: str) -> dict[str, list[str]]:
    lines = text.splitlines()
    sections: dict[str, list[str]] = {}
    index = 0
    while index < len(lines):
        line = lines[index].strip()
        if not line.startswith("%FLAG "):
            index += 1
            continue
        name = line[6:].strip()
        if not name or index + 1 >= len(lines):
            raise AmberInspectionError("invalid_prmtop_section", "prmtop flag lacks a format line")
        match = _PRMTOP_FORMAT.fullmatch(lines[index + 1].strip())
        if match is None:
            raise AmberInspectionError("invalid_prmtop_format", f"Unsupported format for {name}")
        width = int(match.group(3))
        if width <= 0 or width > 1024:
            raise AmberInspectionError("invalid_prmtop_format", f"Invalid width for {name}")
        values: list[str] = []
        index += 2
        while index < len(lines) and not lines[index].startswith("%FLAG "):
            if lines[index].startswith("%"):
                index += 1
                continue
            for offset in range(0, len(lines[index]), width):
                value = lines[index][offset : offset + width].strip()
                if value:
                    values.append(value)
            index += 1
        if name in sections:
            raise AmberInspectionError(
                "duplicate_prmtop_section", f"Duplicate prmtop section {name}"
            )
        sections[name] = values
    return sections


def _inspect_prmtop(stream: BinaryIO, snapshot: _Snapshot) -> dict[str, Any]:
    text = _read_bounded_text(stream, snapshot)
    sections = _prmtop_sections(text)
    pointers = sections.get("POINTERS", [])
    if not pointers or not re.fullmatch(r"\d+", pointers[0]):
        raise AmberInspectionError("missing_prmtop_atom_count", "prmtop POINTERS/NATOM is absent")
    atom_count = int(pointers[0])
    if atom_count <= 0:
        raise AmberInspectionError("invalid_prmtop_atom_count", "prmtop NATOM must be positive")
    atom_names = sections.get("ATOM_NAME", [])
    if len(atom_names) != atom_count:
        raise AmberInspectionError("invalid_prmtop_atom_names", "ATOM_NAME does not cover NATOM")
    labels = sections.get("RESIDUE_LABEL", [])
    pointer_tokens = sections.get("RESIDUE_POINTER", [])
    try:
        residue_pointers = [int(token) for token in pointer_tokens]
    except ValueError as error:
        raise AmberInspectionError(
            "invalid_prmtop_residues", "RESIDUE_POINTER is not integer"
        ) from error
    if (
        not labels
        or len(labels) != len(residue_pointers)
        or residue_pointers[0] != 1
        or any(
            value < 1 or value > atom_count or (index > 0 and value <= residue_pointers[index - 1])
            for index, value in enumerate(residue_pointers)
        )
    ):
        raise AmberInspectionError("invalid_prmtop_residues", "RESIDUE_LABEL/POINTER is invalid")
    residues = [""] * atom_count
    for index, label in enumerate(labels):
        start = residue_pointers[index] - 1
        end = (residue_pointers[index + 1] if index + 1 < len(labels) else atom_count + 1) - 1
        residues[start:end] = [label] * (end - start)
    if any(not residue for residue in residues):
        raise AmberInspectionError("invalid_prmtop_residues", "Residue labels do not cover NATOM")
    charges = [_float_token(token) for token in sections.get("CHARGE", [])]
    finite = len(charges) == atom_count and all(math.isfinite(value) for value in charges)
    if "BOX_DIMENSIONS" in sections:
        box = [_float_token(token) for token in sections["BOX_DIMENSIONS"]]
        if (
            len(box) != 4
            or not all(math.isfinite(value) for value in box)
            or not 0 < box[0] < 180
            or any(length <= 0 for length in box[1:])
        ):
            raise AmberInspectionError(
                "invalid_prmtop_box",
                "BOX_DIMENSIONS requires finite beta and three positive lengths",
            )
    diagnostics: list[dict[str, str]] = []
    if not finite:
        diagnostics.append(
            _diagnostic(
                "invalid_prmtop_charge", "error", "CHARGE does not contain finite values for NATOM"
            )
        )
    identity = [{"residue": residue, "atom": atom} for residue, atom in zip(residues, atom_names)]
    atom_identity_digest = hashlib.sha256(
        json.dumps(identity, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode(
            "ascii"
        )
    ).hexdigest()
    result = _base_result(
        artifact_kind="prmtop",
        snapshot=snapshot,
        artifact_format="amber_prmtop",
        inspection_level="decoded",
        read_status="complete",
        diagnostics=diagnostics,
    )
    result.update(
        {
            "convention": "AMBER prmtop",
            "atomCount": atom_count,
            "frameCount": None,
            "hasPeriodicBox": "BOX_DIMENSIONS" in sections,
            "finiteValues": finite,
            "dimensions": {"atom": atom_count},
            "atomIdentityDigest": atom_identity_digest,
        }
    )
    return result


def _detect_format(stream: BinaryIO, artifact_kind: str) -> str:
    stream.seek(0)
    magic = stream.read(8)
    stream.seek(0)
    if magic[:4] in (b"CDF\x01", b"CDF\x02") or magic == b"\x89HDF\r\n\x1a\n":
        return "amber_netcdf"
    if artifact_kind == "prmtop":
        return "amber_prmtop"
    return "amber_ascii_restart"


def inspect_amber_artifact(
    path: str | Path,
    artifact_kind: Literal["prmtop", "restart", "trajectory"],
    *,
    metadata_only: bool = False,
) -> dict[str, Any]:
    """Inspect real AMBER bytes at ``path`` without accepting caller metadata.

    A malformed or truncated artifact is returned as an observed failed decode,
    rather than being promoted to a metadata-only success.  ``metadata_only``
    is explicit and exists only for callers that intentionally avoid decoding.
    """

    if artifact_kind not in {"prmtop", "restart", "trajectory"}:
        raise ValueError("artifact_kind must be prmtop, restart, or trajectory")
    with _open_regular_readonly(path) as stream:
        snapshot = _snapshot(stream)
        artifact_format = _detect_format(stream, artifact_kind)
        if metadata_only:
            return _base_result(
                artifact_kind=artifact_kind,
                snapshot=snapshot,
                artifact_format=artifact_format,
                inspection_level="metadata_only",
                read_status="complete",
                diagnostics=[
                    _diagnostic(
                        "metadata_only",
                        "warning",
                        "Artifact digest was observed but bytes were not decoded",
                    )
                ],
            )
        try:
            if artifact_format == "amber_netcdf":
                if artifact_kind == "prmtop":
                    raise AmberInspectionError(
                        "invalid_prmtop_format", "prmtop must be formatted text"
                    )
                return _inspect_netcdf(stream, snapshot, artifact_kind)
            if artifact_kind == "trajectory":
                raise AmberInspectionError(
                    "invalid_trajectory_format",
                    "AMBER trajectory inspection requires NetCDF CDF-1/2",
                )
            if artifact_kind == "restart":
                return _inspect_ascii_restart(stream, snapshot)
            return _inspect_prmtop(stream, snapshot)
        except AmberInspectionError as error:
            return _base_result(
                artifact_kind=artifact_kind,
                snapshot=snapshot,
                artifact_format=artifact_format,
                inspection_level="decoded",
                read_status=error.read_status,
                diagnostics=[_diagnostic(error.code, "error", str(error))],
            )


def parse_amber_minimization_mdout(path: str | Path) -> dict[str, Any]:
    """Parse AMBER minimization tables without treating MD ``NSTEP =`` as them.

    ``FINAL RESULTS`` is recorded separately.  It is an engine output marker,
    not a scientific convergence claim or a substitute for a reviewed gradient
    threshold.
    """

    with _open_regular_readonly(path) as stream:
        snapshot = _snapshot(stream)
        try:
            text = _read_bounded_text(stream, snapshot)
        except AmberInspectionError as error:
            return {
                "schemaVersion": AMBER_MINIMIZATION_PARSE_SCHEMA_VERSION,
                "parser": {"id": AMBER_BYTE_INSPECTOR_ID, "version": AMBER_BYTE_INSPECTOR_VERSION},
                "observedContentDigest": snapshot.digest,
                "byteLength": snapshot.size,
                "status": "unreadable" if error.read_status == "unreadable" else "truncated",
                "terminalMarkerObserved": False,
                "finalResultsMarkerObserved": False,
                "convergenceStatus": "not_assessed",
                "samples": [],
                "final": None,
                "diagnostics": [_diagnostic(error.code, "error", str(error))],
            }
    samples: list[dict[str, Any]] = []
    final: dict[str, Any] | None = None
    diagnostics: list[dict[str, str]] = []
    after_header = False
    after_final = False
    for line_number, line in enumerate(text.splitlines(), start=1):
        if "FINAL RESULTS" in line.upper():
            after_final = True
            after_header = False
            continue
        if _MINIMIZATION_HEADER.fullmatch(line):
            after_header = True
            continue
        if not after_header:
            continue
        row = _MINIMIZATION_ROW.fullmatch(line)
        if row is None:
            if line.strip():
                after_header = False
            continue
        try:
            values = [_float_token(row.group(index)) for index in (2, 3, 4)]
        except AmberInspectionError as error:
            diagnostics.append(_diagnostic(error.code, "error", str(error)))
            after_header = False
            continue
        if not all(math.isfinite(value) for value in values):
            diagnostics.append(
                _diagnostic(
                    "non_finite_minimization_value",
                    "error",
                    "Minimization table contains NaN or infinity",
                )
            )
            after_header = False
            continue
        sample = {
            "step": int(row.group(1)),
            "energyKcalMol": values[0],
            "rmsGradientKcalMolAngstrom": values[1],
            "gmaxKcalMolAngstrom": values[2],
            "maxGradientAtomName": row.group(5),
            "maxGradientAtomNumber": int(row.group(6)),
            "line": line_number,
        }
        samples.append(sample)
        if after_final:
            final = sample
        after_header = False
    terminal_marker = bool(
        re.search(r"(?:FINAL PERFORMANCE INFO|\bTIMINGS\b)", text, re.IGNORECASE)
    )
    status = "completed" if terminal_marker and final is not None and not diagnostics else "partial"
    if not samples:
        diagnostics.append(
            _diagnostic(
                "missing_minimization_table", "error", "No AMBER minimization table was decoded"
            )
        )
        status = "unreadable"
    return {
        "schemaVersion": AMBER_MINIMIZATION_PARSE_SCHEMA_VERSION,
        "parser": {"id": AMBER_BYTE_INSPECTOR_ID, "version": AMBER_BYTE_INSPECTOR_VERSION},
        "observedContentDigest": snapshot.digest,
        "byteLength": snapshot.size,
        "status": status,
        "terminalMarkerObserved": terminal_marker,
        "finalResultsMarkerObserved": final is not None,
        # AMBER's FINAL RESULTS marker is not a protocol-specific convergence verdict.
        "convergenceStatus": "not_assessed",
        "samples": samples,
        "final": final,
        "diagnostics": diagnostics,
    }
