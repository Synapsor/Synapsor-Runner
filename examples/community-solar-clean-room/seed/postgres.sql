DO $$
BEGIN
  CREATE ROLE solar_technician_reader LOGIN PASSWORD 'solar_technician_reader_password';
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE ROLE solar_writer LOGIN PASSWORD 'solar_writer_password';
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE ROLE solar_setup LOGIN PASSWORD 'solar_setup_password';
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

ALTER ROLE solar_technician_reader SET default_transaction_read_only = on;

CREATE TABLE public.cooperatives (
  id text PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE public.regions (
  id text PRIMARY KEY,
  cooperative_id text NOT NULL REFERENCES public.cooperatives(id) ON DELETE RESTRICT,
  name text NOT NULL,
  climate_zone text NOT NULL,
  UNIQUE (cooperative_id, name)
);

CREATE TABLE public.technician_teams (
  id text PRIMARY KEY,
  cooperative_id text NOT NULL REFERENCES public.cooperatives(id) ON DELETE RESTRICT,
  name text NOT NULL,
  UNIQUE (cooperative_id, name)
);

CREATE TABLE public.technicians (
  id text PRIMARY KEY,
  cooperative_id text NOT NULL REFERENCES public.cooperatives(id) ON DELETE RESTRICT,
  team_id text NOT NULL REFERENCES public.technician_teams(id) ON DELETE RESTRICT,
  display_name text NOT NULL,
  private_technician_notes text NOT NULL
);

CREATE TABLE public.solar_sites (
  id text PRIMARY KEY,
  cooperative_id text NOT NULL REFERENCES public.cooperatives(id) ON DELETE RESTRICT,
  region_id text NOT NULL REFERENCES public.regions(id) ON DELETE RESTRICT,
  name text NOT NULL,
  site_group text NOT NULL,
  accounting_period text NOT NULL,
  UNIQUE (cooperative_id, name)
);

CREATE TABLE public.inverter_models (
  id text PRIMARY KEY,
  cooperative_id text NOT NULL REFERENCES public.cooperatives(id) ON DELETE RESTRICT,
  manufacturer text NOT NULL,
  model_name text NOT NULL,
  panel_position text NOT NULL,
  UNIQUE (cooperative_id, manufacturer, model_name)
);

CREATE TABLE public.inverters (
  id text PRIMARY KEY,
  cooperative_id text NOT NULL REFERENCES public.cooperatives(id) ON DELETE RESTRICT,
  site_id text NOT NULL REFERENCES public.solar_sites(id) ON DELETE RESTRICT,
  inverter_model_id text NOT NULL REFERENCES public.inverter_models(id) ON DELETE RESTRICT,
  serial_number text NOT NULL,
  status text NOT NULL CHECK (status IN ('online', 'degraded', 'offline')),
  access_token text NOT NULL,
  panel_position text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (cooperative_id, serial_number)
);

CREATE TABLE public.fault_categories (
  id text PRIMARY KEY,
  cooperative_id text NOT NULL REFERENCES public.cooperatives(id) ON DELETE RESTRICT,
  name text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  UNIQUE (cooperative_id, name)
);

CREATE TABLE public.work_orders (
  id text PRIMARY KEY,
  cooperative_id text NOT NULL REFERENCES public.cooperatives(id) ON DELETE RESTRICT,
  site_id text NOT NULL REFERENCES public.solar_sites(id) ON DELETE RESTRICT,
  region_id text NOT NULL REFERENCES public.regions(id) ON DELETE RESTRICT,
  inverter_model_id text NOT NULL REFERENCES public.inverter_models(id) ON DELETE RESTRICT,
  fault_category_id text NOT NULL REFERENCES public.fault_categories(id) ON DELETE RESTRICT,
  assigned_technician_id text NOT NULL REFERENCES public.technicians(id) ON DELETE RESTRICT,
  technician_team_id text NOT NULL REFERENCES public.technician_teams(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('open', 'in_progress', 'resolved', 'cancelled')),
  opened_at timestamptz NOT NULL,
  completed_at timestamptz,
  downtime_minutes integer NOT NULL CHECK (downtime_minutes BETWEEN 0 AND 10080),
  repair_duration_minutes integer NOT NULL CHECK (repair_duration_minutes BETWEEN 0 AND 10080),
  estimated_energy_loss_wh bigint NOT NULL CHECK (estimated_energy_loss_wh >= 0),
  lost_revenue_cents integer NOT NULL CHECK (lost_revenue_cents >= 0),
  inspection_failed boolean NOT NULL,
  payment_status text NOT NULL CHECK (payment_status IN ('not_applicable', 'pending', 'settled')),
  version integer NOT NULL DEFAULT 1,
  private_technician_notes text NOT NULL
);

CREATE INDEX work_orders_trusted_scope_idx
  ON public.work_orders(cooperative_id, assigned_technician_id, opened_at);

CREATE TABLE public.incidents (
  id text PRIMARY KEY,
  cooperative_id text NOT NULL REFERENCES public.cooperatives(id) ON DELETE RESTRICT,
  site_id text NOT NULL REFERENCES public.solar_sites(id) ON DELETE RESTRICT,
  region_id text NOT NULL REFERENCES public.regions(id) ON DELETE RESTRICT,
  inverter_model_id text NOT NULL REFERENCES public.inverter_models(id) ON DELETE RESTRICT,
  fault_category_id text NOT NULL REFERENCES public.fault_categories(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('open', 'monitoring', 'resolved')),
  occurred_at timestamptz NOT NULL,
  resolved_at timestamptz,
  downtime_minutes integer NOT NULL CHECK (downtime_minutes >= 0),
  estimated_energy_loss_wh bigint NOT NULL CHECK (estimated_energy_loss_wh >= 0)
);

CREATE TABLE public.meter_readings (
  id text PRIMARY KEY,
  cooperative_id text NOT NULL REFERENCES public.cooperatives(id) ON DELETE RESTRICT,
  site_id text NOT NULL REFERENCES public.solar_sites(id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL,
  energy_amount_wh bigint NOT NULL CHECK (energy_amount_wh >= 0),
  quality_status text NOT NULL CHECK (quality_status IN ('measured', 'estimated', 'rejected'))
);

CREATE TABLE public.inspections (
  id text PRIMARY KEY,
  cooperative_id text NOT NULL REFERENCES public.cooperatives(id) ON DELETE RESTRICT,
  site_id text NOT NULL REFERENCES public.solar_sites(id) ON DELETE RESTRICT,
  assigned_technician_id text NOT NULL REFERENCES public.technicians(id) ON DELETE RESTRICT,
  inspected_at timestamptz NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('passed', 'failed', 'follow_up')),
  failure_count integer NOT NULL CHECK (failure_count >= 0),
  private_technician_notes text NOT NULL
);

CREATE TABLE public.parts (
  id text PRIMARY KEY,
  cooperative_id text NOT NULL REFERENCES public.cooperatives(id) ON DELETE RESTRICT,
  sku text NOT NULL,
  category text NOT NULL,
  stock_quantity integer NOT NULL CHECK (stock_quantity >= 0),
  unit_cost_cents integer NOT NULL CHECK (unit_cost_cents >= 0),
  UNIQUE (cooperative_id, sku)
);

CREATE TABLE public.parts_reservations (
  id text PRIMARY KEY,
  cooperative_id text NOT NULL REFERENCES public.cooperatives(id) ON DELETE RESTRICT,
  work_order_id text NOT NULL REFERENCES public.work_orders(id) ON DELETE RESTRICT,
  part_id text NOT NULL REFERENCES public.parts(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 100),
  reserved_at timestamptz NOT NULL
);

CREATE TABLE public.members (
  id text PRIMARY KEY,
  cooperative_id text NOT NULL REFERENCES public.cooperatives(id) ON DELETE RESTRICT,
  display_name text NOT NULL,
  tax_id text NOT NULL,
  home_address text NOT NULL,
  membership_status text NOT NULL CHECK (membership_status IN ('active', 'paused', 'closed'))
);

CREATE TABLE public.payout_accounts (
  id text PRIMARY KEY,
  cooperative_id text NOT NULL REFERENCES public.cooperatives(id) ON DELETE RESTRICT,
  member_id text NOT NULL REFERENCES public.members(id) ON DELETE RESTRICT,
  bank_account_number text NOT NULL,
  routing_number text NOT NULL,
  card_on_file text NOT NULL,
  payment_status text NOT NULL CHECK (payment_status IN ('verified', 'pending', 'blocked'))
);

CREATE TABLE public.work_order_assignments (
  work_order_id text NOT NULL REFERENCES public.work_orders(id) ON DELETE CASCADE,
  technician_id text NOT NULL REFERENCES public.technicians(id) ON DELETE CASCADE,
  cooperative_id text NOT NULL REFERENCES public.cooperatives(id) ON DELETE RESTRICT,
  assigned_at timestamptz NOT NULL,
  PRIMARY KEY (work_order_id, technician_id)
);

CREATE TABLE public.site_groups (
  id text PRIMARY KEY,
  cooperative_id text NOT NULL REFERENCES public.cooperatives(id) ON DELETE RESTRICT,
  name text NOT NULL
);

CREATE TABLE public.site_group_memberships (
  site_group_id text NOT NULL REFERENCES public.site_groups(id) ON DELETE CASCADE,
  site_id text NOT NULL REFERENCES public.solar_sites(id) ON DELETE CASCADE,
  cooperative_id text NOT NULL REFERENCES public.cooperatives(id) ON DELETE RESTRICT,
  PRIMARY KEY (site_group_id, site_id)
);

CREATE TABLE public.energy_forecasts (
  id text PRIMARY KEY,
  cooperative_id text NOT NULL REFERENCES public.cooperatives(id) ON DELETE RESTRICT,
  site_id text NOT NULL REFERENCES public.solar_sites(id) ON DELETE RESTRICT,
  forecast_at timestamptz NOT NULL,
  energy_amount_wh bigint NOT NULL CHECK (energy_amount_wh >= 0),
  confidence_band text NOT NULL CHECK (confidence_band IN ('low', 'medium', 'high'))
);

DO $$
DECLARE
  relation_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'maintenance_windows',
    'weather_observations',
    'grid_connections',
    'curtailment_events',
    'battery_assets',
    'battery_cycles',
    'panel_arrays',
    'warranty_claims',
    'supplier_orders',
    'supplier_invoices',
    'member_subscriptions',
    'member_credits',
    'payout_runs',
    'payout_line_items',
    'compliance_checks',
    'safety_training',
    'technician_schedules',
    'incident_comments',
    'notification_preferences',
    'audit_events'
  ]
  LOOP
    EXECUTE format(
      'CREATE TABLE public.%I (
        id text PRIMARY KEY,
        cooperative_id text NOT NULL REFERENCES public.cooperatives(id) ON DELETE RESTRICT,
        status text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )',
      relation_name
    );
  END LOOP;
