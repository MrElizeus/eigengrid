from time import perf_counter

from eigengrid_chem.parsers.orca import parse_orca


def test_orca_parser_records_explicit_geometry_convergence(tmp_path):
    output = tmp_path / "optimization.out"
    output.write_text(
        "**** CONVERGENCE REACHED ****\n"
        "THE OPTIMIZATION HAS CONVERGED\n"
        "****ORCA TERMINATED NORMALLY****\n",
        encoding="utf-8",
    )

    parsed = parse_orca(str(output))

    assert parsed["ok"] is True
    assert parsed["data"]["raw"]["geometryConverged"] is True


def test_orca_parser_reads_native_final_energy_line(tmp_path):
    output = tmp_path / "single-point.out"
    output.write_text(
        "FINAL SINGLE POINT ENERGY       -75.962734123456\n"
        "****ORCA TERMINATED NORMALLY****\n",
        encoding="utf-8",
    )

    parsed = parse_orca(str(output))

    assert parsed["ok"] is True
    assert parsed["status"] == "completed"
    assert parsed["data"]["energy_hartree"] == -75.962734123456


def test_orca_parser_reads_native_scf_convergence_banner(tmp_path):
    output = tmp_path / "scf-converged.out"
    output.write_text(
        "*           SCF CONVERGED AFTER   8 CYCLES          *\n"
        "FINAL SINGLE POINT ENERGY       -74.962946656649\n"
        "****ORCA TERMINATED NORMALLY****\n",
        encoding="utf-8",
    )

    parsed = parse_orca(str(output))

    assert parsed["data"]["scf_converged"] is True


def test_orca_parser_ignores_scf_convergence_text_echoed_from_input(tmp_path):
    output = tmp_path / "scf-input-echo.out"
    output.write_text(
        "| 1> # SCF CONVERGED AFTER 8 CYCLES\n",
        encoding="utf-8",
    )

    parsed = parse_orca(str(output))

    assert parsed["data"]["scf_converged"] is False


def test_orca_parser_rejects_multiline_fragmented_scf_banners(tmp_path):
    output = tmp_path / "scf-fragmented.out"
    output.write_text(
        "****\nCONVERGENCE\nREACHED\n****\n*\nSCF\nCONVERGED\nAFTER\n8\nCYCLES\n*\n",
        encoding="utf-8",
    )

    parsed = parse_orca(str(output))

    assert parsed["data"]["scf_converged"] is False


def test_orca_parser_ignores_failure_text_echoed_from_input(tmp_path):
    output = tmp_path / "scf-failure-echo.out"
    output.write_text(
        "*           SCF CONVERGED AFTER   8 CYCLES          *\n"
        "| 1> # SCF DID NOT CONVERGE\n",
        encoding="utf-8",
    )

    parsed = parse_orca(str(output))

    assert parsed["data"]["scf_converged"] is True


def test_orca_parser_handles_line_heavy_output_in_linear_time(tmp_path):
    output = tmp_path / "line-heavy.out"
    output.write_text("\n" * 32_000, encoding="utf-8")

    started = perf_counter()
    parsed = parse_orca(str(output))
    elapsed = perf_counter() - started

    assert parsed["data"]["scf_converged"] is False
    assert elapsed < 1.0


def test_orca_parser_explicit_scf_failure_overrides_success_text(tmp_path):
    output = tmp_path / "scf-failed.out"
    output.write_text(
        "*           SCF CONVERGED AFTER   8 CYCLES          *\nSCF DID NOT CONVERGE\n",
        encoding="utf-8",
    )

    parsed = parse_orca(str(output))

    assert parsed["data"]["scf_converged"] is False


def test_orca_parser_native_not_converged_banner_overrides_success(tmp_path):
    output = tmp_path / "scf-not-converged.out"
    output.write_text(
        "*           SCF CONVERGED AFTER   8 CYCLES          *\n"
        "SCF NOT CONVERGED AFTER 50 CYCLES\n",
        encoding="utf-8",
    )

    parsed = parse_orca(str(output))

    assert parsed["data"]["scf_converged"] is False


def test_orca_parser_uses_last_iterative_energy_and_geometry(tmp_path):
    output = tmp_path / "optimization-steps.out"
    output.write_text(
        "FINAL SINGLE POINT ENERGY       -75.000000000000\n"
        "CARTESIAN COORDINATES (ANGSTROEM)\n"
        "---------------------------------\n"
        "O  0.000000  0.000000  0.100000\n"
        "H  0.700000  0.000000 -0.400000\n"
        "\n"
        "FINAL SINGLE POINT ENERGY       -76.123456789012\n"
        "CARTESIAN COORDINATES (ANGSTROEM)\n"
        "---------------------------------\n"
        "O  0.000000  0.000000  0.200000\n"
        "H  0.800000  0.000000 -0.500000\n"
        "\n"
        "THE OPTIMIZATION HAS CONVERGED\n"
        "****ORCA TERMINATED NORMALLY****\n",
        encoding="utf-8",
    )

    parsed = parse_orca(str(output))

    assert parsed["data"]["energy_hartree"] == -76.123456789012
    assert parsed["data"]["geometry"] == [
        {"element": "O", "x": 0.0, "y": 0.0, "z": 0.2},
        {"element": "H", "x": 0.8, "y": 0.0, "z": -0.5},
    ]
