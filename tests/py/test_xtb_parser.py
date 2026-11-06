"""xTB stdout and combined stdout/stderr retain independent completion evidence."""

from pathlib import Path

import pytest
from eigengrid_chem.parsers.xtb import parse_xtb

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"


def test_real_stdout_retains_energy_without_claiming_success():
    # Excerpt from computational-chemistry-docs commit 1f938d7:
    # dft/molecules/diclofenac/01_xtb/gfn2_opt_tight/xtb_opt.log, lines 148, 1657-1675.
    result = parse_xtb(str(FIXTURES / "xtb_real_excerpt.out"))
    assert result["ok"] is True
    assert result["status"] == "partial"
    assert result["data"]["normal_termination"] is False
    assert result["data"]["energy_hartree"] == -55.761717264440
    assert result["data"]["method"] == "GFN2-xTB"


def test_real_output_with_stderr_termination_is_completed(tmp_path):
    path = tmp_path / "xtb.out"
    path.write_text((FIXTURES / "xtb_real_excerpt.out").read_text() + "normal termination of xtb\n")
    result = parse_xtb(str(path))
    assert result["status"] == "completed"
    assert result["data"]["energy_hartree"] == -55.761717264440


def test_later_abnormal_termination_wins(tmp_path):
    path = tmp_path / "xtb.out"
    path.write_text(
        "TOTAL ENERGY = -1.0 Eh\nnormal termination of xtb\nabnormal termination of xtb\n"
    )
    result = parse_xtb(str(path))
    assert result["status"] == "failed"
    assert result["data"]["normal_termination"] is False
    assert result["data"]["errors"] == ["Abnormal termination of xTB"]


@pytest.mark.parametrize("energy", ["-1.25", "-1.25E+00", "-1.25D+00"])
@pytest.mark.parametrize("separator", [" ", " = "])
def test_supported_energy_formats_preserve_partial_results(tmp_path, energy, separator):
    path = tmp_path / "xtb.out"
    path.write_text(f" | TOTAL ENERGY{separator}{energy} Eh |\n")
    result = parse_xtb(str(path))
    assert result["status"] == "partial"
    assert result["data"]["energy_hartree"] == -1.25


def test_legacy_fixture_still_parses():
    result = parse_xtb(str(FIXTURES / "xtb_success.out"))
    assert result["status"] == "completed"
    assert result["data"]["energy_hartree"] == -7.26890123


def test_new_run_does_not_inherit_previous_termination(tmp_path):
    path = tmp_path / "xtb.out"
    path.write_text(
        "TOTAL ENERGY = -1.0 Eh\nnormal termination of xtb\n"
        " * started run on 2026/11/06 at 12:00:00\n"
    )
    result = parse_xtb(str(path))
    assert result["status"] == "partial"
    assert result["data"]["energy_hartree"] is None
