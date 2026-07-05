# Security Policy

Report security issues privately to security@synapsor.ai.

Do not include production credentials, customer data, or full source rows in bug reports. Include runner version, job id, proposal id, source id, engine, safe error code, and redacted logs where possible.

## Supported security scope

The v0.1 runner protects the local writeback boundary for approved structured jobs. It does not make the hosted Synapsor control plane self-hosted, and it does not provide HA, compliance certification, or a general database proxy.

See `docs/threat-model.md` for detailed trust boundaries, covered threats, non-goals, and release blockers.
