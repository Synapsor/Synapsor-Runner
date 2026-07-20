INSERT INTO public.tenants (id, name, created_at, updated_at)
VALUES
  ('acme', 'Acme Robotics', '2026-06-20T10:00:00Z', '2026-06-20T10:00:00Z'),
  ('otherco', 'OtherCo Labs', '2026-06-20T10:00:00Z', '2026-06-20T10:00:00Z')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = EXCLUDED.updated_at;

INSERT INTO public.customers (id, tenant_id, assigned_to, name, email, plan, plan_credit_cents, credit_reason, created_at, updated_at)
VALUES
  ('cust_acme_1', 'acme', 'reference_operator', 'Acme Robotics', 'ops@example.invalid', 'enterprise', 0, NULL, '2026-06-20T10:00:00Z', '2026-06-20T10:00:00Z'),
  ('cust_acme_2', 'acme', 'another_operator', 'Acme Field Ops', 'field@example.invalid', 'builder', 0, NULL, '2026-06-20T10:00:00Z', '2026-06-20T10:00:00Z'),
  ('cust_other_1', 'otherco', 'reference_operator', 'OtherCo Labs', 'ops@otherco.invalid', 'builder', 0, NULL, '2026-06-20T10:00:00Z', '2026-06-20T10:00:00Z')
ON CONFLICT (id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, assigned_to = EXCLUDED.assigned_to, name = EXCLUDED.name, email = EXCLUDED.email, plan = EXCLUDED.plan, plan_credit_cents = EXCLUDED.plan_credit_cents, credit_reason = EXCLUDED.credit_reason, updated_at = EXCLUDED.updated_at;

INSERT INTO public.support_tickets (id, tenant_id, assigned_to, customer_id, subject, status, resolution_note, updated_at)
VALUES
  ('SUP-184', 'acme', 'reference_operator', 'cust_acme_1', 'Late fee waiver request for INV-3001', 'open', NULL, '2026-06-20T12:00:00Z'),
  ('SUP-185', 'acme', 'another_operator', 'cust_acme_2', 'Duplicate card charge question', 'open', NULL, '2026-06-20T12:05:00Z'),
  ('SUP-9001', 'otherco', 'reference_operator', 'cust_other_1', 'OtherCo private billing ticket', 'open', NULL, '2026-06-20T12:00:00Z')
ON CONFLICT (id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, assigned_to = EXCLUDED.assigned_to, customer_id = EXCLUDED.customer_id, subject = EXCLUDED.subject, status = EXCLUDED.status, resolution_note = EXCLUDED.resolution_note, updated_at = EXCLUDED.updated_at;

INSERT INTO public.invoices (id, tenant_id, assigned_to, customer_id, status, balance_cents, late_fee_cents, waiver_reason, card_token, internal_risk_note, updated_at)
VALUES
  ('INV-3001', 'acme', 'reference_operator', 'cust_acme_1', 'overdue', 25500, 5500, NULL, 'tok_acme_must_stay_hidden', 'manual risk note must stay hidden', '2026-06-20T14:31:08Z'),
  ('INV-3002', 'acme', 'another_operator', 'cust_acme_2', 'paid', 0, 0, NULL, 'tok_acme_other_principal', 'another principal note', '2026-06-20T14:40:00Z'),
  ('INV-9001', 'otherco', 'reference_operator', 'cust_other_1', 'overdue', 25500, 5500, NULL, 'tok_other_tenant', 'other tenant note', '2026-06-20T14:31:08Z')
ON CONFLICT (id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, assigned_to = EXCLUDED.assigned_to, customer_id = EXCLUDED.customer_id, status = EXCLUDED.status, balance_cents = EXCLUDED.balance_cents, late_fee_cents = EXCLUDED.late_fee_cents, waiver_reason = EXCLUDED.waiver_reason, card_token = EXCLUDED.card_token, internal_risk_note = EXCLUDED.internal_risk_note, updated_at = EXCLUDED.updated_at;

INSERT INTO public.credits (id, tenant_id, customer_id, invoice_id, amount_cents, reason, status, created_at, updated_at)
VALUES
  ('CR-1001', 'acme', 'cust_acme_1', 'INV-3001', 1000, 'Seeded goodwill credit for review flow', 'draft', '2026-06-20T15:00:00Z', '2026-06-20T15:00:00Z')
ON CONFLICT (id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, customer_id = EXCLUDED.customer_id, invoice_id = EXCLUDED.invoice_id, amount_cents = EXCLUDED.amount_cents, reason = EXCLUDED.reason, status = EXCLUDED.status, updated_at = EXCLUDED.updated_at;

INSERT INTO public.agent_actions (id, tenant_id, action_type, target_type, target_id, proposal_id, status, created_at)
VALUES
  ('ACT-1001', 'acme', 'late_fee_review', 'invoice', 'INV-3001', NULL, 'seeded', '2026-06-20T15:05:00Z')
ON CONFLICT (id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, action_type = EXCLUDED.action_type, target_type = EXCLUDED.target_type, target_id = EXCLUDED.target_id, proposal_id = EXCLUDED.proposal_id, status = EXCLUDED.status, created_at = EXCLUDED.created_at;

INSERT INTO public.orders (id, tenant_id, customer_id, status, status_change_reason, updated_at)
VALUES
  ('O-1001', 'acme', 'cust_acme_1', 'paid', NULL, '2026-06-20T13:00:00Z'),
  ('O-1002', 'acme', 'cust_acme_2', 'processing', NULL, '2026-06-20T13:05:00Z'),
  ('O-9001', 'otherco', 'cust_other_1', 'paid', NULL, '2026-06-20T13:00:00Z')
ON CONFLICT (id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, customer_id = EXCLUDED.customer_id, status = EXCLUDED.status, status_change_reason = EXCLUDED.status_change_reason, updated_at = EXCLUDED.updated_at;
