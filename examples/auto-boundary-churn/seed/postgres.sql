CREATE TABLE public.accounts (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  owner_id text NOT NULL,
  region text NOT NULL CHECK (region IN ('east', 'north', 'south', 'west')),
  segment text NOT NULL CHECK (segment IN ('enterprise', 'growth', 'startup')),
  customer_email text NOT NULL,
  internal_risk_score integer NOT NULL
);

CREATE TABLE public.churn_events (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  owner_id text NOT NULL,
  account_id text NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  reason_category text NOT NULL CHECK (reason_category IN ('onboarding', 'price', 'product', 'service')),
  monthly_revenue_cents integer NOT NULL CHECK (monthly_revenue_cents >= 0),
  churned_at timestamptz NOT NULL,
  private_note text NOT NULL
);

CREATE INDEX churn_events_tenant_time_idx
  ON public.churn_events(tenant_id, churned_at);

WITH groups(prefix, tenant_id, owner_id, region, segment, reason_category, churned_at, group_size, revenue) AS (
  VALUES
    ('p1-west-price', 'acme', 'pm-1', 'west', 'growth', 'price', '2026-06-03T12:00:00Z'::timestamptz, 5, 12000),
    ('p1-east-service', 'acme', 'pm-1', 'east', 'enterprise', 'service', '2026-06-10T12:00:00Z'::timestamptz, 5, 22000),
    ('p1-north-product', 'acme', 'pm-1', 'north', 'startup', 'product', '2026-06-17T12:00:00Z'::timestamptz, 2, 5000),
    ('p2-west-price', 'acme', 'pm-1', 'west', 'growth', 'price', '2026-07-08T12:00:00Z'::timestamptz, 10, 13000),
    ('p2-east-service', 'acme', 'pm-1', 'east', 'enterprise', 'service', '2026-07-15T12:00:00Z'::timestamptz, 7, 23000),
    ('p2-south-onboarding', 'acme', 'pm-1', 'south', 'startup', 'onboarding', '2026-07-22T12:00:00Z'::timestamptz, 5, 7000),
    ('p2-north-product', 'acme', 'pm-1', 'north', 'startup', 'product', '2026-07-22T12:00:00Z'::timestamptz, 1, 6000),
    ('other-west-price', 'globex', 'pm-2', 'west', 'enterprise', 'price', '2026-07-08T12:00:00Z'::timestamptz, 8, 99000)
)
INSERT INTO public.accounts (
  id,
  tenant_id,
  owner_id,
  region,
  segment,
  customer_email,
  internal_risk_score
)
SELECT
  prefix || '-' || item,
  tenant_id,
  owner_id,
  region,
  segment,
  prefix || '-' || item || '@example.invalid',
  900 + item
FROM groups
CROSS JOIN LATERAL generate_series(1, group_size) AS item;

WITH groups(prefix, tenant_id, owner_id, reason_category, churned_at, group_size, revenue) AS (
  VALUES
    ('p1-west-price', 'acme', 'pm-1', 'price', '2026-06-03T12:00:00Z'::timestamptz, 5, 12000),
    ('p1-east-service', 'acme', 'pm-1', 'service', '2026-06-10T12:00:00Z'::timestamptz, 5, 22000),
    ('p1-north-product', 'acme', 'pm-1', 'product', '2026-06-17T12:00:00Z'::timestamptz, 2, 5000),
    ('p2-west-price', 'acme', 'pm-1', 'price', '2026-07-08T12:00:00Z'::timestamptz, 10, 13000),
    ('p2-east-service', 'acme', 'pm-1', 'service', '2026-07-15T12:00:00Z'::timestamptz, 7, 23000),
    ('p2-south-onboarding', 'acme', 'pm-1', 'onboarding', '2026-07-22T12:00:00Z'::timestamptz, 5, 7000),
    ('p2-north-product', 'acme', 'pm-1', 'product', '2026-07-22T12:00:00Z'::timestamptz, 1, 6000),
    ('other-west-price', 'globex', 'pm-2', 'price', '2026-07-08T12:00:00Z'::timestamptz, 8, 99000)
)
INSERT INTO public.churn_events (
  id,
  tenant_id,
  owner_id,
  account_id,
  reason_category,
  monthly_revenue_cents,
  churned_at,
  private_note
)
SELECT
  'event-' || prefix || '-' || item,
  tenant_id,
  owner_id,
  prefix || '-' || item,
  reason_category,
  revenue,
  churned_at,
  'synthetic kept-out note ' || prefix || '-' || item
FROM groups
CROSS JOIN LATERAL generate_series(1, group_size) AS item;

ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.churn_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.churn_events FORCE ROW LEVEL SECURITY;

CREATE POLICY accounts_trusted_scope ON public.accounts
  FOR SELECT
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    AND owner_id = current_setting('app.principal', true)
  );

CREATE POLICY churn_events_trusted_scope ON public.churn_events
  FOR SELECT
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    AND owner_id = current_setting('app.principal', true)
  );

DO $$
BEGIN
  CREATE ROLE synapsor_churn_reader LOGIN PASSWORD 'synapsor_churn_reader_password';
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

ALTER ROLE synapsor_churn_reader SET default_transaction_read_only = on;
GRANT CONNECT ON DATABASE synapsor_auto_boundary TO synapsor_churn_reader;
GRANT USAGE ON SCHEMA public TO synapsor_churn_reader;
GRANT SELECT ON public.accounts, public.churn_events TO synapsor_churn_reader;

-- The image entrypoint runs these statements under a temporary postmaster and
-- then restarts PostgreSQL. Compose reports healthy only after that final
-- postmaster starts, preventing first-client disconnects in CI.
CREATE TABLE public.synapsor_fixture_ready (
  initialized_at timestamptz NOT NULL
);
INSERT INTO public.synapsor_fixture_ready (initialized_at) VALUES (clock_timestamp());
