# Shared cluster installation

Install the verified native distribution in a versioned directory. Keep the
previous directory available for rollback, and change the shared selection only
after checking the candidate. Preserve `bin/` beside `share/`; the scientific
catalog is resolved relative to the executable.

The shared client and persistent Head are separate installations. A client
wrapper can set `EIGENGRID_PYTHON` to a dedicated environment containing the
matching wheel. Invoke that Python interpreter with `-I` to keep scientific
module settings and user site packages from changing its imports. Each user
keeps their own project, model credentials and permission settings.

## Live Slurm inventory

Set `EIGENGRID_CLUSTER_PROFILE` to a site-owned JSON file:

```json
{
  "schemaVersion": "eigengrid.cluster-profile/v1",
  "clusterName": "research",
  "controller": "login",
  "loginNodes": ["login"]
}
```

The profile identifies the controller and excludes login hosts from compute
capacity. It contains no credentials, user list or fixed worker inventory.
The client queries `sinfo` and `scontrol` with bounded output, timeouts, a reduced
environment and `/etc/slurm/slurm.conf`.

```bash
eigengrid cluster status
eigengrid node list --json
eigengrid node discover --json
eigengrid node show --id worker-01
```

With this profile, node commands, the dashboard and agent node tools read the
current Slurm inventory. Queries do not write nodes into project databases.
`eigengrid node list --source project` reads the existing project registry.
A failed scheduler query produces an error instead of substituting stale data.

The inventory reports scheduler capacity, CPU allocation, partitions and GRES.
OS free memory is reported separately from configured scheduler memory.
Inventory visibility does not qualify a scheduler version for execution.
The existing strict submission/accounting contract still supports Slurm 23.11.x.

A configured cluster profile disables legacy execution through the client
coordinator. It preserves personal inspection and preparation without treating
an inventory entry as permission to execute. Persistent Head admission,
scientific approvals and site credentials remain independently configured.
See [operation and recovery](operations.md) before updating that service.
