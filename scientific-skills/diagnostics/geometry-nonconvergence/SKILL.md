---
name: geometry-nonconvergence
id: diagnostics.geometry-nonconvergence
description: "Diagnose stalled or failed molecular optimizations without confusing operational, numerical, structural, and model-level causes. Use when an optimization reaches iteration limits, stalls, oscillates, fails coordinates, or ends without accepted convergence. Do not use alone when the operation effect is ambiguous, output is corrupt, or the intended stationary-point type was never declared."
version: 1.0.0
---

# Geometry nonconvergence diagnosis

## Purpose

Diagnose stalled or failed molecular optimizations without confusing operational, numerical, structural, and model-level causes. It supplies scientific constraints and engine-neutral protocol material only; it grants no execution authority.

## Use when

Use this skill when an optimization reaches iteration limits, stalls, oscillates, fails coordinates, or ends without accepted convergence.

## Do not use alone when

Do not use it alone when the operation effect is ambiguous, output is corrupt, or the intended stationary-point type was never declared.

## Required inputs

- optimization trace.
- initial and last valid structures.
- approved model fields.
- convergence thresholds and attempt history.

## Missing-input behavior

Reconcile and collect complete artifacts before diagnosis. Do not launch a replacement optimization from an unverified partial geometry.

## Workflow summary

1. Verify exact input and evidence identities.
2. Apply the structured decision rule only inside its declared conditions.
3. Surface unresolved material choices; do not guess them.
4. Emit an attributable protocol fragment and explicit acceptance evidence.

## Scientific decisions

- last valid restart geometry.
- bounded optimizer-control change.
- structural pathology.
- scientifically material replan.

## Validation gates

- last valid geometry digest is identified.
- failure class is explicit.
- retry is bounded or approval is requested.

## Common failure modes

Incomplete artifacts, mismatched model identity, unsupported applicability, or a proposed change to an immutable scientific field all fail closed. Operational success alone is not scientific validation.

## Relevant assets

Load `concepts/scope.md` for applicability, `decision-rules/core.yaml` for the decision boundary, and `protocols/core.yaml` for the engine-neutral fragment. Evaluation cases remain test evidence, not prompt authority.

## Limitations and escalation

More steps do not repair an inappropriate state or method. Escalate bond breaking, fragmentation, unintended isomerization, or changes to constraints and physical model.
