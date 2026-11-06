"""Optional gas-phase GIAO shielding regression for two fixed, symmetric molecules."""

from math import sqrt

import numpy as np
from pyscf import dft, gto, lib
from pyscf.prop.nmr import rks


def isotropic_by_element(atoms):
    mol = gto.M(
        atom=atoms, unit="Angstrom", basis="cc-pvdz", charge=0, spin=0, verbose=0
    )
    mf = dft.RKS(mol)
    mf.xc = "PBE"
    mf.grids.level = 3
    mf.conv_tol = 1e-11
    mf.kernel()
    if not mf.converged:
        raise RuntimeError("SCF did not converge")
    response = rks.NMR(mf)
    response.gauge_orig = None  # GIAO
    tensors = np.asarray(response.kernel())
    if tensors.shape != (len(atoms), 3, 3) or not np.isfinite(tensors).all():
        raise ValueError(
            "Expected one finite Cartesian shielding tensor per real nucleus"
        )
    isotropic = np.trace(tensors, axis1=1, axis2=2) / 3
    means = {}
    for element in ("H", "C"):
        group = [
            isotropic[i] for i, (symbol, _) in enumerate(atoms) if symbol == element
        ]
        # All sites of each element in these two particular molecules are equivalent.
        if np.ptp(group) > 0.005:
            raise ValueError(
                f"Symmetry-equivalent {element} sites differ by more than 0.005 ppm"
            )
        means[element] = np.mean(group)
    return means


def main():
    lib.num_threads(2)
    a = 1.09 / sqrt(3)
    methane = [("C", (0, 0, 0))] + [
        ("H", (a * x, a * y, a * z))
        for x, y, z in [(1, 1, 1), (-1, -1, 1), (1, -1, -1), (-1, 1, -1)]
    ]
    ethene = [("C", (-0.67, 0, 0)), ("C", (0.67, 0, 0))] + [
        ("H", (x * 1.215, y * 1.09 * sqrt(3) / 2, 0)) for x in (-1, 1) for y in (-1, 1)
    ]
    reference = isotropic_by_element(methane)
    target = isotropic_by_element(ethene)
    for element, expected in [("H", 5.846910), ("C", 130.507547)]:
        difference = reference[element] - target[element]
        print(
            f"{element}: methane {reference[element]:.6f}, ethene {target[element]:.6f}, "
            f"methane-referenced first-order difference {difference:.6f} ppm"
        )
        if abs(difference - expected) > 0.01:
            raise ValueError(
                f"{element} difference outside the pinned numerical regression window"
            )


if __name__ == "__main__":
    main()
