CREATE TABLE public.invoices (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  status text NOT NULL,
  late_fee_cents integer NOT NULL,
  waiver_reason text,
  updated_at timestamptz NOT NULL
);

CREATE TABLE public.synapsor_writeback_receipts (
  idempotency_key text PRIMARY KEY,
  job_id text UNIQUE NOT NULL,
  proposal_id text NOT NULL,
  status text NOT NULL,
  result_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE public.synthetic_handler_receipts (
  idempotency_key text PRIMARY KEY,
  proposal_id text NOT NULL,
  object_id text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.invoices (id, tenant_id, status, late_fee_cents, waiver_reason, updated_at) VALUES
  ('INV-ACME', 'acme', 'overdue', 2500, NULL, '2026-07-12T12:00:00Z'),
  ('INV-GLOBEX', 'globex', 'overdue', 3100, NULL, '2026-07-12T12:00:00Z'),
  ('INV-RATECO', 'rateco', 'overdue', 900, NULL, '2026-07-12T12:00:00Z'),
  ('INV-QUORUM-RACE', 'acme', 'overdue', 1400, NULL, '2026-07-12T12:00:00Z'),
  ('INV-WORKER-RACE', 'acme', 'overdue', 1600, NULL, '2026-07-12T12:00:00Z'),
  ('INV-DEAD-REQUEUE', 'acme', 'overdue', 1700, NULL, '2026-07-12T12:00:00Z'),
  ('INV-DEAD-DISCARD', 'acme', 'overdue', 1750, NULL, '2026-07-12T12:00:00Z'),
  ('INV-KILL-BEFORE', 'acme', 'overdue', 1200, NULL, '2026-07-12T12:00:00Z'),
  ('INV-KILL-DURING', 'acme', 'overdue', 1500, NULL, '2026-07-12T12:00:00Z'),
  ('INV-KILL-AFTER', 'acme', 'overdue', 1800, NULL, '2026-07-12T12:00:00Z');

CREATE FUNCTION public.synthetic_pool_delay() RETURNS integer
LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  PERFORM pg_sleep(0.15);
  RETURN 0;
END
$$;

CREATE VIEW public.slow_invoices AS
SELECT invoices.*, public.synthetic_pool_delay() AS synthetic_delay
FROM public.invoices;

DO $$
BEGIN
  CREATE ROLE synapsor_reader LOGIN PASSWORD 'synapsor_reader_password';
  CREATE ROLE synapsor_writer LOGIN PASSWORD 'synapsor_writer_password';
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

GRANT CONNECT ON DATABASE synapsor_fleet TO synapsor_reader, synapsor_writer;
GRANT USAGE ON SCHEMA public TO synapsor_reader, synapsor_writer;
GRANT SELECT ON public.invoices TO synapsor_reader, synapsor_writer;
GRANT SELECT ON public.slow_invoices TO synapsor_reader;
GRANT UPDATE (late_fee_cents, waiver_reason, updated_at) ON public.invoices TO synapsor_writer;
GRANT SELECT, INSERT, UPDATE ON public.synapsor_writeback_receipts TO synapsor_writer;

-- Docker's Postgres entrypoint briefly starts a temporary postmaster while it
-- runs init scripts. The Compose health check compares this timestamp with the
-- current postmaster start time so dependents wait for the final server.
CREATE TABLE public.synapsor_fixture_ready (
  initialized_at timestamptz NOT NULL
);
INSERT INTO public.synapsor_fixture_ready (initialized_at) VALUES (clock_timestamp());
