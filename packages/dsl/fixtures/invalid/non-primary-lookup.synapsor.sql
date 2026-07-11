CREATE AGENT CONTEXT local_operator
  BIND tenant_id FROM ENVIRONMENT SYNAPSOR_TENANT_ID REQUIRED
  BIND principal FROM ENVIRONMENT SYNAPSOR_PRINCIPAL REQUIRED
  TENANT BINDING tenant_id
  PRINCIPAL BINDING principal
END

CREATE CAPABILITY fleet.inspect_reported_work_order
  USING CONTEXT local_operator
  SOURCE fleet_postgres
  ON public.work_orders
  PRIMARY KEY id
  TENANT KEY tenant_id
  LOOKUP status_filter BY status
  ARG status_filter STRING REQUIRED MAX LENGTH 32
  ALLOW READ id, tenant_id, status, updated_at
  REQUIRE EVIDENCE
  MAX ROWS 1
END
