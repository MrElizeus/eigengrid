"""Tests for Gaussian parser."""

import json

from eigengrid_chem.parsers.gaussian import parse_gaussian


def test_parse_success(tmp_path):
    log = tmp_path / "gaussian_success.log"
    log.write_text(
        "Normal termination of Gaussian job\n"
        "SCF Done:  E(RB3LYP) =  -1156.78392432     A.U. after    9 cycles\n"
    )
    result = parse_gaussian(str(log))
    assert result["ok"] is True
    assert result["parser"] == "gaussian"
    assert result["status"] == "completed"
    assert result["data"]["normal_termination"] is True
    assert result["data"]["energy_hartree"] == -1156.78392432


def test_parse_scf_not_converged(tmp_path):
    log = tmp_path / "gaussian_error.log"
    log.write_text("Error termination\nSCF not converged after 128 cycles\n")
    result = parse_gaussian(str(log))
    assert result["ok"] is True
    assert result["status"] == "failed"
    assert result["data"]["normal_termination"] is False
    assert result["data"]["energy_hartree"] is None


def test_parse_file_not_found():
    result = parse_gaussian("/nonexistent/path.log")
    assert result["ok"] is False
    assert result["error"]["code"] == "FILE_NOT_FOUND"


def test_json_output_shape(tmp_path):
    log = tmp_path / "test.log"
    log.write_text("Normal termination of Gaussian job\n")
    result = parse_gaussian(str(log))
    serialized = json.dumps(result)
    parsed = json.loads(serialized)
    assert "ok" in parsed
    assert "parser" in parsed
    assert "status" in parsed
