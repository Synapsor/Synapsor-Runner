CREATE TABLE IF NOT EXISTS public.tickets (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  customer_name text NOT NULL,
  status text NOT NULL,
  resolution_note text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.tickets (id, tenant_id, customer_name, status, resolution_note, updated_at)
VALUES
  ('T-1042', 'acme', 'Acme Robotics', 'open', NULL, '2026-06-20T12:00:00Z'),
  ('T-9001', 'otherco', 'OtherCo Labs', 'open', NULL, '2026-06-20T12:00:00Z')
ON CONFLICT (id) DO UPDATE SET
  tenant_id = EXCLUDED.tenant_id,
  customer_name = EXCLUDED.customer_name,
  status = EXCLUDED.status,
  resolution_note = EXCLUDED.resolution_note,
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

GRANT CONNECT ON DATABASE synapsor_runner_mcp_support TO synapsor_reader, synapsor_writer;
GRANT USAGE ON SCHEMA public TO synapsor_reader, synapsor_writer;
GRANT CREATE ON SCHEMA public TO synapsor_writer;
GRANT SELECT ON public.tickets TO synapsor_reader, synapsor_writer;
GRANT UPDATE (status, resolution_note, updated_at) ON public.tickets TO synapsor_writer;
