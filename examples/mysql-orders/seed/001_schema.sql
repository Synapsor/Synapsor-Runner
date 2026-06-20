CREATE TABLE IF NOT EXISTS orders (
  id varchar(64) PRIMARY KEY,
  tenant_id varchar(64) NOT NULL,
  status varchar(64) NOT NULL,
  refund_note text,
  updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO orders (id, tenant_id, status, refund_note, updated_at)
VALUES ('O-1001', 'acme', 'paid', NULL, '2026-06-20 12:00:00')
ON DUPLICATE KEY UPDATE status = VALUES(status), refund_note = VALUES(refund_note), updated_at = VALUES(updated_at);

CREATE TABLE IF NOT EXISTS synapsor_writeback_receipts (
  idempotency_key varchar(255) PRIMARY KEY,
  job_id varchar(255) UNIQUE NOT NULL,
  proposal_id varchar(512) NOT NULL,
  status varchar(64) NOT NULL,
  result_hash varchar(128),
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at timestamp NULL
);

