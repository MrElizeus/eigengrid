# Native release packages

Source and release artifacts follow [the publication policy](publication.md).
Run `bun run verify:publication` before building and publishing any release.

Version **1.0.0-rc.1** includes the core runtime, CLI, generic engine adapters and a
reviewed publication selection of 15 basic knowledge entries. Catalog content
remains scientifically unreviewed; advanced catalogs are not bundled.

Commit the source and build the Linux x64 distribution before packaging it:

```bash
bun run build:native
node scripts/release/package.mjs
node scripts/release/verify-package.mjs dist/packages/eigengrid-1.0.0-rc.1-linux-x64.tar.gz --source dist/native
```

Packaging requires a clean checkout and a distribution built from its exact commit and
version. It verifies the build inventory, then produces a deterministic `.tar.gz`,
`release.json` and `SHA256SUMS` in a new output directory. Existing output directories
are preserved; pass another directory as the second packaging argument for another run.
Archive paths, ownership, permissions and modification timestamps are normalized; access
and change timestamps are omitted. The Python wheel's internal permissions and timestamps
are normalized independently of the build host's umask. The manifest lists
the six executables, scientific corpus, Python wheel and component inventory with file
sizes and SHA-256 digests. Verification checks every archived file without extracting it;
`--source` also compares the original distribution.

Checksums detect corruption and changes relative to the manifest. They do not authenticate
a publisher; obtain packages and their commit identities through a trusted channel.

These packages have qualification `software-candidate`. A release candidate does not
certify a Slurm installation, engine tuple, scientific system, recovery objective or
production campaign. Stable promotion requires the corresponding installation and
scientific acceptance evidence. See [capabilities](scientific-capabilities.md) and
[operations](operations.md).
