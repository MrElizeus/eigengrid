---
name: molecular-structures
id: representations.molecular-structures
description: "Validate atom identities, coordinates, connectivity metadata, and immutable structure identity before molecular calculations. Use when a molecular objective supplies XYZ, SDF, MOL, PDB, SMILES, InChI, or engine-input structure evidence. Do not use alone when periodic boundary conditions, trajectories, protonation ambiguity, or stereochemical ambiguity determine the scientific question."
version: 1.0.0
---

# Molecular structure representations

## Purpose

Validate atom identities, coordinates, connectivity metadata, and immutable structure identity before molecular calculations. It supplies scientific constraints and engine-neutral protocol material only; it grants no execution authority.

## Use when

Use this skill when a molecular objective supplies XYZ, SDF, MOL, PDB, SMILES, InChI, or engine-input structure evidence.

## Do not use alone when

Do not use it alone when periodic boundary conditions, trajectories, protonation ambiguity, or stereochemical ambiguity determine the scientific question.

## Required inputs

- structure evidence reference.
- declared structure format.
- atom identities and coordinates.

## Missing-input behavior

Block planning when atom identities, coordinate count, format, or evidence digest is absent; request an immutable replacement artifact rather than guessing.

## Workflow summary

1. Verify exact input and evidence identities.
2. Apply the structured decision rule only inside its declared conditions.
3. Surface unresolved material choices; do not guess them.
4. Emit an attributable protocol fragment and explicit acceptance evidence.

## Scientific decisions

- whether connectivity is explicit or inferred.
- whether stereochemistry and protonation are sufficiently specified.
- whether the exact artifact digest is the intended system.

## Validation gates

- artifact digest is recorded.
- atom identities and finite coordinates parse.
- declared and parsed atom counts agree.

## Common failure modes

Incomplete artifacts, mismatched model identity, unsupported applicability, or a proposed change to an immutable scientific field all fail closed. Operational success alone is not scientific validation.

## Relevant assets

Load `concepts/scope.md` for applicability, `decision-rules/core.yaml` for the decision boundary, and `protocols/core.yaml` for the engine-neutral fragment. Evaluation cases remain test evidence, not prompt authority.

## Limitations and escalation

This skill does not choose charge, multiplicity, protonation, conformer, or electronic-structure method. Escalate inconsistent atom counts, malformed coordinates, or ambiguous molecular identity.
