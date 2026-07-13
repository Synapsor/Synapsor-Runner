CREATE TABLE invoices (
  id varchar(128) PRIMARY KEY,
  tenant_id varchar(128) NOT NULL,
  status varchar(64) NOT NULL,
  late_fee_cents integer NOT NULL,
  waiver_reason varchar(500),
  updated_at datetime(6) NOT NULL
);

CREATE TABLE guard_crud_items (
  id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id varchar(128) NOT NULL,
  request_id varchar(128) NOT NULL,
  value_cents integer NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  UNIQUE KEY guard_crud_items_tenant_request (tenant_id, request_id)
);

CREATE TABLE synapsor_receipts_precreated (
  idempotency_key varchar(191) PRIMARY KEY,
  job_id varchar(191) UNIQUE NOT NULL,
  proposal_id varchar(191) NOT NULL,
  status varchar(64) NOT NULL,
  result_hash varchar(255),
  created_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  completed_at datetime(6)
);

INSERT INTO guard_crud_items (id, tenant_id, request_id, value_cents, version) VALUES
  (1001, 'acme', 'update-precreated', 100, 1),
  (1002, 'acme', 'delete-precreated', 200, 1),
  (1011, 'acme', 'update-auto', 110, 1),
  (1012, 'acme', 'delete-auto', 210, 1),
  (1021, 'acme', 'update-ledger', 120, 1),
  (1022, 'acme', 'delete-ledger', 220, 1),
  (1031, 'globex', 'wrong-tenant', 230, 1),
  (1041, 'acme', 'stale-version', 240, 2),
  (1051, 'acme', 'crash-after-commit', 250, 1),
  (1052, 'acme', 'crash-before-commit', 260, 1),
  (1061, 'acme', 'concurrent-apply', 270, 1);
ALTER TABLE guard_crud_items AUTO_INCREMENT = 2001;

INSERT INTO invoices (id, tenant_id, status, late_fee_cents, waiver_reason, updated_at) VALUES
  ('MYSQL-ACME', 'acme', 'overdue', 700, NULL, '2026-07-12 12:00:00.000000');

CREATE VIEW slow_invoices AS
SELECT invoices.*, SLEEP(0.35) AS synthetic_delay
FROM invoices;

CREATE USER IF NOT EXISTS 'synapsor_reader'@'%' IDENTIFIED BY 'synapsor_reader_password';
CREATE USER IF NOT EXISTS 'synapsor_crud_precreated'@'%' IDENTIFIED BY 'synapsor_crud_precreated_password';
CREATE USER IF NOT EXISTS 'synapsor_crud_auto'@'%' IDENTIFIED BY 'synapsor_crud_auto_password';
CREATE USER IF NOT EXISTS 'synapsor_crud_ledger'@'%' IDENTIFIED BY 'synapsor_crud_ledger_password';
GRANT SELECT ON synapsor_fleet.invoices TO 'synapsor_reader'@'%';
GRANT SELECT ON synapsor_fleet.slow_invoices TO 'synapsor_reader'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON synapsor_fleet.guard_crud_items TO 'synapsor_crud_precreated'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON synapsor_fleet.guard_crud_items TO 'synapsor_crud_auto'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON synapsor_fleet.guard_crud_items TO 'synapsor_crud_ledger'@'%';
GRANT TRIGGER ON synapsor_fleet.guard_crud_items TO 'synapsor_crud_precreated'@'%';
GRANT TRIGGER ON synapsor_fleet.guard_crud_items TO 'synapsor_crud_auto'@'%';
GRANT TRIGGER ON synapsor_fleet.guard_crud_items TO 'synapsor_crud_ledger'@'%';
GRANT PROCESS ON *.* TO 'synapsor_crud_precreated'@'%';
GRANT PROCESS ON *.* TO 'synapsor_crud_auto'@'%';
GRANT PROCESS ON *.* TO 'synapsor_crud_ledger'@'%';
GRANT SELECT, INSERT, UPDATE ON synapsor_fleet.synapsor_receipts_precreated TO 'synapsor_crud_precreated'@'%';
GRANT SELECT, INSERT, UPDATE, CREATE ON synapsor_fleet.* TO 'synapsor_crud_auto'@'%';
FLUSH PRIVILEGES;
