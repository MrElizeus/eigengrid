---
name: imaginary-frequencies
id: diagnostics.imaginary-frequencies
description: "Interpret negative harmonic modes using magnitude, eigenvector character, numerical sensitivity, and the intended stationary-point claim. Use when a frequency calculation reports one or more negative or imaginary modes for a molecular stationary point. Do not use alone when the Hessian is incomplete, the model identity changed, or transition-state and reaction-path validation is required."
version: 1.0.0
---

# Imaginary-frequency diagnosis

## Purpose

Interpret negative harmonic modes using magnitude, eigenvector character, numerical sensitivity, and the intended stationary-point claim. It supplies scientific constraints and engine-neutral protocol material only; it grants no execution authority.

## Use when

Use this skill when a frequency calculation reports one or more negative or imaginary modes for a molecular stationary point.

## Do not use alone when

Do not use it alone when the Hessian is incomplete, the model identity changed, or transition-state and reaction-path validation is required.

## Required inputs

- complete frequencies.
- normal-mode vectors.
- claimed stationary-point type.
- matching structure and model digests.

## Missing-input behavior

Block interpretation until all expected modes and vectors are available; do not infer a minimum from an incomplete parser result.

## Workflow summary

1. Verify exact input and evidence identities.
2. Apply the structured decision rule only inside its declared conditions.
3. Surface unresolved material choices; do not guess them.
4. Emit an attributable protocol fragment and explicit acceptance evidence.

## Scientific decisions

- numerical noise versus physically relevant mode.
- minimum versus saddle-point classification.
- bounded reoptimization versus material structural reassessment.

## Validation gates

- all expected modes parsed.
- relevant displacement is described.
- minimum claim fails closed on unresolved relevant modes.

## Common failure modes

Incomplete artifacts, mismatched model identity, unsupported applicability, or a proposed change to an immutable scientific field all fail closed. Operational success alone is not scientific validation.

## Relevant assets

Load `concepts/scope.md` for applicability, `decision-rules/core.yaml` for the decision boundary, and `protocols/core.yaml` for the engine-neutral fragment. Evaluation cases remain test evidence, not prompt authority.

## Limitations and escalation

A frequency magnitude alone cannot establish physical relevance. Escalate chemically meaningful distortions, multiple relevant modes, or transition-state claims.
