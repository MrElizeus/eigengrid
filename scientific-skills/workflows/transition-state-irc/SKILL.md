---
name: transition-state-irc
id: workflows.transition-state-irc
version: 1.0.0
description: "Identify a first-order transition state and test which two minima it connects by following the intrinsic reaction coordinate (IRC) on a single molecular potential-energy surface."
---

# DFT transition state and IRC connectivity

## Purpose

Identify a first-order transition state and test which two minima it connects by following the intrinsic reaction coordinate (IRC) on a single molecular potential-energy surface.

## Use when

The question concerns an elementary step between specified molecular minima, with a saddle candidate or a chemically justified guess.

## Do not use alone when

Spin crossings, excited surfaces, barrierless association, constrained free-energy profiles or dynamics determine the mechanism.

## Required inputs

- Atom-mapped reactant and product structures and proposed bond or proton transfers
- Charge, multiplicity, electronic surface, method, basis, dispersion, solvent and constraints
- Saddle search starting geometry or a justified path between mapped endpoints
- Gradient, Hessian and path-convergence criteria and the claimed barrier reference

## Missing-input behavior

Request unresolved endpoints, surface identity or tolerances before planning a barrier. Preserve a lone negative mode as candidate evidence until both branches are assigned.

## Scientific decisions

Inspect the eigenvector from a converged full Hessian. Displace in both signs and identify the actual moving atoms. A low-frequency torsion can be an authentic saddle along the wrong coordinate. Compare the signed curvature after removing overall rotations and translations. Constraints yield curvature only in the permitted subspace.

Apply the first-order saddle criterion to the transition structure. Use the minimum-optimization and harmonic minimum checks only for separately identified endpoint work units. For transition-state thermochemistry exclude the single imaginary reaction-coordinate vibration from the vibrational partition function.

At the same level, follow mass-weighted downhill paths in both directions. The sign of a mode is arbitrary. Assign reactant and product by the endpoints' chemistry. Reoptimize each final image and verify it is a minimum. For a free-energy barrier specify the ensemble, temperature, standard state and whether the reference is separated reactants or a prereactive complex.

## Limitations and escalation

A wrong mode calls for a new guess or path. Short or stalled trajectories leave connectivity unresolved. Distinct pathways or bifurcations require independent investigation before interpreting selectivity or rate constants.

## Evidence and attribution

Inspect `protocols/core.yaml` for the ordered steps, acceptance gates and recovery. Bind source output and geometry digests to each derived value. Read `references/README.md` for the claim supported by each source.
