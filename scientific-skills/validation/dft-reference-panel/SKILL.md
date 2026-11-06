---
name: dft-reference-panel
id: validation.dft-reference-panel
version: 1.0.0
description: "Design an independent benchmark panel, measure systematic bias and failed cases, and assess a DFT observable against a prespecified error budget."
---

# DFT reference panel

## Purpose

Define a falsifiable test of either implementation precision at fixed physics or predictive accuracy for a specified chemical observable. Record which claim is under test.

## Use when

An operator wants to qualify a new engine installation, select between approximations, or judge whether an energy difference is resolved well enough to support a scientific decision.

## Do not use alone when

The observable needs assignment first. A barrier requires the correct saddle and endpoints, an excitation requires the correct electronic state, and a solid requires the same phase, cell convention and magnetic state as the reference.

## Required inputs

Define the population of systems, target quantity, units, geometry and environmental conventions, reference source and revision, uncertainty and maximum acceptable error per observable.

## Missing-input behavior

Withhold a scientific pass until the reference identity, model correspondence and error budget are established. Record an unquantified uncertainty explicitly.

## Scientific decisions

Choose the reference by property. Main-group gas-phase reaction energies, vertical molecular excitations and same-functional crystal equation-of-state curves test different claims. Inspect the protocol fragment for the comparison procedure and the references asset for the primary datasets.

## Limitations and escalation

A sparse pilot may expose an error but cannot establish transferability. Changing the method after inspecting a held-out result moves that case into development. Record a fresh independent test set for the revised claim.
