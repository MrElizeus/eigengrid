# EigenGrid

EigenGrid is a computational chemistry control plane: versioned scientific protocols,
durable missions, typed engine adapters and an optional native tool-calling agent.
Scientists can create, review, approve and start missions without a language model.

This is the **1.0.0-rc.1 release candidate**. Linux x64 software contracts are covered by
local and PostgreSQL integration tests. Installation-specific Slurm/AMBER qualification,
large-system performance and scientific acceptance remain separate requirements.
See [supported capabilities](docs/scientific-capabilities.md) before planning a campaign.

## Start from source

Requires Bun 1.3.14, Node.js 22 or later, and Python 3.13 on Linux x86_64.
PostgreSQL 16 or later is required for durable missions; local inspection supports SQLite.

```bash
bun install --frozen-lockfile
python3.13 -m venv .venv
. .venv/bin/activate
python -m pip install --require-hashes -r python/requirements-linux-x64-py313.lock
python -m pip install --no-deps --no-build-isolation -e ./python
bun run eigengrid --help
bun run eigengrid mission schema create
bun run eigengrid amber schema render-analysis
```

These commands inspect interfaces without a model or scientific engine. For a local
project, run `bun run eigengrid init --role head --no-gen-key`. Mission execution requires
[protected site configuration](docs/operations.md), reviewed inputs and explicit authority.

## Native distribution

```bash
bun run build:native
bun run verify:distribution
```

The build requires a clean Git checkout and records its exact commit and file digests.
The resulting `dist/native` directory contains six executables, the scientific knowledge
corpus and the Python wheel. Keep `bin/` and `share/` together; add `dist/native/bin` to
`PATH` and install its wheel into the Python environment used by `EIGENGRID_PYTHON`.
No Codex runtime, model weights or scientific engine is bundled. AMBER, Gaussian,
ORCA and other engines require separate installations and appropriate licenses.

## Documentation

- [Installation and reproducible workflow](docs/getting-started.md)
- [Architecture and contracts](docs/architecture.md)
- [Scientific workflows and campaign limits](docs/scientific-capabilities.md)
- [Agent, tools and model configuration](docs/agent.md)
- [Operation, identity and recovery](docs/operations.md)
- [Development and verification](CONTRIBUTING.md)
- [Security reporting](SECURITY.md)
- [Release packages and verification](docs/releases.md)
- [Third-party components and fixture provenance](THIRD_PARTY_NOTICES.md)

EigenGrid is MIT licensed. Each build and release manifest identifies its exact
source commit.

The bundled catalog contains 15 basic, versioned scientific knowledge entries.
They are drafts with explicit inputs, limitations and evaluation cases; they do
not claim expert review or scientific qualification. Advanced catalogs and
study-specific implementations are not part of this distribution.

See [publication scope](docs/publication.md) and [external catalogs](docs/catalogs.md).
