# Local integration replay on pinned response matrices

## Scope and identity

The serial F-GIMIC backend identified itself as GIMIC 2.2.1, Git commit `38b960c655b1538bb463a9bc6a6bdb67cab04395`. The replay used the unmodified source, GNU Fortran 13.3.0 on Linux x86-64, CMake 3.31.10 Release mode and the upstream Python driver. OpenMP, MPI and external BLAS/LAPACK were off. The inputs were upstream geometry/basis and AO response files. The benzene test matrices are byte-identical to the authors' B3LYP/def2-TZVP example. This exercises the downstream numerical integration and output handling. It leaves generation of magnetic-response matrices, converter fidelity and compute-node qualification as distinct tests. [Benchmark sources](https://github.com/qmcurrents/gimic/tree/38b960c655b1538bb463a9bc6a6bdb67cab04395/test) · [Benzene model](https://github.com/qmcurrents/gimic/blob/38b960c655b1538bb463a9bc6a6bdb67cab04395/examples/benzene/README)

## Input fingerprints

SHA-256 checksums below apply to the original files at the pinned revision. Fetch the upstream fixtures separately for a replay.

| Upstream path relative to `test/` | SHA-256 |
| --- | --- |
| `benzene/MOL` | `4306ca97891461d9f7efcf67628983e4bf3f16bd46538d039bc02b3f70aa8cc7` |
| `benzene/XDENS` | `e1e25e4517ca8bbab3d69feae6f880ad193f6cda0163c118163bc138009721a3` |
| `benzene/keyword-magnet/gimic.inp` | `9c7e1caf0a981ef28da959c50f88d8f5ddc7b40c1db55df16158224e3adbc2d2` |
| `c4h4/MOL` | `a679979b53d53483450f1217cd3a068f570432244a05f39e6a875555ed72fe0e` |
| `c4h4/XDENS` | `e56406ac02116af5d9a0e6ae12be0a04558544e9d83aafffa59a52f274b63149` |
| `c4h4/integration/gimic.inp` | `9fe0b1e53fa90a70662e7743bc52b4a70286ec5ce34a8866ffdd75709bdd05c3` |

## Reproduce the two baseline calculations

Use an independently installed GIMIC binary and driver from that revision. Set `GIMIC_TEST_ROOT` to the absolute path to its `test` directory. Use a fresh working directory for each integration. These are manual reproduction commands.

```sh
work=$(mktemp -d)
mkdir "$work/benzene" "$work/c4h4"
cp "$GIMIC_TEST_ROOT/benzene/MOL" "$GIMIC_TEST_ROOT/benzene/XDENS" "$GIMIC_TEST_ROOT/benzene/keyword-magnet/gimic.inp" "$work/benzene/"
cp "$GIMIC_TEST_ROOT/c4h4/MOL" "$GIMIC_TEST_ROOT/c4h4/XDENS" "$GIMIC_TEST_ROOT/c4h4/integration/gimic.inp" "$work/c4h4/"
(cd "$work/benzene" && gimic gimic.inp > output.log 2>&1)
(cd "$work/c4h4" && gimic gimic.inp > output.log 2>&1)
```

For each baseline, compare the net and signed partial contributions in the backend output with the corresponding upstream `reference/stdout`. Both reference values below reproduced to the last printed digit. In the benzene baseline the realized field is (0, 0, −1), the printed third grid vector is (0, −1, 0), the requested 30 × 30 Gauss grid rounds to 36 × 36, and the signed parts are +16.771417 and −4.969283 nA/T. The cyclobutadiene cut uses different input axes, with realized field (0, 0, +1). Preserve each fixture's own orientation when comparing signs.

## Observed controls

Use independent copies of the baseline inputs for variants. All fluxes are in nA/T. For benzene keep bond [1, 2], fixpoint 4, distance 1.32 bohr and ninth-order quadrature. Default extents are height [−5, 5] and width [−2.2, 5] in bohr. The wider cut changes these to [−7, 7] and [−2.2, 7], preserving the inner limit.

| Input variant | Requested points per axis | Net flux | Control |
| --- | ---: | ---: | --- |
| Benzene as distributed | 30 | +11.802134 | Upstream Gaussian-quadrature fixture |
| Benzene, field (0, 0, +1) | 30 | −11.802134 | Only the field is reversed. Signed parts become +4.969283 and −16.771417. |
| Benzene, original extents | 54 | +11.802139 | Mesh refinement |
| Benzene, original extents | 72 | +11.802139 | Fixed-domain comparison |
| Benzene, wider cut | 72 | +11.813668 | Finite-domain sensitivity at the same requested point count |
| Benzene, wider cut | 90 | +11.813668 | Mesh refinement in the wider domain |
| Cyclobutadiene as distributed | 30 | −19.966416 | Upstream C4H4 fixture, signed parts +2.677300 and −22.643716 |

Refining the original domain changes the net by 0.000005 nA/T. Widening the cut changes the resolved value by 0.011529 nA/T. Mesh convergence alone cannot establish precision against domain truncation. Select a study-specific error budget and test further expansion as needed.

## Missing response control

A fresh copy of the benzene case with only `MOL` and `gimic.inp` produced a missing-density backend error and no integrated current. The upstream Python driver returned status zero in this replay. A valid result requires the expected finalized finite integral, units and input identities. An absent integral must remain missing, never zero.
