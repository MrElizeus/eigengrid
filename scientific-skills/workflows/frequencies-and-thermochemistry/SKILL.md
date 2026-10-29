---
name: frequencies-and-thermochemistry
id: workflows.frequencies-and-thermochemistry
description: "Plan harmonic frequency evidence and bounded thermochemistry interpretation for a previously optimized molecular structure. Use when a mission must validate a stationary point or derive harmonic zero-point and thermal corrections. Do not use alone when anharmonicity, hindered rotors, condensed-phase sampling, excited states, or a transition-state claim dominates."
version: 1.0.0
---

# Frequencies and molecular thermochemistry

## Purpose

Plan harmonic frequency evidence and bounded thermochemistry interpretation for a previously optimized molecular structure. It supplies scientific constraints and engine-neutral protocol material only; it grants no execution authority.

## Use when

Use this skill when a mission must validate a stationary point or derive harmonic zero-point and thermal corrections.

## Do not use alone when

Do not use it alone when anharmonicity, hindered rotors, condensed-phase sampling, excited states, or a transition-state claim dominates.

## Required inputs

- optimized structure artifact.
- same approved scientific model.
- temperature and standard-state intent when thermochemistry is requested.

## Missing-input behavior

Block the frequency work unit if the optimized artifact or exact method-state identity is missing; block thermochemistry interpretation without conditions.

## Workflow summary

1. Verify exact input and evidence identities.
2. Apply the structured decision rule only inside its declared conditions.
3. Surface unresolved material choices; do not guess them.
4. Emit an attributable protocol fragment and explicit acceptance evidence.

## Scientific decisions

- analytic versus supported numerical Hessian.
- temperature and standard state.
- treatment of low modes.
- minimum versus transition-state interpretation.

## Validation gates

- frequency job terminates normally.
- all expected modes parse.
- mode signs and vectors support the claimed stationary point.

## Common failure modes

Incomplete artifacts, mismatched model identity, unsupported applicability, or a proposed change to an immutable scientific field all fail closed. Operational success alone is not scientific validation.

## Relevant assets

Load `concepts/scope.md` for applicability, `decision-rules/core.yaml` for the decision boundary, and `protocols/core.yaml` for the engine-neutral fragment. Evaluation cases remain test evidence, not prompt authority.

## Limitations and escalation

The harmonic approximation can be poor for floppy modes and finite-temperature sampling. Escalate multiple relevant imaginary modes, low-frequency sensitivity, or requested high accuracy.
