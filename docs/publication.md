# Public distribution scope

This repository contains reusable source,
synthetic tests, minimal parser fixtures, generic documentation and 15 explicitly
selected basic knowledge entries. Advanced catalogs, study-specific implementations,
private deployment configuration and historical research artifacts are excluded.

Run `bun run verify:publication` before a release. The gate checks source hygiene,
explicit public policy, the exact catalog file set and hashes, and restricted
research identifiers. CI runs it before building. The native builder also runs the
gate before producing a distribution. The gate cannot control manual uploads or
repository administrator actions; review every proposed publication change.

Catalog maturity is separate from distribution approval. All bundled knowledge is
draft and unreviewed. Package tests establish software behavior, not scientific
validity, engine certification or production readiness. See [catalogs](catalogs.md)
and [scientific capabilities](scientific-capabilities.md).

Immutable migration bytes and generic schema identities remain intact. Release
manifests identify the exact public source commit, platform and byte inventory.
Only newly built public packages may be attached to public releases. Old packages
from another source tree are not suitable for redistribution by this repository.
