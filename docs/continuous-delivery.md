# Continuous delivery

Pull requests, pushes to `main`, release verification and publication use GitHub's
standard `ubuntu-24.04` hosted runners. For public repositories, these runners are
[free and unlimited](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job#standard-github-hosted-runners-for-public-repositories)
and do not consume the account's included private-repository compute allowance.
There is no minute-exhaustion fallback to activate for this public repository;
test failures must remain failures rather than retrying on a local runner.

Rootless Docker remains available for local verification through
`scripts/release/verify-workflow.sh`. If the repository becomes private, review
billing and implement explicit quota detection before enabling a rootless CI
fallback. Repository settings must require approval for all external contributors
before running workflows; inspect workflow changes before approval.

To release `1.0.6`, `1.0.5`, `1.0.4`, `1.0.3`, `1.0.2`, `1.0.1`, `1.0.0` or a version in the `1.0.0-rc.x` series (after PR approval):

1. Update the JavaScript and Python versions together and merge the change into
   `main` using a Conventional Commit.
2. Include reviewed notes at `docs/release-notes/<tag>.md` and push the corresponding
   tag, for example `v1.0.6`. Publication reads the notes from the exact tagged commit.
3. The software workflow checks publication scope, commit policy, static quality,
   native binaries, reproducibility, TypeScript tests and Python tests. Only after
   all checks pass does its publication job upload and publish the release.

The `v1.0.0`, `v1.0.1` `v1.0.2` `v1.0.3` `v1.0.4`, `v1.0.5` and `v1.0.6` tags publish stable software releases; RC tags publish prereleases.
A PR alone does not publish a release. Scientific qualification remains a separate
installation decision for both kinds of release.

Releases contain the archive, byte manifest, checksums and `validation.json`,
which binds the source commit, repository identity, workflow run and database
migrations. A failed publication may leave a draft for operator inspection;
drafts cannot deploy. Do not replace published assets or reuse a version tag.

## Cluster release controller

The existing controller admits only the `1.0.0-rc.x` series. It does not automatically
install stable releases; site administrators must separately review installation or
controller policy changes. Preparing the stable software release does not expand
this deployment authority.

Install `scripts/deploy/install.py` and `pull_release.py` as root-owned files in
`/usr/local/lib/eigengrid-deploy`. Install the supplied `eigengrid-release.service`
and timer in `/etc/systemd/system`. Configure a root-readable
`/etc/eigengrid/release-controller.json`:

```json
{
  "repository": "example/eigengrid",
  "repositoryId": 123456,
  "stateDirectory": "/var/lib/eigengrid-release",
  "probeUser": "eigengrid-releasecheck",
  "expectedNodes": ["compute-01", "compute-02"]
}
```

Use a dedicated unprivileged probe account with no sudo or SSH authorization.
It needs site-approved read/traverse access to the selected scientific catalog;
an inaccessible or empty catalog fails preparation.
The controller requires an existing installation with a shared client under
`/opt/apps/eigengrid/current`, a protected Head under `/opt/eigengrid/current`,
an installation receipt, a Python virtual environment and an Lmod default.
Initial installation remains a site administration task.

Enable the timer with `systemctl enable --now eigengrid-release.timer`.
It checks every five minutes using outbound HTTPS and no GitHub token. It admits
only a newer release in the configured series, from the pinned repository ID,
whose exact commit belongs to `main` and whose software workflow completed
successfully. It validates GitHub asset digests and the package manifest before
preparing software. Database migrations must match the installed schema exactly;
schema changes require separate operator review.

Preparation verifies every packaged file, updates the isolated Python runtime
offline, checks live inventory and exercises a standby Head under the existing
service confinement. It preserves the service's disabled scientific dispatch.
Activation switches version links and the Lmod default, restarts the Head and
checks its release identity, AppArmor confinement and database schema. A failed
activation restores the previous links, environment and modules and restarts
the previous Head. It does not launch scientific jobs or install worker daemons.

Backups remain private under `/var/backups/eigengrid-install-<commit-prefix>`.
Staging and the single-controller lock live in the configured state directory.
If preparation or activation fails, inspect the retained installation plan and
private backup before retrying. The controller does not overwrite a failed
installation or automatically prune rollback versions. Stop the timer while
performing manual recovery. The installed controller itself is updated by the
administrator, never from a downloaded release.

Use `journalctl -u eigengrid-release.service` for controller events and
`systemctl list-timers eigengrid-release.timer` for its next check. Running the
controller with `--check` validates release eligibility without installing it.

## Scientific catalog preservation

The installer reads the previous client's literal
`EIGENGRID_SCIENTIFIC_SKILLS_ROOT` default and the previous Lmod module's matching
`setenv` declaration. It carries that selection into both new entry points, backs
up the launcher, and records the root, corpus digest and counts in the installation
receipt. Unsupported expressions, conflicting selections, missing directories and
invalid catalogs stop preparation. Catalog paths must be absolute literals using
letters, digits, underscores, dots, hyphens and slashes; shell or Lua expressions
are never evaluated by the installer.

The candidate CLI loads the selected catalog as the unprivileged probe account.
The check clears ambient catalog and retrieval overrides so they cannot hide a
missing launcher default. Before activation, it checks the launcher, previous
configuration and catalog against the prepared receipt again. It does not copy,
merge or modify external knowledge, and it does not change scientific dispatch.
An unchanged catalog digest establishes byte identity, not scientific qualification.

For an installation that already lost its selection, first locate and inspect the
previous launcher/module and existing catalog. Do not assume the bundled catalog
contains site protocols. The administrator's private `installation-plan.json` can
explicitly include `scientificSkillsRoot` and `scientificCatalogDigest`, obtained
from the verified external catalog using `eigengrid retrieval status --corpus PATH`.
The explicit root must agree with any surviving launcher/module selection. Run the
updated installer through preparation and review its receipt before activation.
This requires updating the site-owned installer; merely installing a new binary
cannot repair an older installer. Keep site paths, private protocol contents and
recovery plans outside the public repository and artifacts. The existing version
and external catalog remain available for rollback.

To incorporate new public protocols while retaining site protocols, use the
[site-only composition procedure](catalogs.md) before selecting the new catalog.
The public archive always contains only the reviewed public catalog. A composed
view is a separately versioned, private site artifact; it is never uploaded as a
release asset. Verify its receipt and access under the current client before
changing the launcher/module selection, then let the installer preserve that
selection during the software update. If the current client cannot validate the
new view, stop for a coordinated client/catalog update instead of activating it.
