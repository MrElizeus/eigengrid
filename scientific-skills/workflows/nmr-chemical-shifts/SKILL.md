---
name: nmr-chemical-shifts
id: workflows.nmr-chemical-shifts
version: 1.0.0
description: "Convert proton and carbon isotropic shielding tensors to solution NMR chemical shifts, account for conformers and reference offsets, and compare candidate assignments to experiment."
---

# Solution NMR chemical shifts and assignment

## Purpose

Predict chemical shifts of mapped 1H and 13C nuclei in freely tumbling, diamagnetic molecules. For structure assignment, compare alternative constitutions or relative configurations against a single documented solution spectrum.

## Use when

A study asks for atom-resolved chemical shifts, a proton or carbon reference correction, ambiguity between diastereomers, or the effect of fast conformational exchange on a resonance.

## Do not use alone when

Paramagnetic species require additional spin-dependent shift terms. Anisotropic media and static solids require orientation-dependent observables. A request for couplings, a multiplet line shape, or magnetic currents through a ring needs additional evidence. In an achiral environment, ordinary isotropic shifts cannot distinguish enantiomers.

## Required inputs

Record the candidate set, isotope, atom map, model chemistry, solvent, temperature, reference convention and exchange assumptions. For experimental comparison include peak IDs, referencing conditions, assignment constraints, uncertainties, overlaps and exclusions.

## Missing-input behavior

An absolute shielding can be recorded before choosing a reference. Keep the shift or assignment unresolved until its specific prerequisites are met. An unread or failed conformer cannot be silently removed from a population average.

## Scientific decisions

Select either a matched reference calculation or an independently fitted calibration for each isotope. Use a one-to-one conformer/atom join for the response and energy records. Identify equivalence and exchange at the temperature and NMR frequency of the measurement. Compare candidates against the same fixed observations and report the assignment alternatives left open by the error budget.

## Limitations and escalation

Solvent hydrogen bonding, exchanging OH/NH sites, concentration-dependent association and unresolved tautomers can dominate individual shifts. Seek measured conditions, a test of explicit solvation or additional spectroscopic constraints when they change the assignment.

## Evidence and attribution

The protocol supplies the reduction equations, a synthetic two-conformer check and a proposed independent comparison. The ORCA mapping identifies property-output evidence. The references give primary protocols, an implementation correction and engine-specific assumptions.
