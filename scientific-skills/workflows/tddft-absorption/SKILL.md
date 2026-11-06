---
name: tddft-absorption
id: workflows.tddft-absorption
version: 1.0.0
description: "Plan vertical molecular electronic absorption by linear-response time-dependent DFT (TDDFT) or TDA. Assign a UV-visible band using excitation energy, oscillator strength and electronic character."
---

# TDDFT vertical UV-visible absorption

## Purpose

Plan vertical molecular electronic absorption by linear-response time-dependent DFT (TDDFT) or TDA. Assign a UV-visible band using excitation energy, oscillator strength and electronic character.

## Use when

A ground-state molecular ensemble and the absorption window are defined. The task seeks vertical valence, charge-transfer or diffuse Rydberg candidates.

## Do not use alone when

The observable is emission, a 0–0 line, a vibronic envelope, a solid-state spectrum, near-degenerate photochemistry or a state dominated by double excitations.

## Required inputs

- Ground-state geometry or weighted ensemble, electronic state and converged reference orbitals
- Target energy or wavelength interval, units, spin manifold and desired resolution
- Functional, basis, response approximation and solvent/environment response appropriate to vertical excitation

## Missing-input behavior

Ask for the spectral window, sample conditions or reference state if missing. Leave upper-window coverage and assignments open if the root spectrum or state-character evidence is incomplete.

## Scientific decisions

For absorption keep nuclei fixed at the ground-state geometry. For a continuum solvent distinguish the slow polarization equilibrated to that ground state from the fast polarization that can respond during excitation. Record whether the implementation supports the selected response. Keep dark roots when comparing assignments. Use transition-density or natural transition orbital (NTO) character and weights to track a state across methods, conformers and a change in root ordering.

A small excitation energy can reflect spurious stabilization of long-range charge transfer. Test a justified range-separated approximation and basis sensitivity. Diffuse virtual orbitals need a check with extra diffuse functions. A visually convincing broadened peak cannot repair an unconverged or qualitatively wrong root.

## Limitations and escalation

Flag strong doubles or severe multireference character for a method with an appropriate excitation manifold. Standard adiabatic linear-response TDDFT can miss states entirely. TDA changes the response approximation and does not by itself resolve long-range charge transfer or restore missing double excitations.

## Evidence and attribution

Inspect `protocols/core.yaml` for the ordered steps, acceptance gates and recovery. Bind source output and geometry digests to each derived value. Read `references/README.md` for the claim supported by each source.
