\set ON_ERROR_STOP on

BEGIN;
SET LOCAL synapsor.tenant_id = '2dd71876-6411-2e3c-95c6-6215b460277d';
SET LOCAL synapsor.principal = '13af9697-910a-68b4-e4d2-f95bc852c705';
DO $$
DECLARE
  col record;
  tbl record;
  expected boolean;
  n integer;
BEGIN
  IF current_user <> 'synapsor_plan_writer' THEN RAISE EXCEPTION 'Use the dedicated plan writer'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = current_user)) THEN
    RAISE EXCEPTION 'Writer has privileged role attributes or membership';
  END IF;
  FOR tbl IN SELECT c.oid, n.nspname, c.relname, c.relrowsecurity, c.relowner
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('telecom', 'synapsor_app') AND c.relkind IN ('r', 'p') LOOP
    IF tbl.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) THEN RAISE EXCEPTION 'Writer owns a relation'; END IF;
    expected := tbl.nspname = 'telecom' AND tbl.relname IN ('subscriptions', 'plan_change_offers');
    IF has_table_privilege(current_user, tbl.oid, 'SELECT') <> expected
      OR has_table_privilege(current_user, tbl.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
      RAISE EXCEPTION 'Unexpected table permissions for %.%', tbl.nspname, tbl.relname;
    END IF;
    IF expected AND NOT tbl.relrowsecurity THEN RAISE EXCEPTION 'Required RLS disabled'; END IF;
    FOR col IN SELECT a.attname FROM pg_attribute a WHERE a.attrelid = tbl.oid AND a.attnum > 0 AND NOT a.attisdropped LOOP
      expected := tbl.nspname = 'telecom' AND (
        tbl.relname = 'subscriptions' AND col.attname = ANY(ARRAY['plan_code', 'plan_display_name', 'base_monthly_cents', 'included_lines', 'data_policy', 'international_day_pass', 'effective_from', 'version'])
        OR tbl.relname = 'plan_change_offers' AND col.attname = 'plan_offer_id');
      IF has_column_privilege(current_user, tbl.oid, col.attname, 'UPDATE') <> expected
        OR has_column_privilege(current_user, tbl.oid, col.attname, 'INSERT,REFERENCES') THEN
        RAISE EXCEPTION 'Unexpected column permissions for %.%.%', tbl.nspname, tbl.relname, col.attname;
      END IF;
    END LOOP;
  END LOOP;
  PERFORM plan_offer_id FROM telecom.plan_change_offers FOR UPDATE;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN RAISE EXCEPTION 'Eligible fixture customer cannot lock any offer'; END IF;
  PERFORM subscription_id FROM telecom.subscriptions FOR UPDATE;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN RAISE EXCEPTION 'Eligible fixture customer cannot lock subscription'; END IF;
  UPDATE telecom.subscriptions SET version = version + 1;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN RAISE EXCEPTION 'Eligible fixture customer cannot update subscription'; END IF;
  UPDATE telecom.subscriptions SET version = version + 1 WHERE account_id <> '2dd71876-6411-2e3c-95c6-6215b460277d';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'Cross-tenant update reached rows'; END IF;
  PERFORM set_config('synapsor.principal', '00000000-0000-0000-0000-000000000000', true);
  PERFORM plan_offer_id FROM telecom.plan_change_offers FOR UPDATE;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'Unknown principal can lock offers'; END IF;
  UPDATE telecom.subscriptions SET version = version + 1;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'Unknown principal can update subscriptions'; END IF;
END
$$;
ROLLBACK;
SELECT 'PASS dedicated plan writer: exact columns, scoped locks, tenant/principal refusal; all writes rolled back. Runner must still check the actual compiled action.' AS result;
