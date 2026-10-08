-- ADMINISTRATOR REVIEW REQUIRED. Runner never executes this file.
-- Creates a NEW, initially NOLOGIN role. Does not alter shared roles, RLS, or source rows.
-- Inspect requirements.json and README.md before running against the intended database.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE ROLE "runner_writer_02600f4809e3" NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
DO $runner_connect$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), 'runner_writer_02600f4809e3'); END $runner_connect$;
GRANT USAGE ON SCHEMA "telecom" TO "runner_writer_02600f4809e3";
GRANT SELECT ON TABLE "telecom"."subscriptions" TO "runner_writer_02600f4809e3";
GRANT UPDATE ("base_monthly_cents", "data_policy", "effective_from", "included_lines", "international_day_pass", "plan_code", "plan_display_name", "version") ON TABLE "telecom"."subscriptions" TO "runner_writer_02600f4809e3";
GRANT SELECT ON TABLE "telecom"."plan_change_offers" TO "runner_writer_02600f4809e3";
GRANT UPDATE ("plan_offer_id", "status", "version") ON TABLE "telecom"."plan_change_offers" TO "runner_writer_02600f4809e3";
ALTER ROLE "runner_writer_02600f4809e3" SET statement_timeout = '5s';
ALTER ROLE "runner_writer_02600f4809e3" SET lock_timeout = '2s';
COMMIT;

-- A column UPDATE grant used for row locking is real database mutation authority on that column; it is not a lock-only PostgreSQL permission.
-- STILL REQUIRED: review scoped policies, helper-function access, defaults/sequences and triggers.
-- RLS-backed targets require ENABLE and FORCE ROW LEVEL SECURITY. See requirements.json; this file does not change RLS.
-- Do not copy an unrestricted policy or grant membership in the shared writer role.
-- After review, configure authentication and LOGIN separately. Never put credentials in this file.
-- Recheck this connection in Runner. Execution consent and a running worker are still required.
