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

To release `1.0.0` or a version in the `1.0.0-rc.x` series (after PR approval):

1. Update the JavaScript and Python versions together and merge the change into
   `main` using a Conventional Commit.
2. Push the corresponding tag, for example `v1.0.0`.
3. The software workflow checks publication scope, commit policy, static quality,
   native binaries, reproducibility, TypeScript tests and Python tests. Only after
   all checks pass does its publication job upload and publish the release.

The `v1.0.0` tag publishes a stable software release; RC tags publish prereleases.
A PR alone does not publish a release. Scientific qualification remains a separate
installation decision for both kinds of release.

Releases contain the archive, byte manifest, checksums and `validation.json`,
which binds the source commit, repository identity, workflow run and database
migrations. A failed publication may leave a draft for operator inspection;
drafts cannot deploy. Do not replace published assets or reuse a version tag.

## Cluster release controller

The existing controller admits only the `1.0.0-rc.x` series. It does not automatically
install stable `1.0.0`; site administrators must separately review installation or
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
