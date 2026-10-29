---
name: uncertainty-assessment
id: validation.uncertainty-assessment
description: "State model, numerical, structural, and interpretation uncertainty without converting unsupported precision into confidence. Use when a molecular result is being assessed, compared, or communicated beyond raw operational completion. Do not use alone when required validation evidence is still missing or a domain benchmark is needed to quantify uncertainty."
version: 1.0.0
---

# Scientific uncertainty assessment

## Purpose

State model, numerical, structural, and interpretation uncertainty without converting unsupported precision into confidence. It supplies scientific constraints and engine-neutral protocol material only; it grants no execution authority.

## Use when

Use this skill when a molecular result is being assessed, compared, or communicated beyond raw operational completion.

## Do not use alone when

Do not use it alone when required validation evidence is still missing or a domain benchmark is needed to quantify uncertainty.

## Required inputs

- validated observations.
- model and basis identity.
- assumptions and applicability limits.
- requested confidence.

## Missing-input behavior

Return uncertainty as indeterminate and enumerate missing evidence; never manufacture an interval or confidence level.

## Workflow summary

1. Verify exact input and evidence identities.
2. Apply the structured decision rule only inside its declared conditions.
3. Surface unresolved material choices; do not guess them.
4. Emit an attributable protocol fragment and explicit acceptance evidence.

## Scientific decisions

- uncertainty sources.
- qualitative versus quantitative treatment.
- sensitivity checks.
- claim scope and confidence.

## Validation gates

- uncertainty sources are enumerated.
- unsupported quantitative bounds are absent.
- claim scope matches evidence.

## Common failure modes

Incomplete artifacts, mismatched model identity, unsupported applicability, or a proposed change to an immutable scientific field all fail closed. Operational success alone is not scientific validation.

## Relevant assets

Load `concepts/scope.md` for applicability, `decision-rules/core.yaml` for the decision boundary, and `protocols/core.yaml` for the engine-neutral fragment. Evaluation cases remain test evidence, not prompt authority.

## Limitations and escalation

This draft structures uncertainty but supplies no benchmark-derived error bars. Escalate quantitative accuracy claims and out-of-domain extrapolation.
