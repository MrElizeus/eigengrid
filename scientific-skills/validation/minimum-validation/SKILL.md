---
name: minimum-validation
id: validation.minimum-validation
description: "Require attributable optimization and harmonic evidence before assessing a molecular structure as a local minimum. Use when a mission claims that an optimized molecular geometry is a local minimum under a declared model. Do not use alone when the intended structure is a transition state, a flat anharmonic region, a periodic solid, or requires sampling-based stability."
version: 1.0.1
---

# Molecular minimum validation

## Purpose

Require attributable optimization and harmonic evidence before assessing a molecular structure as a local minimum. It supplies scientific constraints and engine-neutral protocol material only; it grants no execution authority.

## Use when

Use this skill when a mission claims that an optimized molecular geometry is a local minimum under a declared model.

## Do not use alone when

Do not use it alone when the intended structure is a transition state, a flat anharmonic region, a periodic solid, or requires sampling-based stability.

## Required inputs

- optimized structure digest.
- optimization convergence evidence.
- complete frequencies and mode vectors.
- exact method-state identity.

## Missing-input behavior

Return an indeterminate validation result with missing evidence; do not promote normal termination or a partial parser record to a minimum claim.

## Workflow summary

1. Verify exact input and evidence identities.
2. Apply the structured decision rule only inside its declared conditions.
3. Surface unresolved material choices; do not guess them.
4. Emit an attributable protocol fragment and explicit acceptance evidence.

## Scientific decisions

- evidence completeness.
- relevant imaginary-mode classification.
- chemical plausibility.
- scope of the minimum claim.

## Validation gates

- optimization converged.
- frequency record is complete.
- no relevant imaginary modes remain.
- structure is chemically plausible within stated scope.

## Common failure modes

Incomplete artifacts, mismatched model identity, unsupported applicability, or a proposed change to an immutable scientific field all fail closed. Operational success alone is not scientific validation.

## Relevant assets

Load `concepts/scope.md` for applicability, `decision-rules/core.yaml` for the decision boundary, and `protocols/core.yaml` for the engine-neutral fragment. Evaluation cases remain test evidence, not prompt authority.

## Limitations and escalation

This validates only a local harmonic minimum for the declared model, not global stability, synthesis, kinetics, or experimental truth.
