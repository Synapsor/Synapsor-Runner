CREATE TABLE IF NOT EXISTS tickets (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  status text NOT NULL,
  resolution_note text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO tickets (id, tenant_id, status, resolution_note, updated_at)
VALUES ('T-1042', 'acme', 'open', NULL, '2026-06-20T12:00:00Z')
ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, resolution_note = EXCLUDED.resolution_note, updated_at = EXCLUDED.updated_at;

CREATE TABLE IF NOT EXISTS synapsor_writeback_receipts (
  idempotency_key text PRIMARY KEY,
  job_id text UNIQUE NOT NULL,
  proposal_id text NOT NULL,
  status text NOT NULL,
  result_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