END
$$;

INSERT INTO public.cooperatives (id, name) VALUES
  ('coop-sunward', 'Sunward Community Energy'),
  ('coop-riverbend', 'Riverbend Solar Cooperative');

INSERT INTO public.regions (id, cooperative_id, name, climate_zone) VALUES
  ('region-north', 'coop-sunward', 'North Valley', 'cool'),
  ('region-coast', 'coop-sunward', 'Coastal Plain', 'marine'),
  ('region-desert', 'coop-sunward', 'High Desert', 'arid'),
  ('region-other', 'coop-riverbend', 'River District', 'humid');

INSERT INTO public.technician_teams (id, cooperative_id, name) VALUES
  ('team-field-a', 'coop-sunward', 'Field Reliability A'),
  ('team-field-b', 'coop-sunward', 'Field Reliability B'),
  ('team-other', 'coop-riverbend', 'River Team');

INSERT INTO public.technicians (
  id, cooperative_id, team_id, display_name, private_technician_notes
) VALUES
  ('tech-alex', 'coop-sunward', 'team-field-a', 'Alex', 'private synthetic personnel note'),
  ('tech-jordan', 'coop-sunward', 'team-field-b', 'Jordan', 'private synthetic personnel note'),
  ('tech-other', 'coop-riverbend', 'team-other', 'Other Technician', 'other tenant private note');

