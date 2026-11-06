---
name: solution-redox
id: workflows.solution-redox
version: 1.0.0
description: "Plan an equilibrium molecular reduction potential in solution from balanced redox free energies on a stated reference electrode scale. Use a same-solvent reference couple to cancel the electron convention."
---

# Solution redox potential on a specified reference scale

## Purpose

Plan an equilibrium molecular reduction potential in solution from balanced redox free energies on a stated reference electrode scale. Use a same-solvent reference couple to cancel the electron convention.

## Use when

The task concerns reversible electron transfer between specified molecular oxidation states, with solvent, reference couple, temperature and standard states declared.

## Do not use alone when

Electrode adsorption, kinetic peak shifts, solid-electrolyte interfaces or coupled proton transfer dominate. A change in protonation requires an explicit proton balance and pH or proton chemical potential.

## Required inputs

- Balanced target and reference half-reactions with electron counts, charges and multiplicities
- Temperature, solvent, electrolyte/speciation assumptions, standard states and experimental reference scale
- Geometry, conformer and solvation treatment for each redox state, with an internally consistent free-energy cycle
- Reference potential and its conditions for conversion to an external electrode scale, if requested

## Missing-input behavior

Hold any electrode-referenced value until the reference, solvent, sign and balanced reaction are resolved. A gas-phase electron affinity or a frontier orbital alone cannot supply the missing solution free energy.

## Scientific decisions

For one-electron couples write the full exchange reaction Ox(target) + Red(ref) → Red(target) + Ox(ref). The solution Gibbs energy is the product sum minus the reactant sum. The reduction-potential difference E(target) − E(ref) = −ΔG(exchange)/(nF), where n is the number of moles of electrons exchanged per mole of the balanced full reaction. Balance unequal electron counts before using the formula. A favorable exchange gives a positive potential difference. In J/mol, use F in C/mol for volts.

For an adiabatic potential, relax each charge state and sample relevant conformers. Evaluate all four species in the same solvent and thermal convention. For a gas/solution cycle record G(gas) and ΔG(solvation) with compatible standard states, applying any conversion once. For a direct solution cycle avoid adding solvation to an electronic energy that already includes it. Preserve any chosen absolute-electron convention if using an alternate absolute scale.

## Limitations and escalation

An irreversible voltammetric peak or a potential in another solvent gives a different comparison. Strong ion pairing, a different protonation state or loss of a ligand can change which half-reaction is observed. Escalate these before interpreting a computed shift.

## Evidence and attribution

Inspect `protocols/core.yaml` for the ordered steps, acceptance gates and recovery. Bind source output and geometry digests to each derived value. Read `references/README.md` for the claim supported by each source.
