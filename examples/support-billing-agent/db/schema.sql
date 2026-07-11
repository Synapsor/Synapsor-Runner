CREATE TABLE IF NOT EXISTS public.tenants (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.customers (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES public.tenants(id),
  name text NOT NULL,
  email text,
  plan text NOT NULL,
  plan_credit_cents integer NOT NULL DEFAULT 0,
  credit_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.support_tickets (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES public.tenants(id),
  customer_id text NOT NULL REFERENCES public.customers(id),
  subject text NOT NULL,
  status text NOT NULL,
  resolution_note text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.invoices (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES public.tenants(id),
  customer_id text NOT NULL REFERENCES public.customers(id),
  status text NOT NULL,
  balance_cents integer NOT NULL,
  late_fee_cents integer NOT NULL,
  waiver_reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.credits (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES public.tenants(id),
  customer_id text NOT NULL REFERENCES public.customers(id),
  invoice_id text REFERENCES public.invoices(id),
  amount_cents integer NOT NULL,
  reason text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.agent_actions (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES public.tenants(id),
  action_type text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  proposal_id text,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.orders (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES public.tenants(id),
  customer_id text NOT NULL REFERENCES public.customers(id),
  status text NOT NULL,
  status_change_reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.synapsor_writeback_receipts (
  idempotency_key text PRIMARY KEY,
  job_id text UNIQUE NOT NULL,
  proposal_id text NOT NULL,
  status text NOT NULL,
  result_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

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

GRANT CONNECT ON DATABASE synapsor_support_billing_agent TO synapsor_reader, synapsor_writer;
GRANT USAGE ON SCHEMA public TO synapsor_reader, synapsor_writer;
GRANT SELECT ON public.tenants, public.customers, public.support_tickets, public.invoices, public.credits, public.agent_actions, public.orders TO synapsor_reader, synapsor_writer;
GRANT SELECT, INSERT, UPDATE ON public.synapsor_writeback_receipts TO synapsor_writer;
GRANT UPDATE (plan_credit_cents, credit_reason, updated_at) ON public.customers TO synapsor_writer;
GRANT UPDATE (status, resolution_note, updated_at) ON public.support_tickets TO synapsor_writer;
GRANT UPDATE (late_fee_cents, waiver_reason, updated_at) ON public.invoices TO synapsor_writer;
GRANT UPDATE (status, status_change_reason, updated_at) ON public.orders TO synapsor_writer;
