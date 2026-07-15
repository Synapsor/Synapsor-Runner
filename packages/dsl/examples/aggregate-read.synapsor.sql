CREATE AGENT CONTEXT finance_operator
  BIND tenant_id FROM ENVIRONMENT SYNAPSOR_TENANT_ID REQUIRED
  BIND principal FROM ENVIRONMENT SYNAPSOR_PRINCIPAL REQUIRED
  TENANT BINDING tenant_id
  PRINCIPAL BINDING principal
END

CREATE CAPABILITY billing.overdue_balance_total
  DESCRIPTION 'Return one suppressed overdue-balance aggregate for the trusted tenant.'
  RETURNS HINT 'Returns one scalar or a suppression result; never member rows.'
  USING CONTEXT finance_operator
  SOURCE local_postgres
  ON public.invoices
  PRIMARY KEY id
  TENANT KEY tenant_id
  AGGREGATE READ SUM balance_cents
  SELECT WHERE status = 'overdue'
  MIN GROUP SIZE 5
  KEEP OUT customer_email, private_notes
  REQUIRE EVIDENCE
END
