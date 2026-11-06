---
name: molecular-basis-convergence
id: workflows.molecular-basis-convergence
description: "Use for basis convergence tests on anions or polarizabilities, diffuse orbital tails, auxiliary fitting sets, effective core potentials and near-linear dependence."
version: 1.0.0
---

# Molecular basis convergence, diffuse augmentation and ECP coverage

## Purpose

Converge an atom-centered basis for the molecular target property. Test diffuse augmentation, auxiliary fitting space, ECP electron counts and near-linear dependence independently.

## Use when

The comparison uses atom-centered orbital functions and a declared fragment partition or balanced reaction. The quantity of interest can be recomputed along a controlled ladder.

## Do not use alone when

Plane waves, pseudopotential cutoffs and Brillouin-zone sampling require a periodic protocol. Multi-fragment covalent decompositions need a defensible charge and spin partition.

## Required inputs

- Fixed geometry hashes and state identity for every species and fragment
- Observable with sign convention, numerical tolerance and energy units
- Element-to-basis and ECP/core-electron assignments, basis library version, auxiliary fitting model
- Fragment mapping, geometries, charges and multiplicities if an interaction energy is requested

## Missing-input behavior

Block a quantitative convergence claim when any element assignment, fragment electronic state or target tolerance is unknown.

## Scientific decisions

If the ECP core size changes along the ladder, split the Hamiltonians into separate comparisons and rebuild a matched ladder before interpreting a basis-size trend. Inspect `protocols/core.yaml` for the evidence to record at each step and `references/sources.md` for the scope of each source.

## Limitations and escalation

If the last basis change, augmentation sensitivity or unresolved BSSE could reverse the conclusion, report the range and keep the ranking provisional.
