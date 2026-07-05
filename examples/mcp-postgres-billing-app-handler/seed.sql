INSERT INTO public.tenants (id, name, created_at, updated_at)
VALUES
  ('acme', 'Acme Robotics', '2026-06-20T10:00:00Z', '2026-06-20T10:00:00Z'),
  ('globex', 'Globex Labs', '2026-06-20T10:00:00Z', '2026-06-20T10:00:00Z')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = EXCLUDED.updated_at;

INSERT INTO public.customers (id, tenant_id, name, plan, created_at, updated_at)
VALUES
  ('cust_acme_1', 'acme', 'Acme Robotics', 'enterprise', '2026-06-20T10:00:00Z', '2026-06-20T10:00:00Z'),
  ('cust_globex_1', 'globex', 'Globex Labs', 'builder', '2026-06-20T10:00:00Z', '2026-06-20T10:00:00Z')
ON CONFLICT (id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, name = EXCLUDED.name, plan = EXCLUDED.plan, updated_at = EXCLUDED.updated_at;

INSERT INTO public.invoices (
  id,
  tenant_id,
  customer_id,
  status,
  balance_cents,
  late_fee_cents,
  waiver_reason,
  credit_requested_cents,
  credit_reason,
  credited_cents,
  updated_at
)
VALUES
  ('INV-3001', 'acme', 'cust_acme_1', 'overdue', 25500, 5500, NULL, 0, NULL, 0, '2026-06-20T14:31:08Z'),
  ('INV-9001', 'globex', 'cust_globex_1', 'overdue', 25500, 5500, NULL, 0, NULL, 0, '2026-06-20T14:31:08Z')
ON CONFLICT (id) DO UPDATE SET
  tenant_id = EXCLUDED.tenant_id,
  customer_id = EXCLUDED.customer_id,
  status = EXCLUDED.status,
  balance_cents = EXCLUDED.balance_cents,
  late_fee_cents = EXCLUDED.late_fee_cents,
  waiver_reason = EXCLUDED.waiver_reason,
  credit_requested_cents = EXCLUDED.credit_requested_cents,
  credit_reason = EXCLUDED.credit_reason,
  credited_cents = EXCLUDED.credited_cents,
  updated_at = EXCLUDED.updated_at;
