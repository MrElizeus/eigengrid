---
name: geometry-optimization
id: workflows.geometry-optimization
description: "Plan and assess an engine-neutral molecular geometry optimization with explicit convergence and downstream minimum validation. Use when a molecular mission needs a stationary geometry under an already-declared electronic and physical model. Do not use alone when a transition state, constrained path, periodic cell, or unresolved charge, multiplicity, method, or basis is intended."
version: 1.0.0
---

# Molecular geometry optimization

## Purpose

Plan and assess an engine-neutral molecular geometry optimization with explicit convergence and downstream minimum validation. It supplies scientific constraints and engine-neutral protocol material only; it grants no execution authority.

## Use when

Use this skill when a molecular mission needs a stationary geometry under an already-declared electronic and physical model.

## Do not use alone when

Do not use it alone when a transition state, constrained path, periodic cell, or unresolved charge, multiplicity, method, or basis is intended.

## Required inputs

- starting structure.
- charge.
- multiplicity.
- method.
- basis.
- optimization acceptance thresholds.

## Missing-input behavior

Block compilation and request the missing material fields or optimization acceptance criteria; never inherit them silently.

## Workflow summary

1. Verify exact input and evidence identities.
2. Apply the structured decision rule only inside its declared conditions.
3. Surface unresolved material choices; do not guess them.
4. Emit an attributable protocol fragment and explicit acceptance evidence.

## Scientific decisions

- optimization target.
- coordinate constraints.
- convergence thresholds.
- restart versus scientifically changed replan.

## Validation gates

- normal termination.
- declared optimizer thresholds are met.
- final coordinates are captured immutably.
- minimum validation remains required.

## Common failure modes

Incomplete artifacts, mismatched model identity, unsupported applicability, or a proposed change to an immutable scientific field all fail closed. Operational success alone is not scientific validation.

## Relevant assets

Load `concepts/scope.md` for applicability, `decision-rules/core.yaml` for the decision boundary, and `protocols/core.yaml` for the engine-neutral fragment. Evaluation cases remain test evidence, not prompt authority.

## Limitations and escalation

Optimizer convergence alone does not establish a minimum. Escalate chemically implausible structures, state changes, fragmentation, or any proposed model change.
