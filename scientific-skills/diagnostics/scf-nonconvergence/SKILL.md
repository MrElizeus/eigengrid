---
name: scf-nonconvergence
id: diagnostics.scf-nonconvergence
description: "Classify SCF failures from evidence and separate operational recovery, bounded numerical remediation, and scientifically material replanning. Use when an electronic-structure output reports incomplete, oscillatory, divergent, or otherwise unaccepted SCF convergence. Do not use alone when the parser is incomplete, the job effect is ambiguous, or charge and multiplicity were never established."
version: 1.0.0
---

# SCF nonconvergence diagnosis

## Purpose

Classify SCF failures from evidence and separate operational recovery, bounded numerical remediation, and scientifically material replanning. It supplies scientific constraints and engine-neutral protocol material only; it grants no execution authority.

## Use when

Use this skill when an electronic-structure output reports incomplete, oscillatory, divergent, or otherwise unaccepted SCF convergence.

## Do not use alone when

Do not use it alone when the parser is incomplete, the job effect is ambiguous, or charge and multiplicity were never established.

## Required inputs

- immutable input artifact.
- complete output or parser evidence.
- approved method, basis, charge, and multiplicity.
- attempt history.

## Missing-input behavior

Do not diagnose from a truncated status line. Reconcile the operation and collect immutable logs before recommending remediation.

## Workflow summary

1. Verify exact input and evidence identities.
2. Apply the structured decision rule only inside its declared conditions.
3. Surface unresolved material choices; do not guess them.
4. Emit an attributable protocol fragment and explicit acceptance evidence.

## Scientific decisions

- operational versus numerical versus scientific-material failure.
- bounded retry eligibility.
- whether model adequacy or electronic state requires review.

## Validation gates

- failure evidence is attributed.
- remediation class is explicit.
- retry bounds are finite.
- material fields remain immutable without approval.

## Common failure modes

Incomplete artifacts, mismatched model identity, unsupported applicability, or a proposed change to an immutable scientific field all fail closed. Operational success alone is not scientific validation.

## Relevant assets

Load `concepts/scope.md` for applicability, `decision-rules/core.yaml` for the decision boundary, and `protocols/core.yaml` for the engine-neutral fragment. Evaluation cases remain test evidence, not prompt authority.

## Limitations and escalation

SCF convergence is not proof of the correct electronic state. Escalate state instability, severe spin contamination, suspected multireference character, or material model changes.
