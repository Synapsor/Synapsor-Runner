CREATE TABLE IF NOT EXISTS public.customers (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  customer_id text NOT NULL,
  plan text NOT NULL,
  invoice_status text NOT NULL,
  support_ticket_reason text NOT NULL,
  plan_credit_cents integer NOT NULL DEFAULT 0,
  credit_reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  card_token text,
  raw_payment_method text,
  internal_risk_score integer,
  private_notes text
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

INSERT INTO public.customers (
  id,
  tenant_id,
  customer_id,
  plan,
  invoice_status,
  support_ticket_reason,
  plan_credit_cents,
  credit_reason,
  updated_at,
  card_token,
  raw_payment_method,
  internal_risk_score,
  private_notes
)
VALUES
  (
    'CUS-3001',
    'acme',
    'CUS-3001',
    'enterprise',
    'open_dispute',
    'SLA outage ticket SUP-481 confirmed by support lead',
    0,
    NULL,
    '2026-06-20T14:31:08Z',
    'tok_fake_acme_3001',
    'fake_visa_4242',
    12,
    'fake internal note: do not expose'
  ),
  (
    'CUS-9001',
    'otherco',
    'CUS-9001',
    'starter',
    'paid',
    'OtherCo tenant row for spoof checks',
    0,
    NULL,
    '2026-06-20T14:31:08Z',
    'tok_fake_otherco_9001',
    'fake_mastercard_4444',
    77,
    'fake other tenant note'
  )
ON CONFLICT (id) DO UPDATE SET
  tenant_id = EXCLUDED.tenant_id,
  customer_id = EXCLUDED.customer_id,
  plan = EXCLUDED.plan,
  invoice_status = EXCLUDED.invoice_status,
  support_ticket_reason = EXCLUDED.support_ticket_reason,
  plan_credit_cents = EXCLUDED.plan_credit_cents,
  credit_reason = EXCLUDED.credit_reason,
  updated_at = EXCLUDED.updated_at,
  card_token = EXCLUDED.card_token,
  raw_payment_method = EXCLUDED.raw_payment_method,
  internal_risk_score = EXCLUDED.internal_risk_score,
  private_notes = EXCLUDED.private_notes;

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

GRANT CONNECT ON DATABASE synapsor_runner_plan_credit TO synapsor_reader, synapsor_writer;
GRANT USAGE ON SCHEMA public TO synapsor_reader, synapsor_writer;
GRANT SELECT ON public.customers TO synapsor_reader, synapsor_writer;
GRANT UPDATE (plan_credit_cents, credit_reason, updated_at) ON public.customers TO synapsor_writer;
GRANT SELECT, INSERT, UPDATE ON public.synapsor_writeback_receipts TO synapsor_writer;
