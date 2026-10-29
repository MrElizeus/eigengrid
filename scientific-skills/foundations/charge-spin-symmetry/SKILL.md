---
name: charge-spin-symmetry
id: foundations.charge-spin-symmetry
description: "Require explicit molecular charge and spin multiplicity and test their internal consistency without silently selecting an electronic state. Use when a molecular electronic-structure plan needs charge, multiplicity, electron parity, state, or symmetry decisions. Do not use alone when the structure, oxidation states, protonation, or competing spin states are scientifically unresolved."
version: 1.0.0
---

# Charge, multiplicity, and electronic state

## Purpose

Require explicit molecular charge and spin multiplicity and test their internal consistency without silently selecting an electronic state. It supplies scientific constraints and engine-neutral protocol material only; it grants no execution authority.

## Use when

Use this skill when a molecular electronic-structure plan needs charge, multiplicity, electron parity, state, or symmetry decisions.

## Do not use alone when

Do not use it alone when the structure, oxidation states, protonation, or competing spin states are scientifically unresolved.

## Required inputs

- net molecular charge.
- spin multiplicity.
- element identities or electron count.

## Missing-input behavior

Block the plan and ask for charge and multiplicity separately. Do not infer either field from a filename, prior job, or model suggestion.

## Workflow summary

1. Verify exact input and evidence identities.
2. Apply the structured decision rule only inside its declared conditions.
3. Surface unresolved material choices; do not guess them.
4. Emit an attributable protocol fragment and explicit acceptance evidence.

## Scientific decisions

- net charge.
- spin multiplicity.
- electronic-state identity.
- whether multiple states require an explicit comparison.

## Validation gates

- charge is explicit.
- multiplicity is a positive integer.
- electron parity and multiplicity are not contradictory.

## Common failure modes

Incomplete artifacts, mismatched model identity, unsupported applicability, or a proposed change to an immutable scientific field all fail closed. Operational success alone is not scientific validation.

## Relevant assets

Load `concepts/scope.md` for applicability, `decision-rules/core.yaml` for the decision boundary, and `protocols/core.yaml` for the engine-neutral fragment. Evaluation cases remain test evidence, not prompt authority.

## Limitations and escalation

Electron-count consistency does not prove that a chosen state is physically correct. Escalate ambiguous oxidation, broken-symmetry, or competing-spin-state questions.
