# Security

Report suspected vulnerabilities privately using the repository's GitHub security
advisory facility. If it is unavailable, contact the repository owner privately through
GitHub before posting sensitive details. Do not attach credentials, production DSNs,
private molecular data, journal contents or patient/client information to public issues.

Include the affected revision, a minimal reproduction, the relevant trust boundary and
expected versus observed behavior. The current maintained line is the 1.0.0 candidate;
there is no guaranteed response-time or long-term support commitment.

The security model assumes protected host configuration, authenticated OS identities,
restricted database roles and a correctly provisioned submitter. Retrieved scientific
text and model output are untrusted data. Approvals bind exact revisions and expire;
unknown effects must be reconciled before retry. See [operation](docs/operations.md).

The Operator's local sandbox preset applies Linux namespaces, restricted filesystem
mounts, disabled host networking and systemd resource limits to calculation processes.
It does not apply a dedicated seccomp filter or require an EigenGrid-specific AppArmor
profile. Host orchestration remains trusted, and this preset is not a claim of complete
containment for hostile arbitrary code. Full Access uses the current OS user's privileges
without this sandbox. See [execution permissions](docs/getting-started.md#choose-execution-permissions)
for the precise scope, prerequisites and remaining limits.
