---
name: counterpoise-interaction
id: workflows.counterpoise-interaction
version: 1.0.0
description: "Compute a gas-phase frozen-dimer electronic interaction energy with atom-centered basis functions and quantify basis set superposition error (BSSE) using Boys\u2013Bernardi counterpoise."
---

# Dimer interaction energy, basis set superposition error (BSSE) and counterpoise

## Purpose

Compute a gas-phase frozen-dimer electronic interaction energy with atom-centered basis functions and quantify basis set superposition error (BSSE) using Boys–Bernardi counterpoise.

## Use when

Two noncovalently associated, chemically defined fragments A and B have a fixed dimer geometry and a consistent localized basis model.

## Do not use alone when

Fragments cleave covalent bonds, have unresolved charge/spin localization, or the target is periodic adsorption or a solution association free energy.

## Required inputs

- Exact dimer coordinates, atom-to-fragment map, and fragment charge and spin states
- Dimer charge and spin coupling compatible with both fragments
- Method, orbital/auxiliary basis, dispersion treatment, numerical thresholds and basis-sensitivity criterion

## Missing-input behavior

Request the fragment states, atom mapping or model details before taking energy differences. Keep a partially completed fragment set as incomplete evidence.

## Scientific decisions

At the same geometry let E(X;Y) denote the energy of X using the basis centers of Y. Compute E(raw) = E(AB;AB) − E(A;A) − E(B;B) and E(CP) = E(AB;AB) − E(A;AB) − E(B;AB). The two ghost calculations add basis functions at the absent partner's coordinates without its nuclei or electrons. Negative interaction energy denotes stabilization under this convention.

Keep full precision until subtraction. Store the raw value, CP value and signed difference CP − raw. If the target uses relaxed monomers, add the separately evaluated distortion costs E(A at complex geometry) − E(A relaxed) and the analogous B term with the stated convention. A binding free energy also requires ensemble, solvent and standard-state terms.

## Limitations and escalation

Check a larger compatible basis. If the sign or ranking changes on that test, report the unresolved range. A composite method with a built-in geometrical counterpoise model requires separate justification before adding Boys–Bernardi terms.

## Evidence and attribution

Inspect `protocols/core.yaml` for the ordered steps, acceptance gates and recovery. Bind source output and geometry digests to each derived value. Read `references/README.md` for the claim supported by each source.
