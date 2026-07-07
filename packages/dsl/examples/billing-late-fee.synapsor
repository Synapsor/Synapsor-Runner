CREATE AGENT CONTEXT local_operator
  BIND tenant_id FROM ENVIRONMENT SYNAPSOR_TENANT_ID REQUIRED
  BIND principal FROM ENVIRONMENT SYNAPSOR_PRINCIPAL REQUIRED
  TENANT BINDING tenant_id
  PRINCIPAL BINDING principal
END

CREATE CAPABILITY billing.inspect_invoice
  DESCRIPTION 'Inspect one invoice in the trusted tenant before proposing a waiver.'
  RETURNS HINT 'Returns reviewed invoice fields plus evidence/query-audit handles.'
  USING CONTEXT local_operator
  SOURCE local_postgres
  ON public.invoices
  PRIMARY KEY id
  TENANT KEY tenant_id
  CONFLICT GUARD updated_at
  LOOKUP invoice_id BY id
  ARG invoice_id STRING REQUIRED MAX LENGTH 128 DESCRIPTION 'Invoice id such as INV-3001.'
  ALLOW READ id, tenant_id, customer_id, status, late_fee_cents, waiver_reason, updated_at
  KEEP OUT card_token, internal_risk_score
  REQUIRE EVIDENCE
  MAX ROWS 1
END

CREATE CAPABILITY billing.propose_late_fee_waiver
  DESCRIPTION 'Propose waiving one invoice late fee after inspecting invoice and policy evidence.'
  RETURNS HINT 'Returns a review-required proposal id, exact diff, evidence handle, and source_database_changed:false.'
  USING CONTEXT local_operator
  SOURCE local_postgres
  ON public.invoices
  PRIMARY KEY id
  TENANT KEY tenant_id
  CONFLICT GUARD updated_at
  LOOKUP invoice_id BY id
  ARG invoice_id STRING REQUIRED MAX LENGTH 128 DESCRIPTION 'Invoice id such as INV-3001.'
  ARG waiver_reason TEXT REQUIRED MAX LENGTH 500 DESCRIPTION 'Business reason for the proposed waiver.'
  ALLOW READ id, tenant_id, customer_id, status, late_fee_cents, waiver_reason, updated_at
  KEEP OUT card_token, internal_risk_score
  REQUIRE EVIDENCE
  MAX ROWS 1
  PROPOSE ACTION billing.waive_late_fee
  ALLOW WRITE late_fee_cents, waiver_reason
  PATCH late_fee_cents = 0
  PATCH waiver_reason = ARG waiver_reason
  APPROVAL ROLE billing_lead
  WRITEBACK DIRECT SQL
END

CREATE AGENT WORKFLOW billing.late_fee_review
  USING CONTEXT local_operator
  ALLOW CAPABILITY billing.inspect_invoice
  ALLOW CAPABILITY billing.propose_late_fee_waiver
  REQUIRE EVIDENCE
  APPROVAL REQUIRED ROLE billing_lead
  CHECKPOINT PROPOSAL ONLY
END
