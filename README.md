# EigenGrid

EigenGrid is a computational chemistry control plane: versioned scientific protocols,
durable missions, typed engine adapters and an optional native tool-calling agent.
Scientists can create, review, approve and start missions without a language model.
Version 1.0.0 includes the CLI, terminal interface and authenticated HTTP API.
The React web interface is deferred to a separate development branch and is not
included in this release.

Version **1.0.8** reports bounded model-budget exhaustion accurately and improves
operational backups of mission journals. Persistent agents use prepared mission
workflows through a private HTTPS client.
Linux x64 software contracts are covered
by local and PostgreSQL integration tests. Installation-specific execution
qualification, large-system performance and scientific acceptance remain separate.
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

## HTTP API

Run `eigengrid serve` for the authenticated `/api/v1` API. Provision the protected
HTTP configuration, PostgreSQL schema and HTTPS reverse proxy described in
[operations](docs/operations.md). The server checks actor identity, project
membership and scientific roles. Version 1.0.0 does not serve a browser interface.

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
- [Interactive campaign planning, questions and source acquisition](docs/interactive-scientific-planning.md)
- [Experiential memory and lesson review](docs/experiential-memory.md)
- [Hybrid scientific retrieval and reproducible evaluation](docs/scientific-retrieval.md)
- [Operation, identity and recovery](docs/operations.md)
- [Development and verification](CONTRIBUTING.md)
- [Security reporting](SECURITY.md)
- [Shared cluster installation and inventory](docs/cluster.md)
- [Release packages and verification](docs/releases.md)
- [Third-party components and fixture provenance](THIRD_PARTY_NOTICES.md)

EigenGrid is MIT licensed. Each build and release manifest identifies its exact
source commit.

The bundled catalog contains 15 foundational entries and 16 versioned DFT planning
protocols for molecules, periodic systems and cluster qualification. The operator
can retrieve their procedures, dependencies and literature sources by exact revision.
[DFT catalog and cluster examples](docs/dft-protocols.md).

See [publication scope](docs/publication.md) and [external catalogs](docs/catalogs.md).

Release automation and cluster updates are described in [continuous delivery](docs/continuous-delivery.md).
