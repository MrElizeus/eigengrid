---
name: cp2k-gpw-convergence
id: methods.cp2k-gpw-convergence
version: 1.0.0
description: Plan a CP2K GPW convergence study for CUTOFF, REL_CUTOFF, Gaussian orbitals and GTH pseudopotentials using the target energy difference, force or stress.
---

# CP2K Quickstep GPW basis, pseudopotential and grid convergence

## Purpose

Plan a CP2K GPW convergence study for CUTOFF, REL_CUTOFF, Gaussian orbitals and GTH pseudopotentials using the target energy difference, force or stress.

## Use when

A CP2K Quickstep Gaussian and plane waves (GPW) calculation needs a reproducible error budget for an energy, force, phase ordering or cell optimization.

## Do not use alone when

The calculation uses the GAPW all-electron path, a pure plane-wave orbital basis or a core-level observable. These require different convergence variables and reference data.

## Required inputs

- structure and cell models for each comparison state
- functional, spin state, dispersion treatment and reciprocal-space sampling
- per-kind Gaussian basis and pseudopotential entries including valence electron counts
- target quantities, units, tolerances and available resource budget

## Missing-input behavior

Request missing basis or potential file identities and target tolerances. Keep any untested parameter set provisional.

## Scientific decisions

Quickstep represents the orbitals in atom-centered Gaussian functions. The auxiliary plane-wave grid represents the smooth density. Increasing the finest-grid cutoff can fix density-integration error while leaving error in the orbital space. REL_CUTOFF determines which Gaussian products move to finer levels. A shallow energy curve along just one of these axes can hide sensitivity along another.

Make a convergence table for each representative geometry. Record basis and potential digests, CUTOFF and REL_CUTOFF in Ry, number of grids, SCF residual and convergence flag, energy in Ha, maximum force deviation in a chosen force unit, target stress components when relevant, wall time and memory. Use a tighter combined reference for the final comparison. Comparing geometries or pseudopotentials with different energy zeros requires balanced energy differences evaluated consistently within each model.

## Limitations and escalation

Escalate a missing valence configuration, a pseudopotential of uncertain transferability, conflicting spin solutions or force noise larger than the intended relaxation threshold. Numerical convergence alone does not calibrate the functional.
