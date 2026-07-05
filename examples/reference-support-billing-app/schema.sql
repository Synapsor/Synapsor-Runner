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

CREATE TABLE IF NOT EXISTS public.orders (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES public.tenants(id),
  customer_id text NOT NULL REFERENCES public.customers(id),
  status text NOT NULL,
  status_change_reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
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

GRANT CONNECT ON DATABASE synapsor_reference_support_billing TO synapsor_reader, synapsor_writer;
GRANT USAGE ON SCHEMA public TO synapsor_reader, synapsor_writer;
GRANT CREATE ON SCHEMA public TO synapsor_writer;
GRANT SELECT ON public.tenants, public.customers, public.support_tickets, public.invoices, public.orders TO synapsor_reader, synapsor_writer;
GRANT UPDATE (plan_credit_cents, credit_reason, updated_at) ON public.customers TO synapsor_writer;
GRANT UPDATE (status, resolution_note, updated_at) ON public.support_tickets TO synapsor_writer;
GRANT UPDATE (late_fee_cents, waiver_reason, updated_at) ON public.invoices TO synapsor_writer;
GRANT UPDATE (status, status_change_reason, updated_at) ON public.orders TO synapsor_writer;
