---
name: brillouin-zone-sampling
id: workflows.brillouin-zone-sampling
version: 1.0.0
description: Converge a weighted k-point integration mesh and metallic smearing for periodic DFT. Separate the SCF mesh, a band path and DOS broadening.
---

# Brillouin zone sampling, k-points and metallic occupations

## Purpose

Converge a weighted k-point integration mesh and metallic smearing for periodic DFT. Separate the SCF mesh, a band path and DOS broadening.

## Use when

A periodic mineral, semiconductor, magnetic solid or surface needs reciprocal-space sampling for energies, forces, stress, density of states or band edges.

## Do not use alone when

Spin-orbit coupling, a correlated insulating state or topology determines the observable. Independently establish the physical Hamiltonian, magnetic structure and specialist validation.

## Required inputs

- lattice vectors, periodic axes and identified comparison cells
- observable with units and numerical tolerance
- electronic regime or a plan to inspect occupations and magnetic solutions
- mesh scheme and shift, occupation model and energy convention

## Missing-input behavior

Ask for the cell, periodic directions and target observable. If the gap or occupations are unknown, defer the metallic versus insulating branch until pilot evidence exists.

## Scientific decisions

In a sequence of similar cells, use comparable reciprocal-space resolution along each periodic vector. For a cell with reciprocal vectors b_i and grid counts N_i, record |b_i|/N_i as a spacing diagnostic. One k-point usually suffices along a vacuum axis decoupled from its images. A large cell in one direction does not imply adequate sampling in the other two.

For a metal at prescribed electronic temperature, use thermal occupations at that temperature and refine the integration mesh and empty-band count while keeping the thermodynamic potential fixed. For a zero-temperature limit using numerical smearing, study decreasing widths on successively denser meshes. Additional unoccupied states may be needed to contain fractional occupations. Document the smearing prescription and distinguish the electronic free energy at fixed electronic temperature, the internal energy, and any extrapolation to zero width. Match energy definitions across all terms of an energy difference. The ionic temperature and plotting width of a DOS have separate meanings.

## Limitations and escalation

Escalate gap closure, order switching with mesh or smearing, strong correlations, or an unavailable solver path in the target build. A converged Kohn–Sham gap provides a model eigenvalue difference. A quasiparticle or optical gap needs separate physical evidence.
