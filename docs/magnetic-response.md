# Molecular magnetic response

Choose the protocol by the observable and by the artifacts available. All three
entries are planning drafts at version `1.0.0`. Each carries its own model,
reference papers, failure conditions and acceptance checks.

| Scientific question                                                     | Required evidence                                                                                                                                             | Result the operator may propose                                                                                                              |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Which solution NMR peaks support a candidate structure?                 | Atom-mapped nuclear shielding tensors, a matched reference or calibration for each isotope, exchange regime, conformer weights and measured peak assignments. | `workflows.nmr-chemical-shifts` reports shifts in ppm. When the spectrum cannot discriminate candidates, retain the ambiguity.               |
| How does the magnetic response vary above a ring or across fused rings? | Probe coordinates in a reproducible ring frame, total Cartesian shielding tensors in known axes, gauge and probe construction.                                | `workflows.nics-tensor-scans` reports isotropic and normal-projected NICS profiles in ppm. A single value cannot identify a current pathway. |
| How strong is the current through a chosen cut?                         | Matched AO basis/geometry and response matrices, field vector and oriented surface, quadrature, area and an independent reference for the chosen setup.       | `workflows.gimic-ring-currents` reports the signed flux per unit field in nA/T. Compare several cuts to interpret the circulation.           |

In the operator, search for the question in English or Spanish, then inspect the
returned ID at its exact version. The default inspection includes the procedure
and decision gates. Request `assetKinds: ["references", "validation"]` for source-specific evidence
and numerical replay notes. Follow pagination with the returned corpus digest.
For an external installation verify that this digest and the resolved modules
match the site's selected catalog.

## Local numerical pilots

The numbers below identify the particular inputs and software in this contribution.
They establish reproducible examples of postprocessing and numerical behavior.
Their tolerances are specific to those checks.

| Pilot                                                        | Observed result                                                                                                                                                  | What it tests                                                                                                                                 |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Methane and ethene nuclear shieldings, gas-phase PBE/cc-pVDZ | Ethene relative to methane, H **+5.846910 ppm**, C **+130.507547 ppm**                                                                                           | Isotropic trace, within-molecule equivalence, isotope-matched referencing and sign. Methane defines a local comparison scale.                 |
| Planar benzene, PBE/def2-SVP, probe 1 Å from the ring        | NICS along the ring normal **−28.62033 ppm**. After rotation it is **−28.62005 ppm**, while the raw output-axis value is **−11.45566 ppm**.                      | Compares both ring faces, two molecular orientations and two quadrature levels. The sign is applied after projection into the physical frame. |
| Pinned upstream GIMIC integrals                              | Benzene **+11.802134 nA/T**, cyclobutadiene **−19.966416 nA/T** in their respective fixture orientations. Reversing the benzene field gives **−11.802134 nA/T**. | Tests the downstream integrator with supplied densities, including mesh size, integration area, field sign and a missing-density failure.     |

### Reproduce the two shielding pilots

From the source checkout on Linux x86-64, use a separate Python environment.
The recorded runs used Python 3.12.14, PySCF 2.11.0, NumPy 2.3.5, SciPy 1.17.0
and h5py 3.16.0. The properties extension revision is significant. Use the
following setup once, with Git available.

```bash
python3.12 -m venv .venv
.venv/bin/python -m pip install 'numpy==2.3.5' 'scipy==1.17.0' 'h5py==3.16.0' \
  'pyscf==2.11.0' 'pyscf-properties @ git+https://github.com/pyscf/properties.git@4eee5a430fb47eca5962f36fdcaf75c2b87e7ede'
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=2 .venv/bin/python examples/magnetic-response/nmr_pilot.py
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 .venv/bin/python examples/magnetic-response/nics_pilot.py
```

The scripts contain the full geometries, model, observables and regression checks.
The NICS pilot constructs probes without orbital functions and builds quadrature on
the physical nuclei in PySCF. ORCA 6.1 documents a different probe construction
using a ghost center and tight basis functions. Follow the specific engine mapping.
[PySCF response implementation](https://github.com/pyscf/properties/tree/4eee5a430fb47eca5962f36fdcaf75c2b87e7ede/pyscf/prop/nmr) · [ORCA 6.1 magnetic response](https://www.faccts.de/docs/orca/6.1/manual/contents/spectroscopyproperties/nmr.html)

### Reproduce GIMIC and qualify a cluster route

The [GIMIC replay record](../scientific-skills/workflows/gimic-ring-currents/references/fixture-replay.md)
gives the upstream commit, input hashes, commands, signed components and sensitivity
results. A wider cut changed the benzene result even after refining the original
mesh had barely changed it. Retain both tests.

For a new site, stage a bounded job through the existing
`workflows.dft-cluster-preflight`. In the intended batch allocation verify the
producer, converter and GIMIC builds, and a durable staging path. Bind each
producer output to its atom order, basis ordering, coordinate axes and digest.
Qualify a newly generated response file against a matched independent comparison
before promoting that particular bridge. An ORCA shielding result or a successful
replay of upstream GIMIC inputs cannot establish an ORCA-to-GIMIC route.

## Operator acceptance cases

- A user supplies shieldings but omits the reference and exchange regime. Report
  the available shieldings and request the missing conditions before assigning solution peaks.
- A rotated-ring job contains only sorted principal values without axes. Withhold
  the ring-normal component until a reconstructible tensor in known axes is available.
- A GIMIC job reports scheduler success and no integral. Mark the observable
  missing, preserve the backend log and inspect the response files. Never record zero
  for a failed integral.
- Net current across the shared bond of naphthalene vanishes. Inspect the perimeter
  and other cuts before drawing a conclusion about circulation. The primary study
  compares these routes for naphthalene and related fused systems.
  [Current pathways in fused rings](https://doi.org/10.1039/D1CP02381K)
