# DFT protocols for the operator

These 13 versioned modules extend the 15 foundational entries. Each new module starts at
`1.0.0` and declares `draft`, `unreviewed`, and planning capability. Version identifies
the text and dependencies. Scientific qualification requires independent evidence for the
target system and observable.

| Protocol ID                                | Decision or deliverable                                                                                                             |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `methods.dft-functional-selection`         | Compare candidate approximations against chemically matched evidence; record dispersion and avoid adding corrections twice.         |
| `workflows.molecular-basis-convergence`    | Test orbital basis, diffuse functions, ECP and auxiliary-basis coverage against the target observable.                              |
| `diagnostics.dft-electronic-state-audit`   | Compare plausible states, occupations and spin diagnostics. Identify when a converged determinant leaves the assignment unresolved. |
| `workflows.solution-conformer-free-energy` | Build a solvated conformer ensemble, account for degeneracy and low modes, and apply a consistent standard state.                   |
| `workflows.transition-state-irc`           | Inspect the unstable mode and trace both directions to identified minima before assigning a barrier.                                |
| `workflows.tddft-absorption`               | Assign vertical transitions using state character and intensity. Check charge-transfer, diffuse and double-excitation limitations.  |
| `workflows.counterpoise-interaction`       | Reconstruct raw and counterpoise-corrected frozen dimer interactions and quantify basis sensitivity.                                |
| `workflows.solution-redox`                 | Balance a solution-phase thermodynamic cycle and assign the sign, electron count and electrode reference.                           |
| `methods.periodic-boundaries`              | Select cell, electrostatic boundary conditions and image checks for a bulk system, surface or isolated object.                      |
| `methods.cp2k-gpw-convergence`             | Converge the Gaussian basis and auxiliary multigrid in Quickstep against energies, forces or stress.                                |
| `workflows.brillouin-zone-sampling`        | Converge k-space integration and occupations; distinguish an integration mesh from a band path.                                     |
| `workflows.dft-cluster-preflight`          | Establish batch environment, staging and launch evidence, pilot budget and recovery conditions.                                     |
| `validation.dft-reference-panel`           | Freeze reference identities, physical conventions, independent comparisons and per-property error criteria before a benchmark.      |

## How the agent uses a protocol

1. Search with `list-protocols` using short terms or an exact ID. The inventory describes the catalog loaded by this process. An exact engine filter returns explicit engine declarations. For general boundary, sampling, reference or cluster guidance, search by ID or domain without that filter.
2. Inspect the returned ID and version with `inspect-protocol`. Select `protocols` for the procedure and `references` for claim-specific primary literature and manual sections. For a composite plan request `includeDependencies: true`. Pin the returned corpus digest and keep the same arguments across cursor pages until `nextCursor` is null.
3. Record the exact module versions, fragment digests, chosen model, missing inputs and blocking conditions. The mission planner resolves a versioned dependency graph and selects bounded, attributable fragments. Retrieved text can support a proposed decision. Dispatch depends on the separately supported engine adapter, site profile and approvals.

## On a cluster

Try these prompts in the operator. The acceptance column describes the expected reasoning in a live model trial. The automated corpus checks exercise retrieval and composition.

| Operator prompt                                                                                              | Evidence to look for in the response                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| “CP2K finished my slab calculation. Energy looks stable at one cutoff. Can I publish the adsorption energy?” | Identify the electrostatic boundary, slab/vacuum convergence and reference energies. Ask for a convergence table of the adsorption-energy difference, independent basis/grid tests and reciprocal-space sampling. |
| “The parallel DFT job disappeared after submission. Another partition sees a GPU. Retry there?”              | Reconcile the original submission, verify durable outputs and checkpoint identity, then establish separate allocation, build and pilot evidence for the proposed partition.                                       |
| “Tengo una frecuencia imaginaria. ¿Ya puedo reportar la barrera?”                                            | Check that the mode follows the proposed reaction, both path directions reach the intended endpoints and consistent energy or free-energy conventions were used.                                                  |
| “Mi dímero tiene dos energías monoméricas, pero una geometría se reoptimizó. Calcula el BSSE.”               | Require fixed dimer geometry and the correctly labeled monomer terms with and without ghost centers before reporting an interaction.                                                                              |
| “¿Qué potencial tiene este ligando si solo te doy el LUMO?”                                                  | Request a balanced couple, oxidation states, environment and reference scale. The orbital energy alone is insufficient for a solution reduction potential.                                                        |

With an external catalog, `EIGENGRID_SCIENTIFIC_SKILLS_ROOT` selects the **entire** root.
To make these entries available alongside site knowledge, prepare a new version of the
site catalog, preserve the base modules they depend on, and compare same-ID/version
content digests before promotion. Resolve collisions as explicit catalog revisions.
Verify the expected IDs, dependencies and digests from a fresh operator process in the
intended environment. [Catalog selection](catalogs.md) · [Slurm inventory](cluster.md)

## Reproducing the software checks

From a checkout with locked dependencies installed:

```bash
bun test packages/scientific-skills/src/scientific-skills.test.ts apps/cli/src/agent/scientific-catalog-tools.test.ts
python scripts/release/scan.py --public .
```

For a scientific evaluation, first pin a relevant primary dataset entry, geometry, reference
quantity, units and uncertainty. Compare predictions from an approved engine at the site
with the frozen tolerances. Record all attempted cases and retain their raw artifacts.
`validation.dft-reference-panel` documents comparisons for molecular relative energies,
vertical excitations and periodic equations of state.
