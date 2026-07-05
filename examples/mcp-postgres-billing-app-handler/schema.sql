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
  plan text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
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
  credit_requested_cents integer NOT NULL DEFAULT 0,
  credit_reason text,
  credited_cents integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.account_credits (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES public.tenants(id),
  invoice_id text NOT NULL REFERENCES public.invoices(id),
  customer_id text NOT NULL REFERENCES public.customers(id),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  reason text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
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

GRANT CONNECT ON DATABASE synapsor_billing_app_handler TO synapsor_reader, synapsor_writer;
GRANT USAGE ON SCHEMA public TO synapsor_reader, synapsor_writer;
GRANT CREATE ON SCHEMA public TO synapsor_writer;
GRANT SELECT ON public.tenants, public.customers, public.invoices, public.account_credits TO synapsor_reader, synapsor_writer;
GRANT UPDATE (late_fee_cents, waiver_reason, credit_requested_cents, credit_reason, credited_cents, updated_at) ON public.invoices TO synapsor_writer;
GRANT INSERT ON public.account_credits TO synapsor_writer;
