# Contributing

Install locked dependencies as described in README. Use Linux x64, Bun 1.3.14 and
Python 3.13 for the reproducible baseline. The Python lock includes wheel hashes for
that platform; other Python/platform combinations need a separate qualified lock.

## Commits and pull requests

Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) for new
commits and PR titles: `type(scope): description`. The scope is optional. Keep the
first line at most 100 characters, use a lowercase type/scope, and separate an
optional body from the first line with a blank line. Write concise English
descriptions. Documentation and code comments must also be in English.

| Type       | Purpose                                     | Example                                       |
| ---------- | ------------------------------------------- | --------------------------------------------- |
| `feat`     | New capability                              | `feat(web): add dark mode`                    |
| `fix`      | Bug correction                              | `fix(web): preserve concurrent chat messages` |
| `docs`     | Documentation                               | `docs(cli): explain model configuration`      |
| `refactor` | Code organization without a behavior change | `refactor(agent): extract connection setup`   |
| `perf`     | Performance improvement                     | `perf(db): reduce journal lookups`            |
| `test`     | Tests                                       | `test(slurm): cover interrupted submissions`  |
| `build`    | Dependencies or packaging                   | `build: update locked dependencies`           |
| `ci`       | Automation                                  | `ci: validate commit messages`                |
| `chore`    | Repository maintenance                      | `chore(repo): configure commit hooks`         |
| `style`    | Formatting without a behavior change        | `style(cli): apply formatting`                |
| `revert`   | Revert a previous change                    | `revert(web): remove experimental navigation` |

Scopes identify the affected area, such as `web`, `cli`, `agent`, `db`, `slurm`,
`worker`, `amber` or `release`; lowercase letters, numbers, `.`, `/`, `_` and `-`
are supported. Mark incompatible changes with `!`, for example
`feat(protocol)!: require the next schema version`, or a `BREAKING CHANGE:` footer
that explains the required migration.

Enable local validation once per clone:

```bash
bun run hooks:install
bun run commits:check
bun run commits:test
```

The installer preserves existing custom hooks and explains manual integration
when needed. Its absolute hook path also covers linked worktrees. After moving a
clone, update `core.hooksPath` to its new `.githooks` location. The hook requires
Node.js, already part of the development setup.
CI checks new non-merge commits and PR titles, including title edits. Actual Git
merge commits are exempt; squash commits and revert commits need a conventional
subject. Fold temporary fixup commits into their intended commits before review.

The default check validates the entire history, including the initial commit.
For a specific branch comparison, run `bun run commits:check --range BASE HEAD`.
To enforce the CI gate at merge time, require the `Conventional commits` status
check in the repository's GitHub ruleset.

Keep each commit focused and stage explicit files. Keep generated output, local
configuration and research artifacts out of source control. Retain required
third-party notices, fixture identities and catalog hashes. Run the repository's
verification checks before preparing a release.

## Verification

```bash
bun run typecheck
bun run lint
bun run format:check
bun run build
bun run test
bun run build:native
bun run verify:distribution
```

The complete integration suite needs disposable PostgreSQL and a rootless Docker or
Podman daemon. `scripts/release/test-postgres.sh` creates a temporary local database, runs
the TypeScript suite and removes only that database. Never supply a production DSN.
External ORCA and SSH tests require explicitly provisioned services and otherwise skip;
skips do not establish support. CI records them separately from passing assertions.

Preserve protocol digests, schema versions, approval boundaries, failure behavior and
scientific units. Include a regression for changes to execution authority, persistence,
parsing or scientific meaning. Keep external engines optional. Fixture outputs must be
minimal, redistributable and clearly distinguished from scientific acceptance evidence.

Changes to physical algorithms, atom selection, sampling, charge/spin, units or engine
mapping require scientific review. Maintain exact-revision approvals and compatibility
checks; do not update snapshots merely to make failing tests pass. Document behavioral
changes and their limitations in the same pull request. Contributions are MIT licensed.

Use `bun run verify:workflow` for the isolated durable MD workflow and
`bun run benchmark:journal` for synthetic journal scaling measurements. The full
PostgreSQL suite remains required for persistence/authority changes. Keep store facades
thin and put operations in their domain repositories; transaction-scoped helpers must
receive the existing transaction. Preserve published migration bytes and persisted
identities when renaming source modules. Run `python scripts/release/scan.py .` before staging;
it includes new, untracked source files and tolerates deleted or renamed tracked files.
