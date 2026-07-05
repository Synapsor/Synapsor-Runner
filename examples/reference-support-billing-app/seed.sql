INSERT INTO public.tenants (id, name, created_at, updated_at)
VALUES
  ('acme', 'Acme Robotics', '2026-06-20T10:00:00Z', '2026-06-20T10:00:00Z'),
  ('otherco', 'OtherCo Labs', '2026-06-20T10:00:00Z', '2026-06-20T10:00:00Z')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = EXCLUDED.updated_at;

INSERT INTO public.customers (id, tenant_id, name, email, plan, plan_credit_cents, credit_reason, created_at, updated_at)
VALUES
  ('cust_acme_1', 'acme', 'Acme Robotics', 'ops@example.invalid', 'enterprise', 0, NULL, '2026-06-20T10:00:00Z', '2026-06-20T10:00:00Z'),
  ('cust_acme_2', 'acme', 'Acme Field Ops', 'field@example.invalid', 'builder', 0, NULL, '2026-06-20T10:00:00Z', '2026-06-20T10:00:00Z'),
  ('cust_other_1', 'otherco', 'OtherCo Labs', 'ops@otherco.invalid', 'builder', 0, NULL, '2026-06-20T10:00:00Z', '2026-06-20T10:00:00Z')
ON CONFLICT (id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, name = EXCLUDED.name, email = EXCLUDED.email, plan = EXCLUDED.plan, plan_credit_cents = EXCLUDED.plan_credit_cents, credit_reason = EXCLUDED.credit_reason, updated_at = EXCLUDED.updated_at;

INSERT INTO public.support_tickets (id, tenant_id, customer_id, subject, status, resolution_note, updated_at)
VALUES
  ('T-1042', 'acme', 'cust_acme_1', 'Late fee waiver request for INV-3001', 'open', NULL, '2026-06-20T12:00:00Z'),
  ('T-1043', 'acme', 'cust_acme_2', 'Duplicate card charge question', 'open', NULL, '2026-06-20T12:05:00Z'),
  ('T-9001', 'otherco', 'cust_other_1', 'OtherCo private billing ticket', 'open', NULL, '2026-06-20T12:00:00Z')
ON CONFLICT (id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, customer_id = EXCLUDED.customer_id, subject = EXCLUDED.subject, status = EXCLUDED.status, resolution_note = EXCLUDED.resolution_note, updated_at = EXCLUDED.updated_at;

INSERT INTO public.invoices (id, tenant_id, customer_id, status, balance_cents, late_fee_cents, waiver_reason, updated_at)
VALUES
  ('INV-3001', 'acme', 'cust_acme_1', 'overdue', 25500, 5500, NULL, '2026-06-20T14:31:08Z'),
  ('INV-3002', 'acme', 'cust_acme_2', 'paid', 0, 0, NULL, '2026-06-20T14:40:00Z'),
  ('INV-9001', 'otherco', 'cust_other_1', 'overdue', 25500, 5500, NULL, '2026-06-20T14:31:08Z')
ON CONFLICT (id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, customer_id = EXCLUDED.customer_id, status = EXCLUDED.status, balance_cents = EXCLUDED.balance_cents, late_fee_cents = EXCLUDED.late_fee_cents, waiver_reason = EXCLUDED.waiver_reason, updated_at = EXCLUDED.updated_at;

INSERT INTO public.orders (id, tenant_id, customer_id, status, status_change_reason, updated_at)
VALUES
  ('O-1001', 'acme', 'cust_acme_1', 'paid', NULL, '2026-06-20T13:00:00Z'),
  ('O-1002', 'acme', 'cust_acme_2', 'processing', NULL, '2026-06-20T13:05:00Z'),
  ('O-9001', 'otherco', 'cust_other_1', 'paid', NULL, '2026-06-20T13:00:00Z')
ON CONFLICT (id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, customer_id = EXCLUDED.customer_id, status = EXCLUDED.status, status_change_reason = EXCLUDED.status_change_reason, updated_at = EXCLUDED.updated_at;
