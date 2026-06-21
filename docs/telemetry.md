# Telemetry

Local mode does not send telemetry to Synapsor Cloud.

By default, Synapsor Runner local commands do not upload:

- schema metadata;
- table names;
- database rows;
- prompts;
- proposal contents;
- credentials or database URLs;
- usage data.

Cloud communication occurs only after an explicit Cloud action, such as
`synapsor cloud connect`, or when a config uses `mode: "cloud"`.

The local MCP server keeps database credentials in the local environment. MCP
client snippets reference the local command and store path; they must not
include database URLs or passwords.

Cloud mode may exchange documented control-plane metadata for runner
registration, heartbeats, tool catalogs, proposal/job leases, result reporting,
and replay/audit workflows. Cloud mode must remain testable and must not upload
database credentials.

If a future feature adds opt-in telemetry, it must be documented, disabled by
default for local mode, and must not include secrets or row payloads.
