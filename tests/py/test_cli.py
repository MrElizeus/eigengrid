"""Tests for Python CLI entry point."""

import json
import subprocess
import sys


def test_cli_help():
    result = subprocess.run(
        [sys.executable, "-m", "eigengrid_chem", "--help"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0
    assert "usage:" in result.stdout.lower()


def test_cli_version():
    result = subprocess.run(
        [sys.executable, "-m", "eigengrid_chem", "--version"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0
    assert "eigengrid-chem" in result.stdout


def test_cli_parse_json_output(tmp_path):
    log = tmp_path / "test.log"
    log.write_text(
        "Normal termination of Gaussian job\nSCF Done:  E(RB3LYP) =  -1156.78392432\n"
    )
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "eigengrid_chem",
            "parse",
            "gaussian",
            str(log),
            "--json",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0
    parsed = json.loads(result.stdout)
    assert parsed["ok"] is True
    assert parsed["parser"] == "gaussian"


def test_cli_generate_returns_structured_deferred_feature_error():
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "eigengrid_chem",
            "generate",
            "orca-opt",
            "--params",
            "{}",
            "--json",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0
    parsed = json.loads(result.stdout)
    assert parsed == {
        "ok": False,
        "error": {
            "code": "FEATURE_UNAVAILABLE",
            "message": "Input generator 'orca-opt' is not implemented in this release",
            "hint": "Use a registered recipe command; chemistry input generators are deferred.",
        },
    }


def test_cli_conformers_validates_count_before_feature_gate():
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "eigengrid_chem",
            "conformers",
            "CCO",
            "0",
            "--json",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0
    parsed = json.loads(result.stdout)
    assert parsed["ok"] is False
    assert parsed["error"]["code"] == "INVALID_COUNT"
