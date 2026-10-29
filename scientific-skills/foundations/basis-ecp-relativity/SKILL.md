---
name: basis-ecp-relativity
id: foundations.basis-ecp-relativity
description: "Frame basis-set, effective-core-potential, diffuse-function, polarization, and relativistic choices as explicit material scientific decisions. Use when a molecular wavefunction or density-functional calculation requires a basis, ECP, diffuse functions, or relativistic treatment. Do not use alone when the method has no atom-centered basis or a validated domain-specific benchmark is required to choose among alternatives."
version: 1.0.0
---

# Basis sets, ECPs, and relativity

## Purpose

Frame basis-set, effective-core-potential, diffuse-function, polarization, and relativistic choices as explicit material scientific decisions. It supplies scientific constraints and engine-neutral protocol material only; it grants no execution authority.

## Use when

Use this skill when a molecular wavefunction or density-functional calculation requires a basis, ECP, diffuse functions, or relativistic treatment.

## Do not use alone when

Do not use it alone when the method has no atom-centered basis or a validated domain-specific benchmark is required to choose among alternatives.

## Required inputs

- elements present.
- target property.
- method family.
- required confidence.

## Missing-input behavior

Block plannable method selection until the basis family and treatment of elements outside its coverage are explicit.

## Workflow summary

1. Verify exact input and evidence identities.
2. Apply the structured decision rule only inside its declared conditions.
3. Surface unresolved material choices; do not guess them.
4. Emit an attributable protocol fragment and explicit acceptance evidence.

## Scientific decisions

- basis family and size.
- diffuse and polarization functions.
- ECP versus all-electron treatment.
- relativistic model.

## Validation gates

- every element has an explicit basis treatment.
- ECP and relativistic choices are recorded.
- unresolved diffuse-function need is surfaced.

## Common failure modes

Incomplete artifacts, mismatched model identity, unsupported applicability, or a proposed change to an immutable scientific field all fail closed. Operational success alone is not scientific validation.

## Relevant assets

Load `concepts/scope.md` for applicability, `decision-rules/core.yaml` for the decision boundary, and `protocols/core.yaml` for the engine-neutral fragment. Evaluation cases remain test evidence, not prompt authority.

## Limitations and escalation

This draft provides decision structure, not benchmark-backed basis recommendations. Escalate heavy elements, anions, weak binding, near-linear dependence, or precision claims.
