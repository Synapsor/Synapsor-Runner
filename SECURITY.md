# Security Policy

Report security issues privately to security@synapsor.ai.

Do not include production credentials, customer data, or full source rows in bug reports. Include runner version, job id, proposal id, source id, engine, safe error code, and redacted logs where possible.

## Supported security scope

Runner protects the local model/database boundary for reviewed semantic reads,
structured proposals, verified approval, guarded writeback, receipts, replay,
and optional exact-digest supervised execution. Human-attention notifications
are redacted interruption channels and never authority.

It does not make the hosted Synapsor control plane self-hosted, prevent prompt
injection, replace database roles/RLS, or provide HA, compliance certification,
or a general database proxy.

See `THREAT_MODEL.md` and `docs/security-boundary.md` for detailed trust
boundaries, covered threats, non-goals, and release blockers.
