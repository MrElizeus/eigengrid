"""Explicit, bounded correction of partial-charge rounding, never protonation.

SQM's printed Mulliken charges can have only three decimals. The caller must
bind the formal charge and allowed offset in its scientific plan. No implicit
normalization is performed by ingestion. Keep the raw and corrected artifacts.
The uniform-offset method is also documented by OpenFF's AmberTools wrapper:
https://docs.openforcefield.org/projects/toolkit/en/stable/api/generated/openff.toolkit.utils.toolkits.AmberToolsToolkitWrapper.html
"""

from decimal import Decimal, localcontext


def normalize_partial_charge_roundoff(
    charges: list[str], *, formal_charge: int, maximum_offset_per_atom: str
) -> dict:
    """Return a new ordered charge vector and an auditable correction record.

    A discrepancy larger than the explicitly allowed rounding bound is a hard
    error. The original vector is not mutated; atom identity/order is unchanged.
    This function does not decide a molecule's formal charge or chemical state.
    """
    if (
        not charges
        or len(charges) > 100_000
        or type(formal_charge) is not int
        or abs(formal_charge) > 100
        or any(not isinstance(value, str) or len(value) > 128 for value in charges)
    ):
        raise ValueError("Invalid charge inventory or formal-charge authority")
    with localcontext() as context:
        context.prec = 40
        try:
            values = [Decimal(value) for value in charges]
            bound = Decimal(maximum_offset_per_atom)
        except (ValueError, ArithmeticError, TypeError) as error:
            raise ValueError("Charges and bound must be finite decimals") from error
        if (
            not bound.is_finite()
            or not Decimal(0) <= bound <= Decimal("0.0005")
            or any(not value.is_finite() or abs(value) > 100 for value in values)
        ):
            raise ValueError("Invalid or excessive roundoff allowance")
        source_total = sum(values, Decimal(0))
        offset = (Decimal(formal_charge) - source_total) / len(values)
        if abs(offset) > bound:
            raise ValueError("Charge discrepancy exceeds the approved roundoff bound")
        corrected = [value + offset for value in values]
        output_total = sum(corrected, Decimal(0))
        if abs(output_total - Decimal(formal_charge)) > Decimal("1e-30"):
            raise ValueError("Charge normalization failed its sum invariant")
        return {
            "schema": "bounded-uniform-charge-roundoff/v1",
            "formalCharge": formal_charge,
            "sourceCharges": [str(value) for value in values],
            "sourceTotalE": str(source_total),
            "offsetPerAtomE": str(offset),
            "maximumOffsetPerAtomE": str(bound),
            "normalizedCharges": [str(value) for value in corrected],
            "normalizedTotalE": str(output_total),
        }
