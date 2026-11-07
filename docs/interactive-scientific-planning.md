# Interactive scientific planning

Start `/plan <objective and known inputs>` in the operator TUI. `/plan` alone uses
the current conversation. The configured model researches relevant installed
protocols, follows their dependencies and fragment pages, asks for consequential
missing choices, and proposes a detailed campaign. Protocols remain subject to
their existing scientific review and site qualification requirements.

Planning remains active for subsequent messages, including `/agent` messages.
The footer identifies this mode. `/plan off` returns to ordinary operator mode;
it does not execute the proposed campaign. Execution commands such as `/submit`
are unavailable while planning, even with the Full Access preset.

## Questions and revisions

Questions offer explanations, an optional justified recommendation and a free-text
answer. Use the arrow keys and Enter to select an option, or choose **Other**.
PgUp/PgDn scroll long descriptions. A recommendation is never submitted without
an answer. Escape cancels the current turn without inventing an answer; planning
mode remains active so the conversation can continue.

The question bridge follows the host-mediated question/answer pattern in Codex's
open-source [request_user_input handler](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/request_user_input.rs)
and [question schema](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/request_user_input_spec.rs).
EigenGrid uses its own native agent runtime; this does not add a Codex dependency.

The proposal includes assumptions, scientific decisions and alternatives, exact
protocol references, stages and dependencies, inputs and outputs, parameters,
resource estimates, acceptance criteria, recovery, risks and remaining gaps.
The full proposal is displayed in the conversation. Follow-up requests revise the
same plan and retain earlier immutable revisions in `.eigengrid/plans.jsonl`.
Question answers and tool observations remain in the planning conversation.
Long proposals can be assembled section by section within the configured response
token limit. Working sections become a durable revision only after the complete
proposal passes validation; an unfinished draft is not reported as a saved plan.

A plan digest identifies its contents. It is not an execution authorization,
scientific approval, validation result or evidence that a calculation ran.

## Source acquisition

Planning supports public RCSB structure search and bounded HTTPS acquisition of
structures, ligands, metadata and documents from public sources. The model has no
raw shell, SSH, Slurm, installation or simulation execution tool in this mode.
Existing operator file restrictions still apply to ordinary file inspection.

Acquired files live under a private, session-owned directory in
`.eigengrid/planning-assets/`. Each has a JSON receipt with original and final URL,
time, size, SHA-256 and basic content observations. Model arguments cannot choose
an output path or overwrite original inputs. Downloads are limited to 20 MiB per
file, 30 files per planning session, 30 seconds and five redirects. Credentials,
cookies and ambient authentication are not sent. Private network addresses and
credential-bearing URLs are rejected; public addresses are pinned per request.

Text assets can be read in bounded pages, with their digest checked again. PDB
inspection reports coordinate records, chains and hetero-residue names; these
observations do not certify the biological assembly, ligand identity or chemical
readiness. A protein alone must not be substituted silently for a requested
protein–ligand complex. PDFs are retained with provenance, but PDF text extraction
is currently unavailable in the planning tool set. The model must use an available
text version or report this evidence gap.

These local files, plan revisions and private protocol contents are not release
assets and must not be copied into a public repository. Provider requests use the
configured model connection and include the authorized scientific context needed
for the user's task.

## CLI and automation

`eigengrid plan "<objective>"` uses the same planner and offers numbered questions
in an interactive terminal. `--plan-id <id>` revises an existing proposal.
`--json` never opens interactive questions: it returns `status: "needs-input"`
with structured questions when an answer is required. Supply that information in
a subsequent request, or use the TUI for an ongoing interactive session.

Successful JSON output preserves the `ScientificPlanArtifact` envelope. Incomplete
results contain `status`, `response`, and, when available, `artifact` and
`questions`. Exit status 2 indicates a missing answer or incomplete proposal.
Inference failures do not create an empty placeholder plan. Planning inference is
bounded to 32 model rounds per turn, including a final answer round.

## Recoverable command failures outside planning

Ordinary operator mode retains permission-gated `run-command`. Missing
executables, nonzero exits, signals and timeouts now return observed diagnostics
to the model instead of being reported as successful commands or invalid journal
values. The agent can inspect an alternative, such as `python3` when `python` is
absent. After a timeout or signal it must inspect partial effects before retrying;
genuinely unconfirmed effects still require authoritative reconciliation.

For molecular visualization on a headless host, the agent should inspect available
renderers, save and verify the output, and distinguish a basic projection from a
molecular cartoon or a scientific analysis. Installing a graphics dependency is
not an automatic prerequisite when existing tools can produce the requested view.
