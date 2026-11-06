# Primary sources and scope

## ORCA-NMR

ORCA 6.1 manual §5.21 documents the shielding tensor, supported electronic methods and property calculation options. Check compatibility for the installed build. [ORCA NMR manual](https://www.faccts.de/docs/orca/6.1/manual/contents/spectroscopyproperties/nmr.html)

## ORCA-TUTORIAL

The FACCTs tutorial provides a matched TMS/propionic acid comparison with coordinates, methods, solvent and a table of calculated and experimental carbon shifts. It supplies a concrete calculation and unit/sign check. [ORCA 6.1 NMR tutorial, example 1](https://www.faccts.de/docs/orca/6.1/tutorials/spec/NMR.html)

## HOYE

Willoughby, Jansma and Hoye (2014) give an experimental structure-assignment workflow that combines conformer ensembles, free energies and proton/carbon shifts. [Nature Protocols](https://doi.org/10.1038/nprot.2014.042)

## HOYE-ADDENDUM

The authors document a file sorting problem in the original scripts (2020). The keyed conformer, geometry and atom joins in this module address that failure mode. [Authors' addendum](https://doi.org/10.1038/s41596-020-0293-9)

## PIERENS

Pierens (2014) derives method- and solvent-specific regression parameters for proton and carbon shifts. Validate transfer to the intended study class with a disjoint test set. [Journal of Computational Chemistry](https://doi.org/10.1002/jcc.23638)

## DP4

Smith and Goodman (2010) test conditional stereochemical assignments for candidate diastereomers against measured shifts. Their likelihood model has its own method and error-distribution assumptions. [Original DP4 paper](https://doi.org/10.1021/ja105035r)

## Local GIAO shielding regression

Using PySCF 2.11.0, the properties extension at `4eee5a430fb47eca5962f36fdcaf75c2b87e7ede`, and fixed gas-phase PBE/cc-pVDZ geometries, the isotropic methane (H, C) shieldings were (31.320613, 199.748458) ppm. Ethene gave (25.473703, 69.240911) ppm. With methane assigned zero separately for each isotope, the first-order differences were +5.846910 and +130.507547 ppm. The calculation and numeric regression are reproducible with `examples/magnetic-response/nmr_pilot.py` in a source checkout. Methane is a computational comparator in this example. Solution chemical shifts and assignment accuracy need a suitable experimental reference and independent measurements. [PySCF properties source](https://github.com/pyscf/properties/tree/4eee5a430fb47eca5962f36fdcaf75c2b87e7ede)
