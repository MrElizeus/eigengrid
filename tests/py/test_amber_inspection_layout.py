"""Independent binary CDF-1/2 fixtures, not decoder-generated JSON or headers.

These small format fixtures complement the tracked AmberTools 26 byte fixtures.
The three explicit frames specify their own expected times, cells and values.
"""

import struct
import subprocess
import sys
from pathlib import Path

import pytest
from eigengrid_chem.amber.inspection import inspect_amber_artifact


def u32(value: int) -> bytes:
    return struct.pack(">I", value)


def name(value: str) -> bytes:
    encoded = value.encode("ascii")
    return u32(len(encoded)) + encoded + b"\0" * ((-len(encoded)) % 4)


def attributes(values: dict[str, str]) -> bytes:
    return (
        u32(12)
        + u32(len(values))
        + b"".join(name(key) + u32(2) + name(value) for key, value in values.items())
    )


def netcdf_fixture(
    path: Path,
    *,
    version: int = 1,
    lengths: tuple[tuple[float, ...], ...] = ((10, 20, 30),) * 3,
    angles: tuple[tuple[float, ...], ...] = ((90, 90, 90),) * 3,
    time_values: tuple[float, ...] = (0.1, 0.2, 0.3),
    velocity_shape: tuple[int, ...] = (0, 1, 2),
    cell_shape: tuple[int, ...] = (0, 3),
) -> dict[str, int]:
    dimensions = [
        ("frame", 0),
        ("atom", 1),
        ("spatial", 3),
        ("cell_spatial", 3),
        ("cell_angular", 3),
    ]
    header = bytearray(
        b"CDF" + bytes([version]) + u32(3) + u32(10) + u32(len(dimensions))
    )
    for label, size in dimensions:
        header += name(label) + u32(size)
    header += attributes({"Conventions": "AMBER"})
    variables = [
        ("time", (0,), 5, "picosecond", [[value] for value in time_values]),
        ("coordinates", (0, 1, 2), 5, "angstrom", [(1, 2, 3), (4, 5, 6), (7, 8, 9)]),
        ("velocities", velocity_shape, 5, "angstrom/picosecond", [(0.1, 0.2, 0.3)] * 3),
        ("cell_lengths", cell_shape, 6, "angstrom", lengths),
        ("cell_angles", (0, 4), 6, "degree", angles),
    ]
    header += u32(11) + u32(len(variables))
    begin_offsets = {}
    chunks = []
    for label, shape, nc_type, units, frames in variables:
        encoded = [
            struct.pack(">" + ("f" if nc_type == 5 else "d") * len(frame), *frame)
            for frame in frames
        ]
        chunks.append(encoded)
        header += (
            name(label) + u32(len(shape)) + b"".join(u32(index) for index in shape)
        )
        header += attributes({"units": units}) + u32(nc_type) + u32(len(encoded[0]))
        begin_offsets[label] = len(header)
        header += b"\0" * (8 if version == 2 else 4)
    current = len(header)
    for (label, *_), encoded in zip(variables, chunks):
        struct.pack_into(
            ">Q" if version == 2 else ">I", header, begin_offsets[label], current
        )
        current += len(encoded[0])
    path.write_bytes(
        header
        + b"".join(
            chunks[var][frame] for frame in range(3) for var in range(len(chunks))
        )
    )
    return begin_offsets


@pytest.mark.parametrize("version", [1, 2])
def test_npt_variable_cell_and_constant_anisotropic_cell_are_valid_bytes(
    tmp_path: Path, version: int
) -> None:
    path = tmp_path / "periodic.nc"
    netcdf_fixture(path, version=version)
    observed = inspect_amber_artifact(path, "trajectory")
    assert observed["readStatus"] == "complete"
    assert observed["finiteValues"] is True
    assert observed["cell"] == {
        "status": "complete",
        "frameCount": 3,
        "variableAcrossFrames": False,
    }
    assert observed["time"]["firstPs"] == pytest.approx(0.1)
    assert observed["time"]["lastPs"] == pytest.approx(0.3)

    netcdf_fixture(
        path, version=version, lengths=((10, 20, 30), (11, 21, 31), (12, 22, 32))
    )
    observed = inspect_amber_artifact(path, "trajectory")
    assert observed["cell"] == {
        "status": "complete",
        "frameCount": 3,
        "variableAcrossFrames": True,
    }
    assert observed["finiteValues"] is True
    assert observed["diagnostics"] == []


@pytest.mark.parametrize(
    "case", ["negative_length", "zero_length", "nan", "angle_180", "degenerate_angles"]
)
def test_rejects_nonphysical_or_nonfinite_cell_bytes(tmp_path: Path, case: str) -> None:
    path = tmp_path / "invalid-cell.nc"
    options = {
        "negative_length": {"lengths": ((-1, 20, 30),) * 3},
        "zero_length": {"lengths": ((0, 20, 30),) * 3},
        "nan": {"lengths": ((float("nan"), 20, 30),) * 3},
        "angle_180": {"angles": ((180, 90, 90),) * 3},
        "degenerate_angles": {"angles": ((170, 10, 10),) * 3},
    }
    netcdf_fixture(path, **options[case])
    observed = inspect_amber_artifact(path, "trajectory")
    assert observed["cell"]["status"] in {"non_finite", "malformed"}
    assert observed["finiteValues"] is False
    assert any(
        item["code"] == "invalid_periodic_box" for item in observed["diagnostics"]
    )


