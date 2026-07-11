CREATE TABLE IF NOT EXISTS orders (
  id varchar(64) PRIMARY KEY,
  tenant_id varchar(64) NOT NULL,
  customer_name varchar(255) NOT NULL,
  status varchar(64) NOT NULL,
  status_change_reason text,
  refund_review_status varchar(64) NOT NULL DEFAULT 'none',
  refund_note text,
  updated_at timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
);

CREATE TABLE IF NOT EXISTS synapsor_writeback_receipts (
  idempotency_key varchar(255) PRIMARY KEY,
  job_id varchar(255) UNIQUE NOT NULL,
  proposal_id varchar(512) NOT NULL,
  status varchar(64) NOT NULL,
  result_hash varchar(128),
  created_at timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  completed_at timestamp(6) NULL
);

INSERT INTO orders (id, tenant_id, customer_name, status, status_change_reason, refund_review_status, refund_note, updated_at)
VALUES
  ('O-1001', 'acme', 'Acme Robotics', 'paid', NULL, 'none', NULL, '2026-06-20 12:00:00'),
  ('O-9001', 'otherco', 'OtherCo Labs', 'paid', NULL, 'none', NULL, '2026-06-20 12:00:00')
ON DUPLICATE KEY UPDATE
  tenant_id = VALUES(tenant_id),
  customer_name = VALUES(customer_name),
  status = VALUES(status),
  status_change_reason = VALUES(status_change_reason),
  refund_review_status = VALUES(refund_review_status),
  refund_note = VALUES(refund_note),
  updated_at = VALUES(updated_at);

CREATE USER IF NOT EXISTS 'synapsor_reader'@'%' IDENTIFIED BY 'synapsor_reader_password';
CREATE USER IF NOT EXISTS 'synapsor_writer'@'%' IDENTIFIED BY 'synapsor_writer_password';

GRANT SELECT ON synapsor_runner_mcp_orders.orders TO 'synapsor_reader'@'%';
GRANT SELECT ON synapsor_runner_mcp_orders.orders TO 'synapsor_writer'@'%';
GRANT UPDATE (refund_review_status, refund_note, updated_at) ON synapsor_runner_mcp_orders.orders TO 'synapsor_writer'@'%';
GRANT UPDATE (status, status_change_reason, updated_at) ON synapsor_runner_mcp_orders.orders TO 'synapsor_writer'@'%';
GRANT SELECT, INSERT, UPDATE ON synapsor_runner_mcp_orders.synapsor_writeback_receipts TO 'synapsor_writer'@'%';
FLUSH PRIVILEGES;
