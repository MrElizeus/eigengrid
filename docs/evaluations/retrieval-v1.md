# Scientific retrieval: exploratory v1 evaluation

Measured on 2026-11-06 using the public 31-module catalog (492 canonical fragments,
566 derived windows), Linux x86_64, Bun 1.3.14 and an Intel Core i5-11600KF
(12 logical CPUs). ONNX inference used two CPU threads. Other repository verification
was running concurrently; these timings are observations, not a cluster service-level target.

The experiment has 25 authored English/Spanish cases, k=5, three repetitions per mode,
a 24,000-character context budget and at most 64 fragments. Labels are exploratory
engineering judgments. They are neither independently reviewed nor a held-out scientific
benchmark. AMBER and live-node requests are negative controls for this public corpus.

The optional model is `Xenova/multilingual-e5-small` at revision
`761b726dd34fb83930e26aab4e9ac3899aa1fa78`, quantized ONNX, 384 dimensions.
Runtime versions: onnxruntime 1.23.2, tokenizers 0.22.1, numpy 2.3.5.
Weights, tokenizer, pooling and prefixes are pinned in
[the example manifest](../../examples/retrieval/multilingual-e5-small.json).

| Configuration    | Recall@5 | nDCG@5 | Exact ID success | Top-rank error proxy | p50 ms | p95 ms |
| ---------------- | -------: | -----: | ---------------: | -------------------: | -----: | -----: |
| `legacy_lexical` |    0.975 |  0.945 |             100% |                  32% |    3.4 |    4.3 |
| `lexical`        |    0.975 |  0.949 |             100% |                  32% |   30.1 |   36.9 |
| `vector`         |    0.975 |  0.919 |             100% |                  36% |   86.4 |  100.1 |
| `hybrid`         |    1.000 |  0.979 |             100% |                  28% |   83.8 |   89.9 |
| `scientific`     |    1.000 |  0.979 |             100% |                  28% |   85.0 |   93.2 |

The error proxy counts a nonrelevant/incompatible first result or any hit on a case
requiring abstention. It evaluates rankings, not the agent's confirmed decisions.
The agent can decline automatic selection when retrieval is ambiguous. The residual
28% error proxy is a reason to keep hybrid retrieval opt-in, even though it improves
over the baseline. Exact-ID inspection of a known incompatible protocol is counted as
a ranking error by this conservative proxy; it still carries incompatibility reasons
and cannot yield an applicable context.

For `scientific` mode, labeled required-dependency coverage was 100%;
there were 0 omissions of the explicitly annotated critical fragments.
Mean context size was approximately 3507 tokens using characters/4.
This is not a tokenizer count and excludes metadata/citation wrappers.
Context statuses across the 25 distinct cases: ambiguous=6, budget_insufficient=2, complete=17.
An ambiguous or empty context does not silently select a procedure.

All three vector configurations used the actual local model with zero lexical fallbacks.
p50/p95 cover sequential searches after the initial catalog snapshot, including index
validation and query inference. Scientific-mode timing also includes context assembly.
The first vector query includes worker startup; subsequent closely spaced queries reuse
the worker. Interactive searches after its one-second idle shutdown incur startup again.
The full JSON report includes every latency sample, so a cold-start outlier is not
represented adequately by the p95 alone.

All five mechanical gates in this small suite passed: actual vectors, exact lookup
non-regression, lower ranking-error proxy, labeled dependency coverage and annotated
critical-fragment coverage. Independent label review, agent-decision evaluation and
installation-specific testing remain outstanding. `enableHybridByDefault` remains false.

## Case-level audit

The table shows the first result from the previous lexical implementation and from
the scientific pipeline, plus the scientific context status (first repetition).

