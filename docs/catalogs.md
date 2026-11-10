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

To expose public updates alongside retained site knowledge, prepare a new private
composition with `eigengrid retrieval compose --corpus PUBLIC_ROOT --site-corpus SITE_ROOT`.
Without `--output` this only inspects both inputs. It checks every exact version's
dependency closure and the combined catalog evaluations. Identical ID/version/digest
entries are deduplicated; different versions remain available; a shared ID/version
with different content stops preparation without selecting a winner.

After reviewing the preview, repeat with `--expected-public-digest`,
`--expected-site-digest` and `--output NEW_SITE_DIRECTORY`. Both digests are required
for writing. The destination must be new, outside Git checkouts and source catalogs,
under an owned directory that other users cannot write. The command creates
`corpus/` and a private `composition.json` receipt, verifies the copied identities,
and checks that both inputs remained unchanged. New files initially permit only
the composing account to read them. No private bytes enter the public release.

The site administrator grants the intended scientific readers and dedicated
installation probe account read/traverse access to this new view, verifies it as
those users, then selects its `corpus/` directory in the shared launcher and Lmod.
Keep the previous selection and original catalogs for rollback. Never broaden
access to everyone to make a verification probe pass. Composition does not activate
itself, modify the source catalogs or publish data. Updating public files alone
does not rewrite a previously selected composition; prepare and review a new one
for each catalog update.

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
