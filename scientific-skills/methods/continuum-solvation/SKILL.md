---
name: continuum-solvation
id: methods.continuum-solvation
description: "Represent solvent identity, continuum model, cavity, state conditions, and gas-versus-solution interpretation explicitly. Use when a molecular objective asks for solution-phase structure, energy, thermochemistry, or a solvent effect. Do not use alone when explicit solvent structure, ionic strength, sampling, or specific solute-solvent chemistry dominates the question."
version: 1.0.0
---

# Continuum solvation models

## Purpose

Represent solvent identity, continuum model, cavity, state conditions, and gas-versus-solution interpretation explicitly. It supplies scientific constraints and engine-neutral protocol material only; it grants no execution authority.

## Use when

Use this skill when a molecular objective asks for solution-phase structure, energy, thermochemistry, or a solvent effect.

## Do not use alone when

Do not use it alone when explicit solvent structure, ionic strength, sampling, or specific solute-solvent chemistry dominates the question.

## Required inputs

- solvent identity.
- continuum model.
- target property.
- standard-state intent.

## Missing-input behavior

Block solution-phase planning when solvent or physical model is missing; never copy a solvent from an unrelated prior mission.

## Workflow summary

1. Verify exact input and evidence identities.
2. Apply the structured decision rule only inside its declared conditions.
3. Surface unresolved material choices; do not guess them.
4. Emit an attributable protocol fragment and explicit acceptance evidence.

## Scientific decisions

- continuum model.
- solvent parameters.
- equilibrium versus nonequilibrium treatment.
- standard-state interpretation.

## Validation gates

- solvent is explicit.
- physical model is explicit.
- gas and solution interpretations are not mixed silently.

## Common failure modes

Incomplete artifacts, mismatched model identity, unsupported applicability, or a proposed change to an immutable scientific field all fail closed. Operational success alone is not scientific validation.

## Relevant assets

Load `concepts/scope.md` for applicability, `decision-rules/core.yaml` for the decision boundary, and `protocols/core.yaml` for the engine-neutral fragment. Evaluation cases remain test evidence, not prompt authority.

## Limitations and escalation

Continuum solvation omits explicit microscopic solvent structure. Escalate strong specific interactions, mixed solvents, electrolytes, and accuracy claims beyond the declared applicability.
