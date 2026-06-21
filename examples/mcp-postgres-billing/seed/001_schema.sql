CREATE TABLE IF NOT EXISTS public.invoices (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  customer_name text NOT NULL,
  status text NOT NULL,
  late_fee_cents integer NOT NULL,
  waiver_reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.invoices (id, tenant_id, customer_name, status, late_fee_cents, waiver_reason, updated_at)
VALUES
  ('INV-3001', 'acme', 'Acme Robotics', 'overdue', 5500, NULL, '2026-06-20T14:31:08Z'),
  ('INV-9001', 'otherco', 'OtherCo Labs', 'overdue', 5500, NULL, '2026-06-20T14:31:08Z')
ON CONFLICT (id) DO UPDATE SET
  tenant_id = EXCLUDED.tenant_id,
  customer_name = EXCLUDED.customer_name,
  status = EXCLUDED.status,
  late_fee_cents = EXCLUDED.late_fee_cents,
  waiver_reason = EXCLUDED.waiver_reason,
  updated_at = EXCLUDED.updated_at;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synapsor_reader') THEN
    CREATE ROLE synapsor_reader LOGIN PASSWORD 'synapsor_reader_password';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synapsor_writer') THEN
    CREATE ROLE synapsor_writer LOGIN PASSWORD 'synapsor_writer_password';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE synapsor_runner_mcp_billing TO synapsor_reader, synapsor_writer;
GRANT USAGE ON SCHEMA public TO synapsor_reader, synapsor_writer;
GRANT CREATE ON SCHEMA public TO synapsor_writer;
GRANT SELECT ON public.invoices TO synapsor_reader, synapsor_writer;
GRANT UPDATE (late_fee_cents, waiver_reason, updated_at) ON public.invoices TO synapsor_writer;
