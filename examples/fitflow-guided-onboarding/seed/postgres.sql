DO $$
BEGIN
  CREATE ROLE fitflow_analytics_reader LOGIN PASSWORD 'fitflow_analytics_reader_password';
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE ROLE fitflow_trainer_reader LOGIN PASSWORD 'fitflow_trainer_reader_password';
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE ROLE fitflow_writer LOGIN PASSWORD 'fitflow_writer_password';
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE ROLE fitflow_setup LOGIN PASSWORD 'fitflow_setup_password';
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

ALTER ROLE fitflow_analytics_reader SET default_transaction_read_only = on;
ALTER ROLE fitflow_trainer_reader SET default_transaction_read_only = on;
ALTER ROLE fitflow_analytics_reader SET app.tenant_id = 'org-fitflow';

CREATE TABLE public.organizations (
  id text PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE public.locations (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  name text NOT NULL,
  region text NOT NULL CHECK (region IN ('central', 'east', 'north', 'south', 'west')),
  UNIQUE (organization_id, name)
);

CREATE TABLE public.trainers (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  display_name text NOT NULL
);

CREATE TABLE public.members (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  location_id text NOT NULL REFERENCES public.locations(id) ON DELETE RESTRICT,
  assigned_trainer_id text NOT NULL REFERENCES public.trainers(id) ON DELETE RESTRICT,
  membership_status text NOT NULL CHECK (membership_status IN ('active', 'frozen', 'cancelled')),
  membership_tier text NOT NULL CHECK (membership_tier IN ('basic', 'plus', 'elite')),
  loyalty_balance integer NOT NULL CHECK (loyalty_balance BETWEEN 0 AND 10000),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  payment_method text NOT NULL,
  home_address text NOT NULL,
  medical_waiver_notes text NOT NULL
);

CREATE INDEX members_trusted_scope_idx
  ON public.members(organization_id, assigned_trainer_id);

CREATE TABLE public.classes (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  location_id text NOT NULL REFERENCES public.locations(id) ON DELETE RESTRICT,
  trainer_id text NOT NULL REFERENCES public.trainers(id) ON DELETE RESTRICT,
  class_type text NOT NULL CHECK (class_type IN ('cycling', 'strength', 'yoga')),
  starts_at timestamptz NOT NULL
);

CREATE TABLE public.check_ins (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  location_id text NOT NULL REFERENCES public.locations(id) ON DELETE RESTRICT,
  member_id text NOT NULL REFERENCES public.members(id) ON DELETE RESTRICT,
  class_id text NOT NULL REFERENCES public.classes(id) ON DELETE RESTRICT,
  outcome text NOT NULL CHECK (outcome IN ('attended', 'late_cancel', 'no_show')),
  checked_in_at timestamptz NOT NULL
);

CREATE INDEX check_ins_tenant_time_idx
  ON public.check_ins(organization_id, checked_in_at);

-- A realistic application has much more schema than the first agent pack
-- needs. These metadata-only subsystems exercise whole-application review
-- without adding irrelevant rows to the onboarding result.
DO $$
DECLARE
  relation_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'plans',
    'membership_events',
    'membership_freezes',
    'membership_cancellations',
    'class_bookings',
    'class_waitlists',
    'attendance_adjustments',
    'trainer_certifications',
    'trainer_schedules',
    'staff_users',
    'staff_roles',
    'location_hours',
    'rooms',
    'equipment',
    'equipment_maintenance',
    'workout_programs',
    'workout_exercises',
    'member_goals',
    'body_metrics',
    'health_flags',
    'waivers',
    'billing_accounts',
    'payment_methods',
    'invoices',
    'invoice_items',
    'payments',
    'refunds',
    'promo_codes',
    'member_promotions',
    'leads',
    'referrals',
    'campaigns',
    'notification_preferences',
    'support_tickets'
  ]
  LOOP
    EXECUTE format(
      'CREATE TABLE public.%I (
        id text PRIMARY KEY,
        organization_id text NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
        status text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )',
      relation_name
    );
  END LOOP;
END
$$;

INSERT INTO public.organizations (id, name) VALUES
  ('org-fitflow', 'FitFlow'),
  ('org-other', 'Other Fitness');

INSERT INTO public.locations (id, organization_id, name, region) VALUES
  ('loc-downtown', 'org-fitflow', 'Downtown', 'central'),
  ('loc-east', 'org-fitflow', 'Eastside', 'east'),
  ('loc-north', 'org-fitflow', 'North Loop', 'north'),
  ('loc-other', 'org-other', 'Other Downtown', 'west');

