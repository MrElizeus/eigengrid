---
name: solution-conformer-free-energy
id: workflows.solution-conformer-free-energy
description: "Use for Boltzmann populations, conformer degeneracy, quasi-RRHO, low-frequency torsions, 1 atm to 1 M corrections and association equilibria in solvent."
version: 1.0.0
---

# Solution conformer populations and standard-state free energy

## Purpose

Combine conformer search, consistent solvation, vibrational corrections and a balanced standard-state cycle to estimate ensemble solution free energies at a stated temperature.

## Use when

Several accessible minima may contribute to the observed equilibrium, or a solution association or isomerization free energy requires a documented convention.

## Do not use alone when

An observed kinetic product mixture, kinetically trapped conformers, or proton exchange with a reservoir needs its own kinetic or speciation model.

## Required inputs

- Species identities, stereochemistry, stoichiometry, charge and standard states
- Solvent and temperature, equilibrated populations or stated equilibrium assumption
- Conformer candidates, search provenance, degeneracy convention and energy/frequency levels
- Thermochemical cycle specifying solvent, concentration and pressure conventions for each term

## Missing-input behavior

Hold populations and solution reaction free energies until temperature, constituent states, stationary-point status and standard-state conventions are known.

## Scientific decisions

Has the same standard-state or solvent-transfer contribution already appeared elsewhere in the cycle? Hold the assembled value. Reconcile the species-level terms and conventions, then recompute the balanced reaction sum. Inspect `protocols/core.yaml` for the evidence to record at each step and `references/sources.md` for the scope of each source.

## Limitations and escalation

Report unresolved ordering or ranges when missing conformers, protonation ambiguity, strong specific solvation or low-mode sensitivity can change the observable.
