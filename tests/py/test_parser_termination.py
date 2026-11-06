"""Terminal evidence must belong to the last calculation in an output file."""

import pytest
from eigengrid_chem.parsers.cp2k import parse_cp2k
from eigengrid_chem.parsers.gaussian import parse_gaussian
from eigengrid_chem.parsers.orca import parse_orca


@pytest.fixture(
    params=[
        (
            parse_gaussian,
            "Entering Gaussian System",
            "Normal termination of Gaussian 16.",
            "Error termination via Lnk1e",
            "SCF Done: E(RHF) = -1.234 A.U.",
        ),
        (
            parse_orca,
            "* O R C A *",
            "****ORCA TERMINATED NORMALLY****",
            "ORCA TERMINATED WITH ERRORS",
            "FINAL SINGLE POINT ENERGY -1.234",
        ),
        (
            parse_cp2k,
            "PROGRAM STARTED AT 2026-11-06 12:00:00",
            "PROGRAM ENDED AT 2026-11-06 12:00:01",
            "PROGRAM STOPPED",
            "ENERGY| Total FORCE_EVAL (QMMM) energy [Hartree] : -1.234",
        ),
    ]
)
def engine(request):
    return request.param


def parse(tmp_path, engine, lines):
    path = tmp_path / "output.log"
    path.write_text("\n".join(lines) + "\n")
    return engine[0](str(path))


def test_energy_without_termination_is_partial(tmp_path, engine):
    result = parse(tmp_path, engine, [engine[1], engine[4]])
    assert result["status"] == "partial"
    assert result["data"]["normal_termination"] is False
    assert result["data"]["energy_hartree"] == -1.234


def test_later_error_overrides_previous_normal_termination(tmp_path, engine):
    result = parse(tmp_path, engine, [engine[1], engine[4], engine[2], engine[3]])
    assert result["status"] == "failed"
    assert result["data"]["normal_termination"] is False
    assert result["data"]["errors"]


def test_incomplete_restart_does_not_inherit_success_or_energy(tmp_path, engine):
    result = parse(tmp_path, engine, [engine[1], engine[4], engine[2], engine[1]])
    assert result["status"] == "partial"
    assert result["data"]["normal_termination"] is False
    assert result["data"]["energy_hartree"] is None


def test_successful_restart_does_not_inherit_previous_failure(tmp_path, engine):
    result = parse(tmp_path, engine, [engine[1], engine[3], engine[1], engine[4], engine[2]])
    assert result["status"] == "completed"
    assert result["data"]["normal_termination"] is True
    assert result["data"]["errors"] == []


def test_gaussian_incomplete_link1_is_partial(tmp_path):
    result = parse(
        tmp_path,
        (parse_gaussian,),
        [
            "SCF Done: E(RHF) = -1.234 A.U.",
            "Normal termination of Gaussian 16.",
            "--Link1--",
        ],
    )
    assert result["status"] == "partial"
    assert result["data"]["normal_termination"] is False
    assert result["data"]["energy_hartree"] is None
