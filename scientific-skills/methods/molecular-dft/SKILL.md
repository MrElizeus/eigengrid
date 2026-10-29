---
name: molecular-dft
id: methods.molecular-dft
description: "Plan molecular DFT with explicit functional, basis, state, numerical controls, applicability limits, and validation obligations. Use when a molecular electronic-structure objective can be addressed by a declared single-reference density-functional model. Do not use alone when strong multireference character, periodicity, excited-state character, or domain-specific benchmark evidence is central."
version: 1.0.0
---

# Molecular density-functional theory

## Purpose

Plan molecular DFT with explicit functional, basis, state, numerical controls, applicability limits, and validation obligations. It supplies scientific constraints and engine-neutral protocol material only; it grants no execution authority.

## Use when

Use this skill when a molecular electronic-structure objective can be addressed by a declared single-reference density-functional model.

## Do not use alone when

Do not use it alone when strong multireference character, periodicity, excited-state character, or domain-specific benchmark evidence is central.

## Required inputs

- molecular structure.
- charge.
- multiplicity.
- functional.
- basis specification.
- target property.

## Missing-input behavior

Block the protocol when charge, multiplicity, functional, basis, or physical model is unresolved. Do not fill these fields from model preference.

## Workflow summary

1. Verify exact input and evidence identities.
2. Apply the structured decision rule only inside its declared conditions.
3. Surface unresolved material choices; do not guess them.
4. Emit an attributable protocol fragment and explicit acceptance evidence.

## Scientific decisions

- functional.
- basis/ECP/relativity.
- dispersion treatment.
- solvation model.
- numerical controls.

## Validation gates

- functional and basis are explicit.
- charge and multiplicity are preserved.
- numerical and physical models are attributable.
- validation work is planned.

## Common failure modes

Incomplete artifacts, mismatched model identity, unsupported applicability, or a proposed change to an immutable scientific field all fail closed. Operational success alone is not scientific validation.

## Relevant assets

Load `concepts/scope.md` for applicability, `decision-rules/core.yaml` for the decision boundary, and `protocols/core.yaml` for the engine-neutral fragment. Evaluation cases remain test evidence, not prompt authority.

## Limitations and escalation

This unreviewed draft is not benchmark-backed and does not certify DFT accuracy for a chemical domain. Escalate suspected multireference character and material changes.
