import hashlib
import json
import struct
import subprocess
import sys
from pathlib import Path

import pytest
from eigengrid_chem.amber.inspection import (
    AMBER_BYTE_INSPECTION_SCHEMA_VERSION,
    AMBER_MINIMIZATION_PARSE_SCHEMA_VERSION,
    AmberInspectionError,
    inspect_amber_artifact,
    parse_amber_minimization_mdout,
)

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
SMOKE = REPOSITORY_ROOT / "tests" / "fixtures" / "amber"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(8192):
            digest.update(chunk)
    return digest.hexdigest()


def diagnostics(value: dict) -> set[str]:
    return {item["code"] for item in value["diagnostics"]}


def copy_with_float_replaced(
    source: Path, target: Path, before: float, after: bytes
) -> None:
    payload = bytearray(source.read_bytes())
    needle = struct.pack(">f", before)
    offset = payload.find(needle)
    assert offset >= 0, f"fixture does not contain {before}"
    payload[offset : offset + len(needle)] = after
    target.write_bytes(payload)


def copy_with_bytes_replaced(
    source: Path, target: Path, before: bytes, after: bytes
) -> None:
    payload = bytearray(source.read_bytes())
    offset = payload.find(before)
    assert offset >= 0, f"fixture does not contain {before.hex()}"
    payload[offset : offset + len(before)] = after
    target.write_bytes(payload)


def test_decodes_real_amber26_classic_netcdf_trajectory_from_bytes() -> None:
    trajectory = SMOKE / "md.nc"

    observed = inspect_amber_artifact(trajectory, "trajectory")

    assert observed["schemaVersion"] == AMBER_BYTE_INSPECTION_SCHEMA_VERSION
    assert observed["observedContentDigest"] == sha256(trajectory)
    assert observed["byteLength"] == trajectory.stat().st_size
    assert observed["format"] == "amber_netcdf"
    assert observed["inspectionLevel"] == "decoded"
    assert observed["readStatus"] == "complete"
    assert observed["convention"] == "AMBER"
    assert observed["atomCount"] == 3
    assert observed["frameCount"] == 5
    assert observed["dimensions"] == {"frame": 5, "spatial": 3, "atom": 3}
    assert observed["hasPeriodicBox"] is False
    assert observed["finiteValues"] is True
    assert observed["time"]["status"] == "strictly_increasing"
    assert observed["time"]["cadenceStatus"] == "uniform"
    assert observed["time"]["count"] == 5
    assert observed["time"]["precisionPs"] > 0
    assert observed["diagnostics"] == []


def test_decodes_real_amber26_netcdf_restart_ascii_restart_and_prmtop() -> None:
    netcdf_restart = SMOKE / "md.rst7"
    ascii_restart = SMOKE / "water.inpcrd"
    topology = SMOKE / "water.prmtop"

    restart = inspect_amber_artifact(netcdf_restart, "restart")
    assert restart["observedContentDigest"] == sha256(netcdf_restart)
    assert restart["format"] == "amber_netcdf"
    assert restart["convention"] == "AMBERRESTART"
    assert restart["atomCount"] == 3
    assert restart["frameCount"] == 1
    assert restart["finiteValues"] is True
    assert restart["time"]["status"] == "single_frame"

    formatted = inspect_amber_artifact(ascii_restart, "restart")
    assert formatted["observedContentDigest"] == sha256(ascii_restart)
    assert formatted["format"] == "amber_ascii_restart"
    assert formatted["atomCount"] == 3
    assert formatted["frameCount"] == 1
    assert formatted["time"]["status"] == "missing"

    prmtop = inspect_amber_artifact(topology, "prmtop")
    assert prmtop["observedContentDigest"] == sha256(topology)
    assert prmtop["format"] == "amber_prmtop"
    assert prmtop["atomCount"] == 3
    assert (
        prmtop["atomIdentityDigest"]
        == "4e97fc7985acd204d81b8552277a7b72149bdb821f1e7462ba1563c26a105681"
    )
    assert prmtop["finiteValues"] is True