INSERT INTO public.solar_sites (
  id, cooperative_id, region_id, name, site_group, accounting_period
) VALUES
  ('site-north-1', 'coop-sunward', 'region-north', 'North Orchard', 'orchard', '2026-Q3'),
  ('site-coast-1', 'coop-sunward', 'region-coast', 'Coastal School', 'public', '2026-Q3'),
  ('site-desert-1', 'coop-sunward', 'region-desert', 'Desert Commons', 'residential', '2026-Q3'),
  ('site-other', 'coop-riverbend', 'region-other', 'River Array', 'public', '2026-Q3');

INSERT INTO public.inverter_models (
  id, cooperative_id, manufacturer, model_name, panel_position
) VALUES
  ('model-a', 'coop-sunward', 'HelioWorks', 'HX-400', 'north rack'),
  ('model-b', 'coop-sunward', 'GridBright', 'GB-22', 'central rack'),
  ('model-other', 'coop-riverbend', 'Other Energy', 'OE-9', 'east rack');

INSERT INTO public.inverters (
  id, cooperative_id, site_id, inverter_model_id, serial_number, status,
  access_token, panel_position, version
) VALUES
  ('inv-north', 'coop-sunward', 'site-north-1', 'model-a', 'SYN-N-001', 'online', 'synthetic-access-token-north', 'north rack', 1),
  ('inv-coast', 'coop-sunward', 'site-coast-1', 'model-b', 'SYN-C-001', 'degraded', 'synthetic-access-token-coast', 'central rack', 1),
  ('inv-desert', 'coop-sunward', 'site-desert-1', 'model-a', 'SYN-D-001', 'online', 'synthetic-access-token-desert', 'west rack', 1),
  ('inv-other', 'coop-riverbend', 'site-other', 'model-other', 'OTH-001', 'online', 'other-secret-token', 'east rack', 1);

