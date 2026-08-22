# Security Policy

Report security issues privately to security@synapsor.ai.

Do not include production credentials, customer data, or full source rows in bug reports. Include runner version, job id, proposal id, source id, engine, safe error code, and redacted logs where possible.

## Supported security scope

Runner protects the model/database boundary for reviewed semantic reads,
structured proposals, verified approval, guarded writeback, receipts, replay,
local typed Explore/Protect, the separately gated production HTTP Explore
two-tool surface, and optional exact-digest supervised execution. Optional
Workbench Ask calls only the local reviewed runtime surface. Human-attention
notifications are redacted interruption channels and never authority.

It does not make the hosted Synapsor control plane self-hosted, prevent prompt
injection, replace database roles/RLS, or provide HA, compliance certification,
or a general database proxy. Reviewed visible data sent to an
operator-selected model provider is subject to that provider's own privacy and
retention terms.

See `THREAT_MODEL.md` and `docs/security-boundary.md` for detailed trust
boundaries, covered threats, non-goals, and release blockers.
