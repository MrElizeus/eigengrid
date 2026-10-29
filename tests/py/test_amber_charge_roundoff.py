from decimal import Decimal

import pytest
from eigengrid_chem.amber.charges import normalize_partial_charge_roundoff


def test_actual_methane_quantization_is_corrected_without_changing_atom_order():
    raw = ["-0.108800", "0.026700", "0.026700", "0.026700", "0.026700"]
    result = normalize_partial_charge_roundoff(
        raw, formal_charge=0, maximum_offset_per_atom="0.0005"
    )
    assert result["offsetPerAtomE"] == "0.000400"
    assert Decimal(result["normalizedTotalE"]) == 0
    assert [Decimal(q) for q in result["normalizedCharges"]] == [Decimal("-0.1084")] + [
        Decimal("0.0271")
    ] * 4
    assert raw == result["sourceCharges"]


def test_exact_charges_are_unchanged():
    result = normalize_partial_charge_roundoff(
        ["-0.4", "0.2", "0.2"], formal_charge=0, maximum_offset_per_atom="0"
    )
    assert Decimal(result["offsetPerAtomE"]) == 0
    assert result["normalizedCharges"] == ["-0.4", "0.2", "0.2"]


def test_charge_state_cannot_be_changed_by_normalization():
    with pytest.raises(ValueError, match="exceeds"):
        normalize_partial_charge_roundoff(
            ["0", "0", "0"], formal_charge=1, maximum_offset_per_atom="0.0005"
        )


@pytest.mark.parametrize(
    "charges,bound",
    [
        ([], "0.0005"),
        (["nan"], "0.0005"),
        (["Infinity"], "0.0005"),
        (["bad"], "0.0005"),
        (["0"], "nan"),
        (["0"], "0.001"),
        (["0"], "-0.0001"),
        (["0.002"], "0.0005"),
    ],
)
def test_unknown_or_excessive_corrections_fail_closed(charges, bound):
    with pytest.raises(ValueError):
        normalize_partial_charge_roundoff(
            charges, formal_charge=0, maximum_offset_per_atom=bound
        )
