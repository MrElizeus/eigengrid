# Planar benzene pilot

The optional [PySCF reproducer](../../../../examples/magnetic-response/nics_pilot.py)
calculates the full Cartesian GIAO shielding tensors at heights −1, 0 and +1 Å.
It performs three single-point calculations. Each emits one JSON record containing
the shielding matrices, normal, heights, energy and both projections.

## Physical setup

The gas-phase neutral closed-shell ring lies initially in the xy plane. Six carbon
atoms form a regular hexagon of radius 1.39 Å and the six hydrogens sit radially
at 2.48 Å. The test uses PySCF 2.11.0, restricted PBE, def2-SVP, SCF tolerance
of 1e−10 Eh and the unmodified [magnetic response extension at commit 4eee5a4](https://github.com/pyscf/properties/tree/4eee5a430fb47eca5962f36fdcaf75c2b87e7ede).
For PBE this extension solves the orbital response with its pure-functional
equations. It evaluates the shielding integrals at three zero-charge X positions.
The orbital basis and quadrature grid are built on the real atoms only. The Python
script checks that adding the probe labels preserves the electron and orbital counts.
A missing basis warning for X is expected in this specific construction.
ORCA uses a different documented probe representation.

## Observed numerical checks

| Height (Å) | NICSiso (ppm) | NICS⊥ (ppm) | Tilted NICS⊥ (ppm) | Tilted laboratory −σzz (ppm) |
| ---: | ---: | ---: | ---: | ---: |
| −1 | −10.74099 | −28.62033 | −28.62005 | −11.45566 |
| 0 | −8.37490 | −12.38757 | −12.38750 | −8.53611 |
| +1 | −10.74099 | −28.62033 | −28.62005 | −11.45566 |

The reported baseline uses grid level 3. A second run rotates nuclei and probes
together to give the unit normal (0.8, 0, 0.6). The largest change in a projected
or isotropic value was 0.00076 ppm (rounded up), and the change in total energy
was 0.0000021 Eh (rounded up). A third calculation refines the grid to level 4 in
the original orientation. The largest observed change in either profile was
0.00079 ppm (rounded up). The +1 and −1 Å values agreed within 0.000001 ppm in
all three calculations. The example enforces separate regression, rotation,
quadrature and mirror tolerances.

The fixed geometry and finite basis define a local numerical control. Establish
accuracy against a matched independent reference before transferring the protocol
to a scientific claim or another electronic-structure engine.
