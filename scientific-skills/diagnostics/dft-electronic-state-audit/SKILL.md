---
name: dft-electronic-state-audit
id: diagnostics.dft-electronic-state-audit
description: "Use for unrestricted spin contamination, broken-symmetry determinants, orbital occupations, SCF stability analysis, metastable solutions and quadrature-sensitive small gaps."
version: 1.0.0
---

# DFT electronic-state audit for competing spin solutions

## Purpose

Distinguish numerical SCF convergence from selection of the intended electronic state for radicals, open-shell singlets and transition-metal spin gaps.

## Use when

A converged Kohn-Sham calculation has competing occupations or local spin patterns, or the energy gap between proposed states is comparable with numerical noise.

## Do not use alone when

Spin-orbit coupled manifolds, strong near-degeneracy or states with substantial multi-configurational character require a suitable specialist method and independent review.

## Required inputs

- Total charge and supported spin multiplicities with structural and chemical rationale
- Fixed geometry for a vertical gap or separate optimized geometries for an adiabatic gap
- SCF residuals and convergence flags, occupations, wavefunction type and restart provenance
- Target gap precision, energy units, XC quadrature and exact-exchange approximation

## Missing-input behavior

Ask for plausible states and their evidence before selecting one. Preserve all converged candidates when assignments remain underdetermined.

## Scientific decisions

Did a converged run collapse to another occupation or local-spin solution? Keep the result as evidence for the observed state, replan targeted guesses, and withhold the requested spin gap until both states are identified. Inspect `protocols/core.yaml` for the evidence to record at each step and `references/sources.md` for the scope of each source.

## Limitations and escalation

With unstable roots, unresolved state collapse, strong near-degeneracy or method/grid-dependent order, withhold a unique ground-state assignment and seek a state-specific reference.
