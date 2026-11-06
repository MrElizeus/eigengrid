# Web workspace

This development branch provides one React application, deferred from EigenGrid 1.0.0. See the [workspace guide](web-console.md)
for configuration, access, mission workflows and agent tasks.

`eigengrid web` is an alias for `eigengrid serve`. Both use the same protected
configuration, HTTP API, session and project authority. The experimental standalone
chat service is no longer shipped. Its `--port`, `--origin`, `--connection-dir`,
`--open` and `--no-open` options are not supported by the unified command.

Existing experimental conversation databases are not deleted or automatically
imported as scientific mission sessions. They are different records with different
authority. Retain backups if you evaluated that unreleased prototype. The unified
login uses the protected installation credential; prototype passwords and invitations
do not grant scientific access.
