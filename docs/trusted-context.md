# Trusted Context

Trusted context is the data Synapsor Runner uses as authority but does not allow
the model to choose freely.

Examples:

- tenant ID;
- principal/user ID;
- role;
- environment or workspace scope.

In local mode, the supported provider is environment binding:

```json
{
  "trusted_context": {
    "provider": "environment",
    "values": {
      "tenant_id_env": "SYNAPSOR_TENANT_ID",
      "principal_env": "SYNAPSOR_PRINCIPAL"
    }
  }
}
```

For larger configs, use named contexts so each capability says which trusted
binding it uses:

```json
{
  "contexts": {
    "local_support_operator": {
      "provider": "environment",
      "values": {
        "tenant_id_env": "SYNAPSOR_TENANT_ID",
        "principal_env": "SYNAPSOR_PRINCIPAL"
      }
    }
  },
  "capabilities": [
    {
      "name": "support.inspect_ticket",
      "context": "local_support_operator"
    }
  ]
}
```

Backward compatibility: `trusted_context` still works as the global fallback.
If a capability names `context`, that named context is used for that capability.
If a capability does not name `context`, the global `trusted_context` is used.
Config validation fails when a capability references a missing named context.

At runtime:

```bash
export SYNAPSOR_TENANT_ID="acme"
export SYNAPSOR_PRINCIPAL="local_operator"
```

The model may pass business identifiers such as `invoice_id` or `ticket_id`.
Those identifiers are validated inside the trusted tenant scope.

The model must not pass `tenant_id`, principal, role, or authorization scope as
ordinary authority arguments. If a tool schema appears to require those fields
from the model, treat it as a bug.

Cloud mode may bind trusted context from Cloud runner/session context, but
database credentials still stay local.
