# Diagnostic fixture selection

The first original-context prerequisite failed before MCP startup at doctor:
POLICY_EXECUTION_BINDING_CHANGED. The harness selected synapsor.runner.json, the
Read-only primary with no action_rules or worker configuration. The reviewed
execution binding belongs to synapsor.actions.runner.json, the generated Action
companion selected by the existing unified MCP entry. The configs differ in mode,
capabilities, Action settings, worker settings and sources; the diagnostic correctly
refused the mismatched selection. No identity or policy record was changed.

Correct only the diagnostic argument to the existing reviewed companion. Preserve
identity-main.log/exit and main/deterministic/identity-prerequisite-attempt1.json;
retry the same unused owned fixture within its three prerequisite attempts. The
MCP launcher remains the existing unified Read/Action path. Neither configuration
nor its reviewed identity is rewritten. This is not an identity-isolation failure.