@pytest.mark.parametrize(
    "case", ["header", "alias", "gap", "truncated", "velocity_shape", "cell_shape"]
)
def test_rejects_header_aliases_overlaps_and_wrong_shapes(
    tmp_path: Path, case: str
) -> None:
    path = tmp_path / "hostile.nc"
    positions = netcdf_fixture(
        path,
        **(
            {"velocity_shape": (0, 2, 1)}
            if case == "velocity_shape"
            else {"cell_shape": (0, 4)}
            if case == "cell_shape"
            else {}
        ),
    )
    payload = bytearray(path.read_bytes())
    if case in {"header", "alias", "gap"}:
        offset = struct.unpack_from(">I", payload, positions["time"])[0]
        struct.pack_into(
            ">I",
            payload,
            positions["coordinates"],
            4 if case == "header" else offset if case == "alias" else offset + 8,
        )
    elif case == "truncated":
        del payload[-1:]
    path.write_bytes(payload)
    observed = inspect_amber_artifact(path, "trajectory")
    assert observed["readStatus"] in {"truncated", "unreadable"}
    assert observed["diagnostics"][0]["severity"] == "error"


def test_inspection_worker_enforces_resource_contract(tmp_path: Path) -> None:
    path = tmp_path / "periodic.nc"
    netcdf_fixture(path)
    command = [
        sys.executable,
        "-m",
        "eigengrid_chem.amber.inspection_worker",
        "trajectory",
        str(path),
    ]
    succeeded = subprocess.run(
        command + [str(512 * 1024**2), "5"], capture_output=True, text=True, check=False
    )
    assert succeeded.returncode == 0
    invalid_limit = subprocess.run(
        command + ["1", "5"], capture_output=True, text=True, check=False
    )
    assert invalid_limit.returncode != 0
    assert "limits outside" in invalid_limit.stderr


@pytest.mark.parametrize(
    "case",
    ["valid", "negative_length", "degenerate_angles", "nan_time", "infinite_time"],
)
def test_ascii_restart_cell_and_time_are_validated_like_netcdf(
    tmp_path: Path, case: str
) -> None:
    path = tmp_path / "periodic.rst7"
    cell = (
        [-1, 20, 30, 90, 90, 90]
        if case == "negative_length"
        else [10, 20, 30, 170, 10, 10]
        if case == "degenerate_angles"
        else [10, 20, 30, 90, 90, 90]
    )
    time = (
        "NaN"
        if case == "nan_time"
        else "Inf"
        if case == "infinite_time"
        else "0.0050000"
    )
    path.write_text(
        "Independent format fixture\n3 "
        + time
        + "\n"
        + " ".join(str(value) for value in [1, 2, 3, 4, 5, 6, 7, 8, 9, *cell])
        + "\n",
        encoding="ascii",
    )
    observed = inspect_amber_artifact(path, "restart")
    if case == "valid":
        assert observed["finiteValues"] is True
        assert observed["cell"]["status"] == "complete"
        assert observed["time"]["firstPs"] == 0.005
        assert observed["diagnostics"] == []
    else:
        assert observed["finiteValues"] is False
        assert any(item["severity"] == "error" for item in observed["diagnostics"])
        if case.endswith("time"):
            assert observed["time"]["status"] == "non_finite"
        else:
            assert observed["cell"]["status"] == "malformed"


@pytest.mark.parametrize(
    "case", ["payload_text", "header_extra", "empty_box", "nan_box", "negative_box"]
)
def test_rejects_ignored_ascii_text_and_invalid_prmtop_boxes(
    tmp_path: Path, case: str
) -> None:
    path = tmp_path / "invalid-amber.txt"
    if case in {"payload_text", "header_extra"}:
        header = "3 0.0 extra" if case == "header_extra" else "3 0.0"
        payload = (
            "1 2 BAD 3 4 5 6 7 8 9" if case == "payload_text" else "1 2 3 4 5 6 7 8 9"
        )
        path.write_text("Fixture\n" + header + "\n" + payload + "\n", encoding="ascii")
        observed = inspect_amber_artifact(path, "restart")
    else:
        source = (
            Path(__file__).resolve().parents[2]
            / "tests/fixtures/amber/water.prmtop"
        )
        box = (
            []
            if case == "empty_box"
            else [90, float("nan"), 20, 30]
            if case == "nan_box"
            else [90, -1, 20, 30]
        )
        path.write_text(
            source.read_text(encoding="ascii")
            + "%FLAG BOX_DIMENSIONS\n%FORMAT(5E16.8)\n"
            + "".join(f"{value:16.8E}" for value in box)
            + "\n",
            encoding="ascii",
        )
        observed = inspect_amber_artifact(path, "prmtop")
    assert observed["readStatus"] == "unreadable"
    assert observed["diagnostics"][0]["severity"] == "error"