INSERT INTO public.fault_categories (id, cooperative_id, name, severity) VALUES
  ('fault-cooling', 'coop-sunward', 'Cooling', 'medium'),
  ('fault-grid', 'coop-sunward', 'Grid Sync', 'high'),
  ('fault-sensor', 'coop-sunward', 'Sensor', 'low'),
  ('fault-other', 'coop-riverbend', 'Other Fault', 'high');

WITH generated AS (
  SELECT
    item,
    CASE item % 3 WHEN 0 THEN 'site-north-1' WHEN 1 THEN 'site-coast-1' ELSE 'site-desert-1' END AS site_id,
    CASE item % 3 WHEN 0 THEN 'region-north' WHEN 1 THEN 'region-coast' ELSE 'region-desert' END AS region_id,
    CASE item % 2 WHEN 0 THEN 'model-a' ELSE 'model-b' END AS model_id,
    CASE item % 3 WHEN 0 THEN 'fault-cooling' WHEN 1 THEN 'fault-grid' ELSE 'fault-sensor' END AS fault_id,
    CASE WHEN item <= 27 THEN 'tech-alex' ELSE 'tech-jordan' END AS technician_id,
    CASE WHEN item <= 27 THEN 'team-field-a' ELSE 'team-field-b' END AS team_id,
    CASE WHEN item % 5 = 0 THEN 'open' WHEN item % 2 = 0 THEN 'resolved' ELSE 'in_progress' END AS work_status,
    ('2026-06-29T09:00:00Z'::timestamptz + (item % 21) * interval '1 day') AS opened_at
  FROM generate_series(1, 36) AS item
)
INSERT INTO public.work_orders (
  id, cooperative_id, site_id, region_id, inverter_model_id, fault_category_id,
  assigned_technician_id, technician_team_id, status, opened_at, completed_at,
  downtime_minutes, repair_duration_minutes, estimated_energy_loss_wh,
  lost_revenue_cents, inspection_failed, payment_status, version,
  private_technician_notes
)
SELECT
  'wo-' || lpad(item::text, 3, '0'),
  'coop-sunward',
  site_id,
  region_id,
  model_id,
  fault_id,
  technician_id,
  team_id,
  work_status,
  opened_at,
  CASE WHEN work_status = 'resolved' THEN opened_at + interval '3 hours' ELSE NULL END,
  item * 7,
  item * 5,
  item * 1100,
  item * 75,
  item % 7 = 0,
  CASE WHEN item % 4 = 0 THEN 'pending' ELSE 'not_applicable' END,
  1,
  'synthetic private work note ' || item
FROM generated;

INSERT INTO public.work_orders (
  id, cooperative_id, site_id, region_id, inverter_model_id, fault_category_id,
  assigned_technician_id, technician_team_id, status, opened_at, completed_at,
  downtime_minutes, repair_duration_minutes, estimated_energy_loss_wh,
  lost_revenue_cents, inspection_failed, payment_status, version,
  private_technician_notes
) VALUES (
  'wo-other-001', 'coop-riverbend', 'site-other', 'region-other', 'model-other',
  'fault-other', 'tech-other', 'team-other', 'open', '2026-07-14T09:00:00Z',
  NULL, 999, 999, 999999, 99999, true, 'pending', 1,
  'other tenant private work note'
);

