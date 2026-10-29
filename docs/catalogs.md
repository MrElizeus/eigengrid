# Catalog boundaries

The public release ships only the basic catalog enumerated in `publication.json`.
`publication-catalog.json` pins the exact reviewed file set and SHA-256 hashes.
The source guard rejects additions, omissions and changes until deliberately
reviewed. Updating the lock is a publication decision, not a CI repair step.

To use a separately maintained complete catalog, set
`EIGENGRID_SCIENTIFIC_SKILLS_ROOT=/path/to/authorized/catalog` for the local process.
The loader uses that directory instead of the bundled catalog; it does not merge
catalogs or fetch a private repository. Keep private catalogs outside this checkout.
Do not copy them into build inputs, public examples, artifacts or CI fixtures.

The loader validates manifests, dependency closure, versions and content digests.
Compiled plans retain exact version/fragment identities. A newer catalog does not
rewrite an existing plan or authorize execution. Executable helpers are controlled
by application-owned allowlists, not arbitrary scripts in a catalog directory.

External knowledge cannot install missing code or grant an unsupported capability.
Advanced implementations must run in their separately maintained private runtime;
selecting a private catalog alone does not recreate withheld code in this build.
