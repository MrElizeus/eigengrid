---
name: nics-tensor-scans
id: workflows.nics-tensor-scans
version: 1.0.0
description: "Plan NICS(0), NICS(1), normal-height scans and lateral NICS-XY profiles for magnetic aromaticity. Recover the normal component of a shielding tensor in a rotated ring frame."
---

# NICS tensor scans

## Purpose

At a point without a nucleus, NICS is the negative of the calculated magnetic shielding, expressed in ppm. A scan describes how the induced field varies in space. The component along the ring normal probes the response to a field along that normal. Keep the original Cartesian tensor for each point.

## Use when

A specified closed-shell molecular ground state has a planar ring, or a local plane can be defended with a reported fit. Examples include distinguishing face-dependent shielding above a substituted ring and testing competing local and peripheral circuits in fused rings.

## Do not use alone when

A study needs current strengths in nA/T, an unambiguous current pathway in a fused system, an energetic stabilization or an experimental chemical shift at a real nucleus. For the first two objectives retrieve a current-density integration workflow. Open-shell response, strong multireference character and highly puckered rings require a separately qualified method or frame.

## Required inputs

- Original atom-indexed coordinates, units, real atom count, electronic state and molecular model.
- Ring atom set, center convention, two in-plane directions or a reproducible plane fit, and a side-label convention.
- Probe paths, heights, grid spacing, response method, gauge and an error budget for the profile.

## Missing-input behavior

An isotropic value supplies only the trace. A list of principal values without their axes does not determine the normal projection. Request full tensors and the engine's coordinate frame. A NICS value alone is insufficient evidence to assign a current strength or rank aromaticity ring by ring.

## Scientific decisions

For a ring normal **n** of unit length, compute NICS⊥ = −**n**ᵀσ**n**. NICSiso = −tr(σ)/3. Specify which one is reported for every height. A label such as NICS(1) states where the probe is located and needs a tensor-component label as well. A bare zz component is valid for NICS⊥ only when the output z axis coincides with the ring normal up to sign.

Use separate signed heights along the normal for a height scan. For NICS-XY vary the position along a defined in-plane path while holding the perpendicular offset fixed. The 1.7 Å height used in the original NICS-XY study was tested on its planar conjugated systems. Choose and test the offset when transferring the method. Total shielding can contain core, σ, lone-pair and neighboring-ring contributions. A π-only label requires an explicit decomposition and identification of the included subspace.

## Limitations and escalation

A negative value indicates shielding of that component at that point. Multiple current circuits can contribute to the same value. Check another path or height, a strained or nonconjugated control where relevant, and the underlying current density if alternative assignments persist. Report the unresolved alternatives.

## Assets

Inspect the default procedure and validation controls before accepting a profile. The validation assets include an off-axis algebra test, a three-height benzene calculation and a link to its runnable PySCF example. The ORCA mapping documents engine-specific probe handling. Source notes identify the originating study behind each choice.