def test_metadata_only_never_claims_decoded_coordinates() -> None:
    observed = inspect_amber_artifact(SMOKE / "md.nc", "trajectory", metadata_only=True)

    assert observed["inspectionLevel"] == "metadata_only"
    assert observed["readStatus"] == "complete"
    assert observed["atomCount"] is None
    assert observed["frameCount"] is None
    assert observed["finiteValues"] is None
    assert observed["dimensions"] == {}
    assert observed["time"]["status"] == "not_applicable"
    assert observed["cell"]["status"] == "not_applicable"
    assert diagnostics(observed) == {"metadata_only"}


def test_refuses_symlinks_and_nonregular_files_before_reading_bytes(tmp_path: Path) -> None:
    linked = tmp_path / "linked.nc"
    linked.symlink_to(SMOKE / "md.nc")
    with pytest.raises(AmberInspectionError, match="safe regular file") as linked_error:
        inspect_amber_artifact(linked, "trajectory")
    assert linked_error.value.code == "artifact_open_failed"

    # A directory exercises the post-open regular-file check without relying
    # on platform-specific FIFO support.
    with pytest.raises(AmberInspectionError, match="regular files") as directory_error:
        inspect_amber_artifact(tmp_path, "trajectory")
    assert directory_error.value.code == "artifact_not_regular"


def test_cli_emits_the_same_byte_derived_trajectory_observation() -> None:
    source = SMOKE / "md.nc"
    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "eigengrid_chem",
            "amber-inspect",
            "trajectory",
            str(source),
            "--json",
        ],
        capture_output=True,
        check=False,
        text=True,
    )
    assert completed.returncode == 0
    observed = json.loads(completed.stdout)
    assert observed["observedContentDigest"] == sha256(source)
    assert observed["inspectionLevel"] == "decoded"
    assert observed["frameCount"] == 5


def test_detects_truncated_netcdf_and_nonfinite_coordinates_from_mutated_bytes(
    tmp_path: Path,
) -> None:
    source = SMOKE / "md.nc"
    truncated_path = tmp_path / "truncated.nc"
    truncated_path.write_bytes(source.read_bytes()[:-8])
    truncated = inspect_amber_artifact(truncated_path, "trajectory")
    assert truncated["readStatus"] == "truncated"
    assert diagnostics(truncated) == {"truncated_artifact"}
    assert truncated["observedContentDigest"] == sha256(truncated_path)

    nonfinite_path = tmp_path / "nonfinite.nc"
    copy_with_bytes_replaced(
        source, nonfinite_path, bytes.fromhex("bb5dbf6a"), b"\x7f\xc0\x00\x00"
    )
    nonfinite = inspect_amber_artifact(nonfinite_path, "trajectory")
    assert nonfinite["readStatus"] == "complete"
    assert nonfinite["finiteValues"] is False
    assert "non_finite_coordinates" in diagnostics(nonfinite)
    assert nonfinite["observedContentDigest"] == sha256(nonfinite_path)


def test_reports_duplicate_and_irregular_time_from_actual_netcdf_format(
    tmp_path: Path,
) -> None:
    source = SMOKE / "md.nc"
    duplicate_path = tmp_path / "duplicate-time.nc"
    copy_with_float_replaced(source, duplicate_path, 0.003, struct.pack(">f", 0.002))
    duplicate = inspect_amber_artifact(duplicate_path, "trajectory")
    assert duplicate["time"]["status"] == "duplicate"
    assert "invalid_trajectory_time" in diagnostics(duplicate)

    irregular_path = tmp_path / "irregular-time.nc"
    copy_with_float_replaced(source, irregular_path, 0.003, struct.pack(">f", 0.0035))
    irregular = inspect_amber_artifact(irregular_path, "trajectory")
    assert irregular["time"]["status"] == "strictly_increasing"
    assert irregular["time"]["cadenceStatus"] == "irregular"
    assert irregular["time"]["precisionPs"] > 0
    assert "irregular_trajectory_cadence" in diagnostics(irregular)


