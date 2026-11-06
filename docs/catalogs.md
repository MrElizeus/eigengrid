# Catalog boundaries

The public release ships the scientific catalog enumerated in `publication.json`.
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

The operator uses `ScientificRetrievalService` for discovery. Its lexical mode remains
the default; an explicitly configured local embedding index can add hybrid discovery.
Catalog bytes and authorization are rechecked before reuse, including during asynchronous
embedding work. Multi-user hosts must bind their own principal and catalog grants before
loading data. The single-user CLI adapter is not a server authorization policy.
See [retrieval contracts, isolation and index recovery](scientific-retrieval.md).