INSERT INTO public.incidents (
  id, cooperative_id, site_id, region_id, inverter_model_id, fault_category_id,
  status, occurred_at, resolved_at, downtime_minutes, estimated_energy_loss_wh
)
SELECT
  'incident-' || lpad(item::text, 3, '0'),
  'coop-sunward',
  CASE item % 3 WHEN 0 THEN 'site-north-1' WHEN 1 THEN 'site-coast-1' ELSE 'site-desert-1' END,
  CASE item % 3 WHEN 0 THEN 'region-north' WHEN 1 THEN 'region-coast' ELSE 'region-desert' END,
  CASE item % 2 WHEN 0 THEN 'model-a' ELSE 'model-b' END,
  CASE item % 3 WHEN 0 THEN 'fault-cooling' WHEN 1 THEN 'fault-grid' ELSE 'fault-sensor' END,
  CASE WHEN item % 4 = 0 THEN 'open' ELSE 'resolved' END,
  '2026-06-29T08:00:00Z'::timestamptz + (item % 21) * interval '1 day',
  CASE WHEN item % 4 = 0 THEN NULL ELSE '2026-06-29T10:00:00Z'::timestamptz + (item % 21) * interval '1 day' END,
  item * 8,
  item * 900
FROM generate_series(1, 36) AS item;

INSERT INTO public.meter_readings (
  id, cooperative_id, site_id, recorded_at, energy_amount_wh, quality_status
)
SELECT
  'reading-' || item,
  'coop-sunward',
  CASE item % 3 WHEN 0 THEN 'site-north-1' WHEN 1 THEN 'site-coast-1' ELSE 'site-desert-1' END,
  '2026-07-01T00:00:00Z'::timestamptz + item * interval '6 hours',
  100000 + item * 250,
  CASE WHEN item % 11 = 0 THEN 'estimated' ELSE 'measured' END
FROM generate_series(1, 60) AS item;

INSERT INTO public.inspections (
  id, cooperative_id, site_id, assigned_technician_id, inspected_at, outcome,
  failure_count, private_technician_notes
)
SELECT
  'inspection-' || item,
  'coop-sunward',
  CASE item % 3 WHEN 0 THEN 'site-north-1' WHEN 1 THEN 'site-coast-1' ELSE 'site-desert-1' END,
  CASE WHEN item <= 15 THEN 'tech-alex' ELSE 'tech-jordan' END,
  '2026-07-01T11:00:00Z'::timestamptz + item * interval '1 day',
  CASE WHEN item % 5 = 0 THEN 'failed' ELSE 'passed' END,
  CASE WHEN item % 5 = 0 THEN 1 ELSE 0 END,
  'synthetic private inspection note ' || item
FROM generate_series(1, 18) AS item;

INSERT INTO public.parts (id, cooperative_id, sku, category, stock_quantity, unit_cost_cents) VALUES
  ('part-fan', 'coop-sunward', 'FAN-01', 'cooling', 20, 4500),
  ('part-sensor', 'coop-sunward', 'SNS-02', 'sensor', 35, 1800),
  ('part-other', 'coop-riverbend', 'OTH-01', 'other', 5, 9999);

INSERT INTO public.parts_reservations (
  id, cooperative_id, work_order_id, part_id, quantity, reserved_at
) VALUES
  ('reserve-1', 'coop-sunward', 'wo-001', 'part-fan', 1, '2026-07-01T12:00:00Z'),
  ('reserve-2', 'coop-sunward', 'wo-002', 'part-sensor', 2, '2026-07-02T12:00:00Z');

INSERT INTO public.members (
  id, cooperative_id, display_name, tax_id, home_address, membership_status
) VALUES
  ('member-1', 'coop-sunward', 'Synthetic Member 1', 'SYN-TAX-001', '1 Synthetic Solar Way', 'active'),
  ('member-2', 'coop-sunward', 'Synthetic Member 2', 'SYN-TAX-002', '2 Synthetic Solar Way', 'active'),
  ('member-other', 'coop-riverbend', 'Other Member', 'OTHER-TAX', 'Other Tenant Address', 'active');

INSERT INTO public.payout_accounts (
  id, cooperative_id, member_id, bank_account_number, routing_number,
  card_on_file, payment_status
) VALUES
  ('payout-1', 'coop-sunward', 'member-1', 'SYNTHETIC-BANK-001', 'SYNTHETIC-ROUTING-001', 'SYNTHETIC-CARD-001', 'verified'),
  ('payout-2', 'coop-sunward', 'member-2', 'SYNTHETIC-BANK-002', 'SYNTHETIC-ROUTING-002', 'SYNTHETIC-CARD-002', 'pending'),
  ('payout-other', 'coop-riverbend', 'member-other', 'OTHER-BANK', 'OTHER-ROUTING', 'OTHER-CARD', 'verified');

