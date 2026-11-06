"""Optional GIAO/NICS rotation, mirror and integration-grid controls for planar benzene."""

import json
from math import cos, pi, sin

import numpy as np
from pyscf import dft, gto, lib
from pyscf.prop.nmr import rks

HEIGHTS = (-1.0, 0.0, 1.0)  # angstrom


def scan(rotation, level):
    nuclei = []
    for element, radius in (("C", 1.39), ("H", 2.48)):
        for index in range(6):
            angle = index * pi / 3
            position = rotation @ [radius * cos(angle), radius * sin(angle), 0.0]
            nuclei.append((element, position))
    normal = rotation[:, 2]
    probes = [("X", height * normal) for height in HEIGHTS]
    settings = {
        "basis": {"C": "def2-SVP", "H": "def2-SVP"},
        "unit": "Angstrom",
        "charge": 0,
        "spin": 0,
        "verbose": 0,
        "max_memory": 1500,
    }
    physical = gto.M(atom=nuclei, **settings)
    # X identifies the observation point for the shielding integrals. The orbital
    # functions and the DFT quadrature belong to the real atoms only in this backend.
    mol = gto.M(atom=nuclei + probes, **settings)
    if mol.nelectron != 42 or mol.nao != physical.nao or mol.nbas != physical.nbas:
        raise ValueError("Probe construction changed the physical model")
    grid = dft.gen_grid.Grids(physical)
    grid.level = level
    grid.build(with_non0tab=True)
    mf = dft.RKS(mol)
    mf.xc = "PBE"
    mf.grids = grid
    mf.conv_tol = 1e-10
    mf.kernel()
    if not mf.converged:
        raise RuntimeError("SCF did not converge")
    response = rks.NMR(mf)
    response.gauge_orig = None  # GIAO
    response.shielding_nuc = range(len(nuclei), mol.natm)
    tensors = np.asarray(response.kernel())
    if tensors.shape != (len(probes), 3, 3) or not np.isfinite(tensors).all():
        raise ValueError("Missing or invalid probe shielding tensor")
    iso = -np.trace(tensors, axis1=1, axis2=2) / 3
    perpendicular = -np.einsum("i,pij,j->p", normal, tensors, normal)
    print(
        json.dumps(
            {
                "grid_level": level,
                "energy_Eh": mf.e_tot,
                "normal": normal.tolist(),
                "heights_A": HEIGHTS,
                "shielding_tensors_ppm": tensors.tolist(),
                "nics_iso_ppm": iso.tolist(),
                "nics_perp_ppm": perpendicular.tolist(),
            }
        )
    )
    return np.column_stack((iso, perpendicular)), mf.e_tot


def main():
    lib.num_threads(1)
    rotation = np.array([[0.6, 0.0, 0.8], [0.0, 1.0, 0.0], [-0.8, 0.0, 0.6]])
    base, energy = scan(np.eye(3), 3)
    tilted, rotated_energy = scan(rotation, 3)
    fine, _ = scan(np.eye(3), 4)
    for profile in (base, tilted, fine):
        if np.max(abs(profile[0] - profile[-1])) > 0.10:
            raise ValueError("Mirror-equivalent probes differ by over 0.10 ppm")
    if abs(energy - rotated_energy) > 1e-4:
        raise ValueError("Rigid rotation changed the SCF energy by more than 0.0001 Eh")
    for other in (tilted, fine):
        if np.max(abs(base - other)) > 0.20:
            raise ValueError(
                "Rigid rotation or grid refinement changes a profile by over 0.20 ppm"
            )
    # Same-build regression values, independent of the physical accuracy of the model.
    expected = [[-10.74099, -28.62033], [-8.37490, -12.38757], [-10.74099, -28.62033]]
    if not np.allclose(base, expected, atol=0.02, rtol=0):
        raise ValueError(
            "Baseline NICS differs from the recorded calculation by over 0.02 ppm"
        )


if __name__ == "__main__":
    main()
