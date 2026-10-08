-- ADMINISTRATOR REVIEW REQUIRED. Runner never executes this file.
-- Creates a NEW, initially NOLOGIN role. Does not alter shared roles, RLS, or source rows.
-- Inspect requirements.json and README.md before running against the intended database.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE ROLE "runner_writer_1a5022f6e574" NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
DO $runner_connect$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), 'runner_writer_1a5022f6e574'); END $runner_connect$;
-- Reviewed source receipt infrastructure only; receipt storage is not a public Read permission.
-- Synapsor Runner direct SQL writeback receipt table.
-- Run this once as a database owner. If you use a dedicated schema, ensure the writer connection search_path includes it.
CREATE SCHEMA IF NOT EXISTS "impact_receipts";
CREATE TABLE IF NOT EXISTS "impact_receipts".synapsor_writeback_receipts (
  idempotency_key text PRIMARY KEY,
  job_id text UNIQUE NOT NULL,
  proposal_id text NOT NULL,
  status text NOT NULL,
  result_hash text,
  semantic_verification_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
ALTER TABLE "impact_receipts".synapsor_writeback_receipts
  ADD COLUMN IF NOT EXISTS semantic_verification_json jsonb;

-- Example writer URL option for this schema:
-- postgresql://writer:...@host/db?options=-csearch_path%3Dimpact_receipts%2Cpublic

GRANT USAGE ON SCHEMA "enquiry_native" TO "runner_writer_1a5022f6e574";
GRANT USAGE ON SCHEMA "impact_receipts" TO "runner_writer_1a5022f6e574";
GRANT SELECT ON TABLE "enquiry_native"."customers" TO "runner_writer_1a5022f6e574";
GRANT UPDATE ("customer_id") ON TABLE "enquiry_native"."customers" TO "runner_writer_1a5022f6e574";
GRANT SELECT ON TABLE "enquiry_native"."enquiries" TO "runner_writer_1a5022f6e574";
GRANT INSERT ON TABLE "enquiry_native"."enquiries" TO "runner_writer_1a5022f6e574";
GRANT UPDATE ("enquiry_id") ON TABLE "enquiry_native"."enquiries" TO "runner_writer_1a5022f6e574";
GRANT SELECT ON TABLE "impact_receipts"."synapsor_writeback_receipts" TO "runner_writer_1a5022f6e574";
GRANT INSERT ON TABLE "impact_receipts"."synapsor_writeback_receipts" TO "runner_writer_1a5022f6e574";
GRANT UPDATE ON TABLE "impact_receipts"."synapsor_writeback_receipts" TO "runner_writer_1a5022f6e574";
ALTER ROLE "runner_writer_1a5022f6e574" SET statement_timeout = '5s';
ALTER ROLE "runner_writer_1a5022f6e574" SET lock_timeout = '2s';
COMMIT;

-- A column UPDATE grant used for row locking is real database mutation authority on that column; it is not a lock-only PostgreSQL permission.
-- STILL REQUIRED: review scoped policies, helper-function access, defaults/sequences and triggers.
-- RLS-backed targets require ENABLE and FORCE ROW LEVEL SECURITY. See requirements.json; this file does not change RLS.
-- Do not copy an unrestricted policy or grant membership in the shared writer role.
-- After review, configure authentication and LOGIN separately. Never put credentials in this file.
-- Recheck this connection in Runner. Execution consent and a running worker are still required.