def test_rejects_prmtop_atom_count_disagreement_and_nonfinite_ascii_restart(
    tmp_path: Path,
) -> None:
    bad_topology = tmp_path / "bad.prmtop"
    bad_topology.write_text(
        (SMOKE / "water.prmtop")
        .read_text()
        .replace("       3       2", "       4       2", 1),
        encoding="ascii",
    )
    topology = inspect_amber_artifact(bad_topology, "prmtop")
    assert topology["readStatus"] == "unreadable"
    assert "invalid_prmtop_atom_names" in diagnostics(topology)

    bad_restart = tmp_path / "nonfinite.inpcrd"
    bad_restart.write_text(
        (SMOKE / "water.inpcrd").read_text().replace("0.9570000", "nan", 1),
        encoding="ascii",
    )
    restart = inspect_amber_artifact(bad_restart, "restart")
    assert restart["readStatus"] == "complete"
    assert restart["finiteValues"] is False
    assert "non_finite_restart_value" in diagnostics(restart)
    json.dumps(restart, allow_nan=False)


def test_observes_prmtop_atom_order_without_accepting_a_caller_order(
    tmp_path: Path,
) -> None:
    source = SMOKE / "water.prmtop"
    swapped = tmp_path / "swapped-order.prmtop"
    swapped.write_text(
        source.read_text(encoding="ascii").replace("O   H1  H2", "H1  O   H2", 1),
        encoding="ascii",
    )

    original = inspect_amber_artifact(source, "prmtop")
    observed = inspect_amber_artifact(swapped, "prmtop")

    assert observed["readStatus"] == "complete"
    assert observed["atomCount"] == original["atomCount"] == 3
    assert observed["atomIdentityDigest"] != original["atomIdentityDigest"]
    assert observed["observedContentDigest"] == sha256(swapped)


def test_parses_real_minimization_rows_without_misclassifying_md_nstep_pairs() -> None:
    parsed = parse_amber_minimization_mdout(SMOKE / "min.mdout")

    assert parsed["schemaVersion"] == AMBER_MINIMIZATION_PARSE_SCHEMA_VERSION
    assert parsed["observedContentDigest"] == sha256(SMOKE / "min.mdout")
    assert parsed["status"] == "completed"
    assert parsed["terminalMarkerObserved"] is True
    assert parsed["finalResultsMarkerObserved"] is True
    assert parsed["convergenceStatus"] == "not_assessed"
    assert parsed["final"] == {
        "step": 16,
        "energyKcalMol": pytest.approx(3.0614e-11),
        "rmsGradientKcalMolAngstrom": pytest.approx(7.5114e-05),
        "gmaxKcalMolAngstrom": pytest.approx(1.3309e-04),
        "maxGradientAtomName": "O",
        "maxGradientAtomNumber": 1,
        "line": 269,
    }
    assert parsed["samples"][0]["step"] == 1
    assert parsed["samples"][-1]["step"] == 16

    md_parse = parse_amber_minimization_mdout(SMOKE / "md.mdout")
    assert md_parse["status"] == "unreadable"
    assert md_parse["samples"] == []
    assert diagnostics(md_parse) == {"missing_minimization_table"}


def test_minimization_nan_is_partial_bytes_evidence_not_convergence(
    tmp_path: Path,
) -> None:
    bad_mdout = tmp_path / "min-nan.mdout"
    bad_mdout.write_text(
        (SMOKE / "min.mdout")
        .read_text(encoding="ascii")
        .replace("3.0614E-11", "NaN", 1),
        encoding="ascii",
    )

    parsed = parse_amber_minimization_mdout(bad_mdout)

    assert parsed["status"] == "partial"
    assert parsed["convergenceStatus"] == "not_assessed"
    assert "non_finite_minimization_value" in diagnostics(parsed)
