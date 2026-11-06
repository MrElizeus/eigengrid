---
name: dft-functional-selection
id: methods.dft-functional-selection
description: "Use for choosing a functional for barriers, reaction energies, conformer rankings or noncovalent interactions, assessing GMTKN55 coverage, and auditing r2SCAN-3c or D4 double counting."
version: 1.0.0
---

# DFT functional selection against a matched benchmark

## Purpose

Select a molecular ground-state exchange-correlation approximation, dispersion treatment and cost tier for a specified observable using comparable reference data.

## Use when

The requested deliverable is a difference between energies for a defined set of molecular states. A functional choice must still be justified for that difference.

## Do not use alone when

An excited-state, extended solid, metal spin gap or bond-breaking problem needs independent evidence specific to that regime.

## Required inputs

- Reaction or comparison with balanced species, structures, charges and multiplicities
- Observable, phase, temperature if applicable, target tolerance and units
- Computational resource ceiling and any imposed method restrictions

## Missing-input behavior

If no functional is chosen, use the agreed observable, states, tolerance and budget to build a provisional candidate shortlist. Hold numerical work until a complete model is selected and approved. Request missing study constraints first.

## Scientific decisions

For each candidate, identify the base XC approximation and its complete dispersion treatment from the published definition. If a term duplicates a built-in component, reject that specification and document a corrected candidate. Inspect `protocols/core.yaml` for the evidence to record at each step and `references/sources.md` for the scope of each source.

## Limitations and escalation

Hold any definitive ordering if method sensitivity reaches the decision margin or the relevant reference chemistry is missing.
