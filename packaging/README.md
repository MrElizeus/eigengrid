# Service templates

These systemd units and AppArmor rules are restrictive starting points for a Linux
installation. Static checks verify declared isolation properties. They do not certify
an actual installation or open scientific dispatch. Adapt executable paths, Python,
users, database access, storage, capabilities and network policy to the reviewed site.
Keep scientific engine and submitter configuration outside the source repository.

For native releases, `/opt/eigengrid/current` points to the distribution root containing
`bin/` and `share/`. The Head unit invokes `current/bin/eigengrid-head`; its AppArmor
profile admits that path inside a versioned candidate directory. The legacy flat binary
path remains allowed so an existing installation can restore its previous unit and link.

The Head template deliberately starts with dispatch disabled and network access closed.
The Worker template requires a separately provisioned identity and AppArmor profile.
Missing protected configuration should stop startup. Use the [operations guide](../docs/operations.md)
and the exact role executable's help when preparing an installation.
