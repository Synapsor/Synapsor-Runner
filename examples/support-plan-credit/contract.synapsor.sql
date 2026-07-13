CREATE AGENT CONTEXT support_agent_context
  BIND tenant_id FROM ENVIRONMENT SYNAPSOR_TENANT_ID REQUIRED
  BIND principal FROM ENVIRONMENT SYNAPSOR_PRINCIPAL REQUIRED
  TENANT BINDING tenant_id
  PRINCIPAL BINDING principal
END

CREATE CAPABILITY support.inspect_customer
  DESCRIPTION 'Inspect one support customer in the trusted tenant before proposing a plan credit.'
  RETURNS HINT 'Returns reviewed customer fields plus evidence/query-audit handles.'
  USING CONTEXT support_agent_context
  SOURCE local_postgres
  ON public.customers
  PRIMARY KEY id
  TENANT KEY tenant_id
  CONFLICT GUARD updated_at
  LOOKUP customer_id BY id
  ARG customer_id STRING REQUIRED MAX LENGTH 128 DESCRIPTION 'Customer id such as CUS-3001.'
  ALLOW READ id, tenant_id, customer_id, plan, invoice_status, support_ticket_reason, plan_credit_cents, credit_reason, updated_at
  KEEP OUT card_token, raw_payment_method, internal_risk_score, private_notes
  REQUIRE EVIDENCE
  MAX ROWS 1
END

CREATE CAPABILITY support.propose_plan_credit
  DESCRIPTION 'Propose a bounded support plan credit after inspecting customer and ticket evidence.'
  RETURNS HINT 'Returns a proposal id, exact diff, evidence handle, and source_database_changed:false. Policy may approve small credits, but writeback is still separate.'
  USING CONTEXT support_agent_context
  SOURCE local_postgres
  ON public.customers
  PRIMARY KEY id
  TENANT KEY tenant_id
  CONFLICT GUARD updated_at
  LOOKUP customer_id BY id
  ARG customer_id STRING REQUIRED MAX LENGTH 128 DESCRIPTION 'Customer id such as CUS-3001.'
  ARG credit_cents NUMBER REQUIRED MIN 1 DESCRIPTION 'Requested plan credit in cents.'
  ARG reason TEXT REQUIRED MAX LENGTH 500 DESCRIPTION 'Business reason tied to support evidence.'
  ALLOW READ id, tenant_id, customer_id, plan, invoice_status, support_ticket_reason, plan_credit_cents, credit_reason, updated_at
  KEEP OUT card_token, raw_payment_method, internal_risk_score, private_notes
  REQUIRE EVIDENCE
  MAX ROWS 1
  PROPOSE ACTION grant_plan_credit
  ALLOW WRITE plan_credit_cents, credit_reason
  PATCH plan_credit_cents = ARG credit_cents
  PATCH credit_reason = ARG reason
  BOUND plan_credit_cents 1..50000
  APPROVAL ROLE support_reviewer
  AUTO APPROVE WHEN plan_credit_cents <= 2500
  LIMIT 20 PER DAY
  LIMIT TOTAL 100000 PER DAY
  WRITEBACK DIRECT SQL
END

CREATE CAPABILITY support.propose_plan_credit_record
  DESCRIPTION 'Propose creating one bounded plan-credit record with source-enforced deduplication.'
  RETURNS HINT 'Returns a proposal id for one new account_credits row; source database unchanged until human approval and guarded apply.'
  USING CONTEXT support_agent_context
  SOURCE local_postgres
  ON public.account_credits
  PRIMARY KEY id
  TENANT KEY tenant_id
  ARG customer_id STRING REQUIRED MAX LENGTH 128 DESCRIPTION 'Customer id such as CUS-3001.'
  ARG credit_cents NUMBER REQUIRED MIN 1 MAX 50000 DESCRIPTION 'Requested plan credit in cents.'
  ARG reason TEXT REQUIRED MAX LENGTH 500 DESCRIPTION 'Business reason tied to support evidence.'
  ALLOW READ id, tenant_id, request_id, customer_id, amount_cents, reason, created_at
  REQUIRE EVIDENCE
  MAX ROWS 1
  PROPOSE ACTION create_plan_credit INSERT
  DEDUP KEY tenant_id = TRUSTED TENANT, request_id = PROPOSAL ID
  ALLOW WRITE customer_id, amount_cents, reason
  PATCH customer_id = ARG customer_id
  PATCH amount_cents = ARG credit_cents
  PATCH reason = ARG reason
  BOUND amount_cents 1..50000
  APPROVAL ROLE support_reviewer
  WRITEBACK DIRECT SQL
END

CREATE AGENT WORKFLOW support.plan_credit_request
  USING CONTEXT support_agent_context
  ALLOW CAPABILITY support.inspect_customer
  ALLOW CAPABILITY support.propose_plan_credit
  ALLOW CAPABILITY support.propose_plan_credit_record
  REQUIRE EVIDENCE
  APPROVAL REQUIRED ROLE support_reviewer
  CHECKPOINT PROPOSAL ONLY
END
