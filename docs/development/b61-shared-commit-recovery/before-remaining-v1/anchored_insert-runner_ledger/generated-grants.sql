-- ADMINISTRATOR REVIEW REQUIRED. Runner never executes this file.
-- Creates a NEW, initially NOLOGIN role. Does not alter shared roles, RLS, or source rows.
-- Inspect requirements.json and README.md before running against the intended database.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE ROLE "runner_writer_44516a361736" NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
DO $runner_connect$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), 'runner_writer_44516a361736'); END $runner_connect$;
GRANT USAGE ON SCHEMA "enquiry_native" TO "runner_writer_44516a361736";
GRANT SELECT ON TABLE "enquiry_native"."customers" TO "runner_writer_44516a361736";
GRANT UPDATE ("customer_id") ON TABLE "enquiry_native"."customers" TO "runner_writer_44516a361736";
GRANT SELECT ON TABLE "enquiry_native"."enquiries" TO "runner_writer_44516a361736";
GRANT INSERT ON TABLE "enquiry_native"."enquiries" TO "runner_writer_44516a361736";
GRANT UPDATE ("enquiry_id") ON TABLE "enquiry_native"."enquiries" TO "runner_writer_44516a361736";
ALTER ROLE "runner_writer_44516a361736" SET statement_timeout = '5s';
ALTER ROLE "runner_writer_44516a361736" SET lock_timeout = '2s';
COMMIT;

-- A column UPDATE grant used for row locking is real database mutation authority on that column; it is not a lock-only PostgreSQL permission.
-- STILL REQUIRED: review scoped policies, helper-function access, defaults/sequences and triggers.
-- RLS-backed targets require ENABLE and FORCE ROW LEVEL SECURITY. See requirements.json; this file does not change RLS.
-- Do not copy an unrestricted policy or grant membership in the shared writer role.
-- After review, configure authentication and LOGIN separately. Never put credentials in this file.
-- Recheck this connection in Runner. Execution consent and a running worker are still required.