INSERT INTO public.trainers (id, organization_id, display_name) VALUES
  ('trainer-alex', 'org-fitflow', 'Alex'),
  ('trainer-jordan', 'org-fitflow', 'Jordan'),
  ('trainer-other', 'org-other', 'Other Trainer');

WITH member_rows AS (
  SELECT
    item,
    CASE
      WHEN item <= 12 THEN 'loc-downtown'
      WHEN item <= 22 THEN 'loc-east'
      ELSE 'loc-north'
    END AS location_id,
    CASE WHEN item % 2 = 0 THEN 'trainer-alex' ELSE 'trainer-jordan' END AS trainer_id,
    CASE WHEN item % 7 = 0 THEN 'frozen' ELSE 'active' END AS status,
    CASE WHEN item % 3 = 0 THEN 'elite' WHEN item % 2 = 0 THEN 'plus' ELSE 'basic' END AS tier
  FROM generate_series(1, 30) AS item
)
INSERT INTO public.members (
  id,
  organization_id,
  location_id,
  assigned_trainer_id,
  membership_status,
  membership_tier,
  loyalty_balance,
  version,
  payment_method,
  home_address,
  medical_waiver_notes
)
SELECT
  'member-' || lpad(item::text, 3, '0'),
  'org-fitflow',
  location_id,
  trainer_id,
  status,
  tier,
  item * 10,
  1,
  'synthetic-card-token-' || item,
  item || ' Synthetic Street',
  'synthetic private medical note ' || item
FROM member_rows;

INSERT INTO public.members (
  id,
  organization_id,
  location_id,
  assigned_trainer_id,
  membership_status,
  membership_tier,
  loyalty_balance,
  version,
  payment_method,
  home_address,
  medical_waiver_notes
) VALUES (
  'other-member-001',
  'org-other',
  'loc-other',
  'trainer-other',
  'active',
  'elite',
  9999,
  1,
  'other-secret-payment',
  'Other Tenant Address',
  'other tenant private medical note'
);

INSERT INTO public.classes (id, organization_id, location_id, trainer_id, class_type, starts_at) VALUES
  ('class-downtown-w1', 'org-fitflow', 'loc-downtown', 'trainer-alex', 'strength', '2026-07-06T17:00:00Z'),
  ('class-downtown-w2', 'org-fitflow', 'loc-downtown', 'trainer-alex', 'cycling', '2026-07-13T17:00:00Z'),
  ('class-east-w1', 'org-fitflow', 'loc-east', 'trainer-jordan', 'yoga', '2026-07-06T18:00:00Z'),
  ('class-north-w2', 'org-fitflow', 'loc-north', 'trainer-jordan', 'strength', '2026-07-13T18:00:00Z'),
  ('class-other', 'org-other', 'loc-other', 'trainer-other', 'cycling', '2026-07-13T19:00:00Z');

WITH groups(prefix, organization_id, location_id, class_id, outcome, checked_in_at, first_member, group_size) AS (
  VALUES
    ('downtown-w1', 'org-fitflow', 'loc-downtown', 'class-downtown-w1', 'attended', '2026-07-06T17:00:00Z'::timestamptz, 1, 6),
    ('downtown-w2', 'org-fitflow', 'loc-downtown', 'class-downtown-w2', 'attended', '2026-07-13T17:00:00Z'::timestamptz, 1, 9),
    ('east-w1', 'org-fitflow', 'loc-east', 'class-east-w1', 'late_cancel', '2026-07-06T18:00:00Z'::timestamptz, 13, 5),
    ('north-w2', 'org-fitflow', 'loc-north', 'class-north-w2', 'no_show', '2026-07-13T18:00:00Z'::timestamptz, 23, 2)
)
INSERT INTO public.check_ins (
  id,
  organization_id,
  location_id,
  member_id,
  class_id,
  outcome,
  checked_in_at
)
SELECT
  'checkin-' || prefix || '-' || item,
  organization_id,
  location_id,
  'member-' || lpad((first_member + item - 1)::text, 3, '0'),
  class_id,
  outcome,
  checked_in_at
FROM groups
CROSS JOIN LATERAL generate_series(1, group_size) AS item;

INSERT INTO public.check_ins (
  id,
  organization_id,
  location_id,
  member_id,
  class_id,
  outcome,
  checked_in_at
)
SELECT
  'other-checkin-' || item,
  'org-other',
  'loc-other',
  'other-member-001',
  'class-other',
  'attended',
  '2026-07-13T19:00:00Z'::timestamptz
