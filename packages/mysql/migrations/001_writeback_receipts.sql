CREATE TABLE IF NOT EXISTS synapsor_writeback_receipts (
  idempotency_key varchar(255) PRIMARY KEY,
  job_id varchar(255) UNIQUE NOT NULL,
  proposal_id varchar(512) NOT NULL,
  status varchar(64) NOT NULL,
  result_hash varchar(128),
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at timestamp NULL
);

