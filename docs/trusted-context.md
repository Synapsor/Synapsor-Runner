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
