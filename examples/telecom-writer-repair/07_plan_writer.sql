\set ON_ERROR_STOP on

-- Disposable telecom tutorial fixture only. Never run against an unrelated DB.
-- A new role, not a replacement or privilege change to the shared writer.
CREATE ROLE synapsor_plan_writer LOGIN PASSWORD 'synapsor_plan_writer_pw'
  NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT CONNECT ON DATABASE telecom_customer_service TO synapsor_plan_writer;
ALTER ROLE synapsor_plan_writer SET statement_timeout = '5s';
ALTER ROLE synapsor_plan_writer SET lock_timeout = '2s';

SET ROLE telecom_owner;
GRANT USAGE ON SCHEMA telecom TO synapsor_plan_writer;
GRANT EXECUTE ON FUNCTION telecom.is_active_member(uuid, uuid),
  telecom.can_manage_account(uuid, uuid) TO synapsor_plan_writer;
GRANT SELECT ON telecom.subscriptions, telecom.plan_change_offers TO synapsor_plan_writer;
GRANT UPDATE (plan_code, plan_display_name, base_monthly_cents, included_lines,
  data_policy, international_day_pass, effective_from, version)
  ON telecom.subscriptions TO synapsor_plan_writer;
-- PostgreSQL requires some UPDATE privilege for SELECT FOR UPDATE, even when
-- the offer is only privately verified. No business field is writable here.
GRANT UPDATE (plan_offer_id) ON telecom.plan_change_offers TO synapsor_plan_writer;

CREATE POLICY subscriptions_plan_writer ON telecom.subscriptions FOR UPDATE TO synapsor_plan_writer
USING (
  account_id = nullif(current_setting('synapsor.tenant_id', true), '')::uuid
  AND telecom.can_manage_account(account_id, nullif(current_setting('synapsor.principal', true), '')::uuid)
)
WITH CHECK (
  account_id = nullif(current_setting('synapsor.tenant_id', true), '')::uuid
  AND telecom.can_manage_account(account_id, nullif(current_setting('synapsor.principal', true), '')::uuid)
);
CREATE POLICY offers_plan_writer_lock ON telecom.plan_change_offers FOR UPDATE TO synapsor_plan_writer
USING (
  account_id = nullif(current_setting('synapsor.tenant_id', true), '')::uuid
  AND telecom.can_manage_account(account_id, nullif(current_setting('synapsor.principal', true), '')::uuid)
)
WITH CHECK (
  account_id = nullif(current_setting('synapsor.tenant_id', true), '')::uuid
  AND telecom.can_manage_account(account_id, nullif(current_setting('synapsor.principal', true), '')::uuid)
);
RESET ROLE;
