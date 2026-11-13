# Scientific qualification and catalog inventory

An installed catalog is knowledge, not evidence that a computational method is
available, licensed, correct, or approved. Treat each exact protocol version and
execution environment separately. Never infer acceptance for another input,
method, engine version, node, or observable from a successful smoke test.

## Inventory

Run `python3 scripts/qualification/catalog_inventory.py ROOT --output PRIVATE_NEW_FILE`
with Python 3 and PyYAML installed. The output contains catalog identities, domains,
file names and hashes and can expose private research information. Keep it outside
Git and public build artifacts, in a protected directory. The file is created
exclusively with mode 0600. The command does not change the catalog. It rejects
symlinks, duplicate identities and unrecognized manifest schemas. It enumerates
all files and hashes the canonical JSON listing of their relative paths and hashes.
This snapshot digest is **not** the application's corpus digest. Capture the latter
separately via the installed CLI and preserve both. Run against an immutable or
quiescent catalog; this tool does not provide an atomic filesystem snapshot or
validate dependency closure, scientific content, permissions or loader semantics.

The per-version table records declared capabilities exactly as provided, and
separate unassessed fields for implementation, target-node engine, license, parser,
end-to-end operation and scientific acceptance. Populate these only with linked,
reviewed evidence. An empty declaration or an unassessed field is not a finding
that no implementation exists. Check declared version constraints against the exact
installed engine; a path or a module file alone does not establish availability on
compute nodes or the user's license entitlement.

## Evidence required for an acceptance decision

Before execution, freeze the exact catalog and protocol version, release commit,
site policy and configuration digests, engine build and executable hashes, node and
scheduler versions, fixture inputs and hashes, resource limits, seeds, reference,
units, observable, tolerance and failure conditions. Record who approved the test
plan and why the reference and tolerance fit the intended claim. Preserve the job
ID, exit status, input and output hashes, raw logs, numerical observations, parser
version, deviations, reviewer and decision in access-controlled storage. A failed,
missing, incomplete or unreviewed result stays failed or pending, never accepted
by default. Reassess when an identity relevant to the claim changes.

Use separate states for catalog review, implementation support, site operation,
numerical regression and scientific acceptance. A numerical agreement with a
reference is evidence only for the specified calculation; a production study also
requires scientific review of its inputs, model assumptions, sampling, uncertainty,
convergence and applicability. A benchmark reference from the same engine is a
regression check, not independent experimental validation.

For an initial public regression fixture, Psi4's published water RHF/cc-pVDZ
example specifies O–H 0.96 Å, H–O–H 104.5°, and energy
−76.02663273410671 hartree. The documentation expects agreement at about 10⁻⁶
hartree: set an absolute tolerance of 1×10⁻⁶ hartree before running and require
normal convergence and successful exit. Record the exact input and defaults. See
[Psi4 tutorial](https://psi4.github.io/psi4docs/1.9.x/tutorial.html). This tests one
SCF calculation only; it does not qualify DFT, any other method, EigenGrid's
execution path, or the installed protocol catalog.

Develop further family-specific benchmark plans with independent published reference
data where applicable: force-field energies and forces, MD conservation and restart
continuity, parameterization, electronic energies and gradients, frequencies and
thermochemistry, periodic convergence, spectra, and analysis/uncertainty. Define
systems, reference provenance, tolerances, resource budget and reviewed decision
criteria before running. Planning and diagnostic entries may instead require
structured case review and cannot all be validated by a single engine job.