INSERT INTO public.work_order_assignments (
  work_order_id, technician_id, cooperative_id, assigned_at
) VALUES
  ('wo-001', 'tech-alex', 'coop-sunward', '2026-07-01T09:00:00Z'),
  ('wo-001', 'tech-jordan', 'coop-sunward', '2026-07-01T09:05:00Z');

INSERT INTO public.site_groups (id, cooperative_id, name) VALUES
  ('group-a', 'coop-sunward', 'Priority Sites'),
  ('group-b', 'coop-sunward', 'School Sites');

INSERT INTO public.site_group_memberships (
  site_group_id, site_id, cooperative_id
) VALUES
  ('group-a', 'site-north-1', 'coop-sunward'),
  ('group-a', 'site-coast-1', 'coop-sunward'),
  ('group-b', 'site-coast-1', 'coop-sunward');

INSERT INTO public.energy_forecasts (
  id, cooperative_id, site_id, forecast_at, energy_amount_wh, confidence_band
) VALUES
  ('forecast-1', 'coop-sunward', 'site-north-1', '2026-07-21T00:00:00Z', 250000, 'high'),
  ('forecast-2', 'coop-sunward', 'site-coast-1', '2026-07-21T00:00:00Z', 180000, 'medium');

ALTER TABLE public.cooperatives ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cooperatives FORCE ROW LEVEL SECURITY;

CREATE POLICY cooperatives_scope ON public.cooperatives
  FOR SELECT TO solar_technician_reader, solar_writer
  USING (id = current_setting('app.tenant_id', true));

DO $$
DECLARE
  relation_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'regions',
    'technician_teams',
    'technicians',
    'solar_sites',
    'inverter_models',
    'inverters',
    'fault_categories',
    'incidents',
    'meter_readings',
    'parts',
    'parts_reservations',
    'members',
    'payout_accounts',
    'work_order_assignments',
    'site_groups',
    'site_group_memberships',
    'energy_forecasts',
    'maintenance_windows',
    'weather_observations',
    'grid_connections',
    'curtailment_events',
    'battery_assets',
    'battery_cycles',
    'panel_arrays',
    'warranty_claims',
    'supplier_orders',
    'supplier_invoices',
    'member_subscriptions',
    'member_credits',
    'payout_runs',
    'payout_line_items',
    'compliance_checks',
    'safety_training',
    'technician_schedules',
    'incident_comments',
    'notification_preferences',
    'audit_events'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', relation_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', relation_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I
       FOR SELECT TO solar_technician_reader, solar_writer
       USING (cooperative_id = current_setting(''app.tenant_id'', true))',
      relation_name || '_cooperative_scope',
      relation_name
    );
  END LOOP;
END
$$;

ALTER TABLE public.work_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY work_orders_technician_read ON public.work_orders
  FOR SELECT TO solar_technician_reader, solar_writer
  USING (
    cooperative_id = current_setting('app.tenant_id', true)
    AND assigned_technician_id = current_setting('app.principal', true)
  );
CREATE POLICY work_orders_guarded_update ON public.work_orders
  FOR UPDATE TO solar_writer
  USING (
    cooperative_id = current_setting('app.tenant_id', true)
    AND assigned_technician_id = current_setting('app.principal', true)
  )
  WITH CHECK (
    cooperative_id = current_setting('app.tenant_id', true)
    AND assigned_technician_id = current_setting('app.principal', true)
  );

ALTER TABLE public.inspections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inspections FORCE ROW LEVEL SECURITY;
CREATE POLICY inspections_technician_read ON public.inspections
  FOR SELECT TO solar_technician_reader, solar_writer
  USING (
    cooperative_id = current_setting('app.tenant_id', true)
    AND assigned_technician_id = current_setting('app.principal', true)
  );

GRANT CONNECT ON DATABASE community_solar TO solar_technician_reader, solar_writer, solar_setup;
GRANT USAGE ON SCHEMA public TO solar_technician_reader, solar_writer, solar_setup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO solar_technician_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO solar_writer;
GRANT UPDATE (
  status,
  downtime_minutes,
  repair_duration_minutes,
  estimated_energy_loss_wh,
  lost_revenue_cents,
  inspection_failed,
  payment_status,
  version
) ON public.work_orders TO solar_writer;
GRANT CREATE ON SCHEMA public TO solar_setup;

CREATE TABLE public.synapsor_fixture_ready (
  initialized_at timestamptz NOT NULL
);
INSERT INTO public.synapsor_fixture_ready (initialized_at) VALUES (clock_timestamp());
