---
name: periodic-boundaries
id: methods.periodic-boundaries
version: 1.0.0
description: Choose periodic axes, electrostatic boundary conditions and image-size checks for bulk crystals, slabs, isolated molecules in cells and charged defects.
---

# Periodic DFT boundaries for crystals, slabs and isolated cells

## Purpose

Choose periodic axes, electrostatic boundary conditions and image-size checks for bulk crystals, slabs, isolated molecules in cells and charged defects.

## Use when

When a simulation cell encloses an extended system or a finite object and the target is a bulk, surface, defect or isolated-system property.

## Do not use alone when

A charged slab represents an electrode at a specified potential, a defect changes charge state, or long-range polarization crosses the cell. Define the reservoir and electrostatic reference with a specialist before comparing energies.

## Required inputs

- cell vectors, units, atomic coordinates and their Cartesian or fractional convention
- physical dimensionality, repeated directions and composition
- net charge, electronic state or magnetic order, and compensation model if charged
- observable, comparison states and target precision with units

## Missing-input behavior

Ask for the physical geometry and charge model before choosing periodicity. Withhold energy comparisons until the electrostatic reference and finite-size controls are defined.

## Scientific decisions

A bulk crystal repeats in three directions. For an adsorbate on a slab, identify the surface normal, termination, slab thickness, adsorbate count and lateral area. Enlarging only the vacuum leaves lateral adsorbate coverage fixed. For a localized object, make density decay at the cell faces a testable condition. Map geometry and electrostatics independently and check that any intentional difference has a documented physical justification.

For a neutral asymmetric slab repeated normal to its faces, a surface dipole can induce a spurious vacuum field. Compare a suitable open-boundary solver or a justified dipole correction against increasing vacuum and inspect the planar-averaged potential. A charged slab or a biased interface requires a separate compensation and potential-reference model. Freysoldt-type bulk-defect corrections assume dielectric screening and a localized charge perturbation. See the scope of each treatment in `references/README.md`.

## Limitations and escalation

Escalate charged, polar or metallic interfaces with ill-defined countercharge, screening or reference potential. Report size dependence where the chosen model has no demonstrated plateau.