| Case                   | Previous lexical first result        | Scientific first result              | Context               |
| ---------------------- | ------------------------------------ | ------------------------------------ | --------------------- |
| `exact-gimic`          | `workflows.gimic-ring-currents`      | `workflows.gimic-ring-currents`      | `complete`            |
| `exact-geometry`       | `workflows.geometry-optimization`    | `workflows.geometry-optimization`    | `complete`            |
| `exact-cp2k`           | `methods.cp2k-gpw-convergence`       | `methods.cp2k-gpw-convergence`       | `complete`            |
| `exact-nmr`            | `workflows.nmr-chemical-shifts`      | `workflows.nmr-chemical-shifts`      | `complete`            |
| `technical-cutoff`     | `methods.cp2k-gpw-convergence`       | `methods.cp2k-gpw-convergence`       | `complete`            |
| `technical-xdens`      | `workflows.gimic-ring-currents`      | `workflows.gimic-ring-currents`      | `complete`            |
| `technical-nicszz`     | `workflows.nics-tensor-scans`        | `workflows.nics-tensor-scans`        | `complete`            |
| `conceptual-currents`  | `workflows.gimic-ring-currents`      | `workflows.gimic-ring-currents`      | `ambiguous`           |
| `conceptual-flux`      | `workflows.nics-tensor-scans`        | `workflows.gimic-ring-currents`      | `complete`            |
| `aromaticity-scope`    | `workflows.nics-tensor-scans`        | `workflows.nics-tensor-scans`        | `ambiguous`           |
| `nmr-reference`        | `workflows.nmr-chemical-shifts`      | `workflows.nmr-chemical-shifts`      | `complete`            |
| `nmr-ensemble`         | `workflows.nmr-chemical-shifts`      | `workflows.nmr-chemical-shifts`      | `complete`            |
| `imaginary-mode`       | `diagnostics.imaginary-frequencies`  | `diagnostics.imaginary-frequencies`  | `budget_insufficient` |
| `ghost-missing`        | `workflows.counterpoise-interaction` | `workflows.counterpoise-interaction` | `complete`            |
| `redox-reference`      | `workflows.solution-redox`           | `workflows.solution-redox`           | `budget_insufficient` |
| `excited-band`         | `workflows.tddft-absorption`         | `workflows.tddft-absorption`         | `complete`            |
| `spin-contamination`   | `diagnostics.scf-nonconvergence`     | `diagnostics.scf-nonconvergence`     | `complete`            |
| `cluster-preflight`    | `workflows.dft-cluster-preflight`    | `workflows.dft-cluster-preflight`    | `complete`            |
| `cluster-preflight-es` | `workflows.dft-cluster-preflight`    | `workflows.dft-cluster-preflight`    | `complete`            |
| `amber-absent`         | `methods.dft-functional-selection`   | `workflows.transition-state-irc`     | `ambiguous`           |
| `amber-absent-es`      | `methods.molecular-dft`              | `methods.molecular-dft`              | `ambiguous`           |
| `live-installation`    | `workflows.dft-cluster-preflight`    | `workflows.nmr-chemical-shifts`      | `ambiguous`           |
| `live-allocation`      | `workflows.dft-cluster-preflight`    | `workflows.dft-cluster-preflight`    | `complete`            |
| `adversarial-engine`   | `workflows.gimic-ring-currents`      | `workflows.gimic-ring-currents`      | `ambiguous`           |
| `adversarial-review`   | `workflows.gimic-ring-currents`      | `workflows.gimic-ring-currents`      | `complete`            |

## Reproduction and identities

- Corpus digest: `99b8e914bc80ee9334b9a2281a9a7beaa4e928bdc130f7179c42f032187ad5ea`.
- Parsed-case digest (including schema defaults): `d88d9c78975815119f093f0278ef61f8ec4ace94e42fb9268751171b95ea4e5b`.
- Embedding configuration digest: `e21a910ac131b389328e47bd87f9cb7845da7fea4869458ab5bf561bccf0609c`.
- The scope digest additionally binds the local actor and catalog paths; it changes
  when the same corpus is installed elsewhere. It is not a scientific corpus identity.

Follow the [local setup and evaluation commands](../scientific-retrieval.md#evaluation-and-rollout).
The authored cases are in
[retrieval-v1.jsonl](../../packages/scientific-retrieval/evals/retrieval-v1.jsonl).
Keep the full generated JSON report as a local/CI artifact rather than adding machine
output or model weights to the source repository.

An initial pilot used CP2K 2024.1.0 for a positive convergence case, although the
canonical manifest explicitly supports 2025.1.0–2026.x. The applicability check correctly
rejected that version. The positive label now uses 2025.1.0; the incompatible-engine
control remains separate. This correction is another reason these cases are exploratory
rather than an independently frozen scientific benchmark. No protocol was changed.

The present measurements do not establish performance for a private AMBER catalog,
a deployment with hundreds of modules, an LLM decision policy or live Slurm operations.
They establish that the optional local pipeline can be measured and audited while
preserving canonical authority and fallback behavior.