FROM generate_series(1, 8) AS item;

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.locations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.trainers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trainers FORCE ROW LEVEL SECURITY;
ALTER TABLE public.members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.members FORCE ROW LEVEL SECURITY;
ALTER TABLE public.classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.classes FORCE ROW LEVEL SECURITY;
ALTER TABLE public.check_ins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.check_ins FORCE ROW LEVEL SECURITY;

CREATE POLICY organizations_org_read ON public.organizations
  FOR SELECT TO fitflow_analytics_reader, fitflow_trainer_reader, fitflow_writer
  USING (id = current_setting('app.tenant_id', true));

CREATE POLICY locations_org_read ON public.locations
  FOR SELECT TO fitflow_analytics_reader, fitflow_trainer_reader, fitflow_writer
  USING (organization_id = current_setting('app.tenant_id', true));

CREATE POLICY trainers_org_read ON public.trainers
  FOR SELECT TO fitflow_analytics_reader, fitflow_trainer_reader, fitflow_writer
  USING (organization_id = current_setting('app.tenant_id', true));

CREATE POLICY members_analytics_read ON public.members
  FOR SELECT TO fitflow_analytics_reader
  USING (organization_id = current_setting('app.tenant_id', true));

CREATE POLICY members_trainer_read ON public.members
  FOR SELECT TO fitflow_trainer_reader, fitflow_writer
  USING (
    organization_id = current_setting('app.tenant_id', true)
    AND assigned_trainer_id = current_setting('app.principal', true)
  );

CREATE POLICY members_guarded_update ON public.members
  FOR UPDATE TO fitflow_writer
  USING (
    organization_id = current_setting('app.tenant_id', true)
    AND assigned_trainer_id = current_setting('app.principal', true)
  )
  WITH CHECK (
    organization_id = current_setting('app.tenant_id', true)
    AND assigned_trainer_id = current_setting('app.principal', true)
  );

CREATE POLICY classes_org_read ON public.classes
  FOR SELECT TO fitflow_analytics_reader, fitflow_trainer_reader, fitflow_writer
  USING (organization_id = current_setting('app.tenant_id', true));

CREATE POLICY check_ins_org_read ON public.check_ins
  FOR SELECT TO fitflow_analytics_reader
  USING (organization_id = current_setting('app.tenant_id', true));

DO $$
DECLARE
  relation_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'plans',
    'membership_events',
    'membership_freezes',
    'membership_cancellations',
    'class_bookings',
    'class_waitlists',
    'attendance_adjustments',
    'trainer_certifications',
    'trainer_schedules',
    'staff_users',
    'staff_roles',
    'location_hours',
    'rooms',
    'equipment',
    'equipment_maintenance',
    'workout_programs',
    'workout_exercises',
    'member_goals',
    'body_metrics',
    'health_flags',
    'waivers',
    'billing_accounts',
    'payment_methods',
    'invoices',
    'invoice_items',
    'payments',
    'refunds',
    'promo_codes',
    'member_promotions',
    'leads',
    'referrals',
    'campaigns',
    'notification_preferences',
    'support_tickets'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', relation_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', relation_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I
       FOR SELECT TO fitflow_analytics_reader
       USING (organization_id = current_setting(''app.tenant_id'', true))',
      relation_name || '_org_read',
      relation_name
    );
    EXECUTE format('GRANT SELECT ON public.%I TO fitflow_analytics_reader', relation_name);
  END LOOP;
END
$$;

GRANT CONNECT ON DATABASE fitflow TO fitflow_analytics_reader, fitflow_trainer_reader, fitflow_writer, fitflow_setup;
GRANT USAGE ON SCHEMA public TO fitflow_analytics_reader, fitflow_trainer_reader, fitflow_writer, fitflow_setup;
GRANT SELECT ON public.organizations, public.locations, public.trainers, public.members, public.classes, public.check_ins TO fitflow_analytics_reader;
GRANT SELECT ON public.organizations, public.locations, public.trainers, public.members, public.classes TO fitflow_trainer_reader;
GRANT SELECT, UPDATE (membership_status, loyalty_balance, version) ON public.members TO fitflow_writer;
GRANT CREATE ON SCHEMA public TO fitflow_setup;

CREATE TABLE public.synapsor_fixture_ready (
  initialized_at timestamptz NOT NULL
);
INSERT INTO public.synapsor_fixture_ready (initialized_at) VALUES (clock_timestamp());
