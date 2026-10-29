---
name: resource-estimation
id: foundations.resource-estimation
description: "Estimate bounded cores, memory, scratch, and wall time from declared workload features without changing scientific assumptions. Use when a typed work unit needs local resource bounds or a feasibility check before dispatch. Do not use alone when method or basis selection is still unresolved, or an estimate would be presented as a guaranteed runtime."
version: 1.0.0
---

# Scientific resource estimation

## Purpose

Estimate bounded cores, memory, scratch, and wall time from declared workload features without changing scientific assumptions. It supplies scientific constraints and engine-neutral protocol material only; it grants no execution authority.

## Use when

Use this skill when a typed work unit needs local resource bounds or a feasibility check before dispatch.

## Do not use alone when

Do not use it alone when method or basis selection is still unresolved, or an estimate would be presented as a guaranteed runtime.

## Required inputs

- atom count.
- method family.
- basis size or workload class.
- calculation kind.

## Missing-input behavior

Return an explicit unknown estimate with the missing workload features; never invent a precise wall time or memory value.

## Workflow summary

1. Verify exact input and evidence identities.
2. Apply the structured decision rule only inside its declared conditions.
3. Surface unresolved material choices; do not guess them.
4. Emit an attributable protocol fragment and explicit acceptance evidence.

## Scientific decisions

- resource class.
- core and memory bounds.
- wall-time budget.
- whether the proposed workload exceeds the environment profile.

## Validation gates

- assumptions are explicit.
- requested resources fit the capability profile.
- uncertainty is not presented as a guarantee.

## Common failure modes

Incomplete artifacts, mismatched model identity, unsupported applicability, or a proposed change to an immutable scientific field all fail closed. Operational success alone is not scientific validation.

## Relevant assets

Load `concepts/scope.md` for applicability, `decision-rules/core.yaml` for the decision boundary, and `protocols/core.yaml` for the engine-neutral fragment. Evaluation cases remain test evidence, not prompt authority.

## Limitations and escalation

Estimates are coarse planning aids, not benchmarks or execution guarantees. Escalate out-of-profile systems and retain the approved scientific protocol unchanged.
