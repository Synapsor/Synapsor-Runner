CREATE TABLE invoices (
  id varchar(128) PRIMARY KEY,
  tenant_id varchar(128) NOT NULL,
  status varchar(64) NOT NULL,
  late_fee_cents integer NOT NULL,
  waiver_reason varchar(500),
  updated_at datetime(6) NOT NULL
);

INSERT INTO invoices (id, tenant_id, status, late_fee_cents, waiver_reason, updated_at) VALUES
  ('MYSQL-ACME', 'acme', 'overdue', 700, NULL, '2026-07-12 12:00:00.000000');

CREATE VIEW slow_invoices AS
SELECT invoices.*, SLEEP(0.35) AS synthetic_delay
FROM invoices;

CREATE USER IF NOT EXISTS 'synapsor_reader'@'%' IDENTIFIED BY 'synapsor_reader_password';
GRANT SELECT ON synapsor_fleet.invoices TO 'synapsor_reader'@'%';
GRANT SELECT ON synapsor_fleet.slow_invoices TO 'synapsor_reader'@'%';
FLUSH PRIVILEGES;
