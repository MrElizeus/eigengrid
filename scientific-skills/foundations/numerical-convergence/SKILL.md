---
name: numerical-convergence
id: foundations.numerical-convergence
description: "Separate bounded numerical convergence controls from material changes to method, basis, state, physical model, or objective. Use when a protocol needs SCF, integration-grid, optimizer, finite-difference, or threshold convergence controls. Do not use alone when failure evidence indicates an incorrect electronic state, unsuitable method, or changed physical model."
version: 1.0.0
---

# Numerical convergence controls

## Purpose

Separate bounded numerical convergence controls from material changes to method, basis, state, physical model, or objective. It supplies scientific constraints and engine-neutral protocol material only; it grants no execution authority.

## Use when

Use this skill when a protocol needs SCF, integration-grid, optimizer, finite-difference, or threshold convergence controls.

## Do not use alone when

Do not use it alone when failure evidence indicates an incorrect electronic state, unsuitable method, or changed physical model.

## Required inputs

- calculation kind.
- declared numerical thresholds.
- target scientific precision.

## Missing-input behavior

Use conservative explicit defaults only when the approved policy names them; otherwise block and request numerical acceptance thresholds.

## Workflow summary

1. Verify exact input and evidence identities.
2. Apply the structured decision rule only inside its declared conditions.
3. Surface unresolved material choices; do not guess them.
4. Emit an attributable protocol fragment and explicit acceptance evidence.

## Scientific decisions

- convergence thresholds.
- grid or quadrature precision.
- iteration limits.
- whether numerical sensitivity testing is required.

## Validation gates

- thresholds are explicit.
- bounded retries are finite.
- material fields remain unchanged.

## Common failure modes

Incomplete artifacts, mismatched model identity, unsupported applicability, or a proposed change to an immutable scientific field all fail closed. Operational success alone is not scientific validation.

## Relevant assets

Load `concepts/scope.md` for applicability, `decision-rules/core.yaml` for the decision boundary, and `protocols/core.yaml` for the engine-neutral fragment. Evaluation cases remain test evidence, not prompt authority.

## Limitations and escalation

Tighter thresholds do not correct a scientifically unsuitable model. Escalate changes that alter charge, multiplicity, method, basis, physical model, or objective.
