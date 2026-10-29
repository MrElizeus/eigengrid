"""Tests for CP2K parser."""

import json

from eigengrid_chem.parsers.cp2k import parse_cp2k


def test_parse_success(tmp_path):
    log = tmp_path / "cp2k_success.out"
    log.write_text(
        "  PROGRAM STARTED AT   2024-06-21 12:00:00\n"
        "  QS| Number of spin channels:                       1\n"
        "  DFT| Functional: PBE\n"
        "  BASIS_SET| Basis set: DZVP-MOLOPT-SR-GTH\n"
        "  ENERGY| Total FORCE_EVAL (QMMM) energy [Hartree] :             -76.37045664535500\n"
        "  SCF run converged\n"
        "  PROGRAM ENDED AT   2024-06-21 12:00:15\n"
    )
    result = parse_cp2k(str(log))
    assert result["ok"] is True
    assert result["parser"] == "cp2k"
    assert result["status"] == "completed"
    assert result["data"]["normal_termination"] is True
    assert result["data"]["scf_converged"] is True
    assert result["data"]["energy_hartree"] == -76.37045664535500
    assert result["data"]["method"] == "RKS-PBE"
    assert result["data"]["basis"] == "DZVP-MOLOPT-SR-GTH"
    assert result["data"]["wall_time_seconds"] == 15.0
    assert result["data"]["cpu_time_seconds"] == 15.0


def test_parse_scf_not_converged(tmp_path):
    log = tmp_path / "cp2k_scf_fail.out"
    log.write_text(
        "  PROGRAM STARTED AT   2024-06-21 12:00:00\n"
        "  ENERGY| Total FORCE_EVAL (QMMM) energy [Hartree] :             -76.37045664535500\n"
        "  SCF run NOT converged\n"
        "  PROGRAM ENDED AT   2024-06-21 12:00:15\n"
    )
    result = parse_cp2k(str(log))
    assert result["ok"] is True
    assert result["status"] == "completed"
    assert result["data"]["normal_termination"] is True
    assert result["data"]["scf_converged"] is False
    assert "SCF did not converge" in result["data"]["errors"]


def test_parse_no_energy(tmp_path):
    log = tmp_path / "cp2k_no_energy.out"
    log.write_text(
        "  PROGRAM STARTED AT   2024-06-21 12:00:00\n"
        "  SCF run converged\n"
        "  PROGRAM ENDED AT   2024-06-21 12:00:15\n"
    )
    result = parse_cp2k(str(log))
    assert result["ok"] is True
    assert result["status"] == "completed"
    assert result["data"]["energy_hartree"] is None


def test_parse_file_not_found():
    result = parse_cp2k("/nonexistent/path.out")
    assert result["ok"] is False
    assert result["error"]["code"] == "FILE_NOT_FOUND"


def test_parse_uks_method(tmp_path):
    log = tmp_path / "cp2k_uks.out"
    log.write_text(
        "  PROGRAM STARTED AT   2024-06-21 12:00:00\n"
        "  QS| Number of spin channels:                       2\n"
        "  DFT| Functional: BLYP\n"
        "  ENERGY| Total FORCE_EVAL (QMMM) energy [Hartree] :             -76.37045664535500\n"
        "  SCF run converged\n"
        "  PROGRAM ENDED AT   2024-06-21 12:00:15\n"
    )
    result = parse_cp2k(str(log))
    assert result["data"]["method"] == "UKS-BLYP"


def test_parse_ukatomal_termination(tmp_path):
    log = tmp_path / "cp2k_abort.out"
    log.write_text("  PROGRAM STOPPED\n")
    result = parse_cp2k(str(log))
    assert result["status"] == "failed"
    assert result["data"]["normal_termination"] is False


def test_json_output_shape(tmp_path):
    log = tmp_path / "test.out"
    log.write_text(
        "  PROGRAM STARTED AT   2024-06-21 12:00:00\n"
        "  ENERGY| Total FORCE_EVAL (QMMM) energy [Hartree] :             -76.37045664535500\n"
        "  SCF run converged\n"
        "  PROGRAM ENDED AT   2024-06-21 12:00:15\n"
    )
    result = parse_cp2k(str(log))
    serialized = json.dumps(result)
    parsed = json.loads(serialized)
    assert "ok" in parsed
    assert "parser" in parsed
    assert "status" in parsed
