CREATE AGENT CONTEXT local_operator
  BIND tenant_id FROM ENVIRONMENT SYNAPSOR_TENANT_ID REQUIRED
  BIND principal FROM ENVIRONMENT SYNAPSOR_PRINCIPAL REQUIRED
  TENANT BINDING tenant_id
  PRINCIPAL BINDING principal
END

CREATE CAPABILITY cases.close_high_risk
  DESCRIPTION 'Close active high-risk support cases within reviewed row and value caps.'
  RETURNS HINT 'Returns a proposal for the exact reviewed set; source rows remain unchanged.'
  USING CONTEXT local_operator
  SOURCE support_db
  ON public.support_cases
  PRIMARY KEY id
  TENANT KEY tenant_id
  CONFLICT GUARD version
  LOOKUP reason BY id
  ARG reason STRING REQUIRED MAX LENGTH 100
  ALLOW READ id, tenant_id, risk_level, case_status, exposure_cents, version
  REQUIRE EVIDENCE
  PROPOSE ACTION close_high_risk UPDATE SET
  SELECT WHERE risk_level = 'high' AND case_status = 'active'
  MAX ROWS 10
  MAX TOTAL exposure_cents BEFORE 50000
  ALLOW WRITE case_status
  PATCH case_status = 'closed'
  ADVANCE VERSION version USING INTEGER INCREMENT
  APPROVAL ROLE support_manager
  WRITEBACK DIRECT SQL
END
