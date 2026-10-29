---
name: dispersion
id: methods.dispersion
description: "Make dispersion treatment and its compatibility with the base molecular method an explicit scientific decision. Use when noncovalent interactions, conformations, weak binding, or geometries may depend on long-range dispersion. Do not use alone when a selected method already includes a declared dispersion treatment or the target domain is periodic and needs a periodic-specific skill."
version: 1.0.0
---

# Dispersion treatment

## Purpose

Make dispersion treatment and its compatibility with the base molecular method an explicit scientific decision. It supplies scientific constraints and engine-neutral protocol material only; it grants no execution authority.

## Use when

Use this skill when noncovalent interactions, conformations, weak binding, or geometries may depend on long-range dispersion.

## Do not use alone when

Do not use it alone when a selected method already includes a declared dispersion treatment or the target domain is periodic and needs a periodic-specific skill.

## Required inputs

- base method.
- target property.
- interaction regime.

## Missing-input behavior

Record dispersion treatment as unresolved and block a claim that depends on weak interactions; do not append a correction implicitly.

## Workflow summary

1. Verify exact input and evidence identities.
2. Apply the structured decision rule only inside its declared conditions.
3. Surface unresolved material choices; do not guess them.
4. Emit an attributable protocol fragment and explicit acceptance evidence.

## Scientific decisions

- whether explicit dispersion is required.
- compatible dispersion family.
- whether damping and parametrization match the base method.

## Validation gates

- dispersion choice is explicit.
- compatibility is checked.
- absence is justified when scientifically relevant.

## Common failure modes

Incomplete artifacts, mismatched model identity, unsupported applicability, or a proposed change to an immutable scientific field all fail closed. Operational success alone is not scientific validation.

## Relevant assets

Load `concepts/scope.md` for applicability, `decision-rules/core.yaml` for the decision boundary, and `protocols/core.yaml` for the engine-neutral fragment. Evaluation cases remain test evidence, not prompt authority.

## Limitations and escalation

This draft does not certify a particular correction for a domain. Escalate unsupported combinations, metallic systems, and benchmark-level accuracy claims.
