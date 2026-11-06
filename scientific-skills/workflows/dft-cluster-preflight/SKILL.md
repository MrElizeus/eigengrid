---
name: dft-cluster-preflight
id: workflows.dft-cluster-preflight
description: "Plan a Slurm batch allocation preflight, scratch staging, MPI binding, GPU visibility and checkpoint recovery for a DFT engine."
version: 1.0.0
---

# DFT cluster preflight

## Purpose

Produce a readiness record for a specific engine build, input family and allocation. Distinguish scheduler reachability, allocated resources, engine startup and a successful scientific pilot. Record each as observed, failed or unknown.

## Use when

A DFT calculation will move from a login session to a batch node, switch partitions, scale ranks or resume from a checkpoint. Request the preflight alongside the scientific protocol when the result will inform a cluster plan.

## Do not use alone when

The study needs a new functional, basis, pseudopotential, state assignment or convergence criterion. Use the relevant scientific protocol for that choice.

## Required inputs

Identify the planned observable and units, input digest, target engine and build, site-approved allocation class, data staging route, resource limits and pilot tolerance.

## Missing-input behavior

Report the missing check and its scope. An absent command in a login shell, or a device query outside a GPU allocation, leaves the target capability unknown.

## Scientific decisions

Use an approved small representative case with a reference observable. Record parallel layout and numerical settings. If a different layout changes the target beyond tolerance, retain both outputs and investigate reproducibility before increasing the campaign size.

## Limitations and escalation

A short pilot qualifies only its recorded stack and input family. A scheduler upgrade, changed library or new device can require a new probe. Refer failed accounting, inaccessible storage or a mismatched executable to the site owner. Consult the exact executable adapter and site admission policy before dispatch.
