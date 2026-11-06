---
name: gimic-ring-currents
id: workflows.gimic-ring-currents
version: 1.0.0
description: "Plan a GIMIC current-density calculation for magnetic aromaticity, diatropic or paratropic ring currents and current pathways. Use an oriented integration surface and traceable magnetically perturbed AO densities."
---

# GIMIC ring currents

## Purpose

Identify the path and signed strength of the electronic current induced by a weak static magnetic field in a molecule. The reported quantity is a flux per unit field in nA/T. A meaningful result identifies both the field and the surface through which the current flows.

## Use when

Use for single rings, fused rings, macrocycles or alternative current pathways. For naphthalene, a cut through the shared central bond can yield zero by symmetry while a diatropic current flows around the perimeter. Probe outer bonds and branch points when the hypothesis concerns a global circuit. [Pathway study](https://doi.org/10.1039/D1CP02381K)

## Do not use alone when

A question concerns resonance stabilization energy, equilibrium bond order, or the NMR chemical shift of a particular nucleus. GIMIC supplies a magnetic-response criterion. An electronic delocalization analysis can test a complementary hypothesis.

## Required inputs

- A pinned geometry and AO basis, molecular state, SCF and magnetic-response convergence, and identities of the producer and converter.
- The unperturbed AO density and three first-order AO response matrices for laboratory fields along x, y and z. Preserve producer-specific normalization, Cartesian/spherical conventions, spin blocks, index order and field signs during conversion.
- A named circuit, field unit vector in an identified frame, oriented surface normal, dimensions in declared units, integration rule and target numerical tolerance.

## Missing-input behavior

An XYZ geometry, orbital picture or shielding table alone is insufficient. A file extension cannot identify the response blocks or their ordering. For an unfamiliar producer or electronic state, hold the calculation until the conversion is documented and a representative replay or independent cross-interface comparison succeeds.

## Scientific decisions

For a field direction b and oriented surface S with unit normal n, the signed current-strength susceptibility is the surface integral of n · (∂j/∂B) · b over S. Reverse only b or n to reverse the signed flux. Reversing both preserves it. Record the sign convention with the field and surface, including the direction of viewing if describing circulation.

For a planar ring, choose a field along its normal. Inspect a vector field or streamlines before placing a radial half-plane that crosses a target bond once and extends into the weak-current region outside the ring. A plane that spans opposite sides may count return flow. A positive or negative contribution at a single point identifies flow relative to n. Assign diatropic or paratropic circulation from the complete oriented path relative to the field.

Test quadrature at fixed bounds, then increase the outer and out-of-plane extents at converged resolution while retaining the physically chosen inner boundary. Test the sensitivity to that inner boundary separately. Archive net and signed partial contributions, boundary and mesh residuals, and the balance of independent cuts for the same branch or junction. Map sampling and finite-basis effects can both affect current conservation. [GIMIC interpretation](https://gimic.readthedocs.io/en/latest/interpretation.html)

## Limitations and escalation

Start qualification with closed-shell molecules. Open-shell cases require an explicitly supported converter and verifiable spin-channel bookkeeping. Twisted, nonplanar and fused circuits require a specified field orientation and an explicit choice of branch cuts. For local vortices, bifurcated flow, state ambiguity or differences comparable to numerical sensitivity, report the observed flux and unresolved assignment.

## Evidence

Read `protocols/core.yaml` for the gates and `references/fixture-replay.md` for the pinned benzene, cyclobutadiene and failure controls. The replay starts from precomputed response matrices. No upstream quantum-chemistry engine is implied by the GIMIC planning compatibility record.
