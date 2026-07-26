DO $$
BEGIN
  CREATE ROLE retail_manager_reader LOGIN PASSWORD 'retail_manager_reader_password';
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE ROLE retail_writer LOGIN PASSWORD 'retail_writer_password';
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE ROLE retail_setup LOGIN PASSWORD 'retail_setup_password';
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

ALTER ROLE retail_manager_reader SET default_transaction_read_only = on;

CREATE TABLE public.merchants (
  id text PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE public.regions (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  name text NOT NULL,
  shipping_region text NOT NULL,
  UNIQUE (merchant_id, name)
);

CREATE TABLE public.stores (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  region_id text NOT NULL REFERENCES public.regions(id) ON DELETE RESTRICT,
  name text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('retail', 'outlet', 'online')),
  accounting_period text NOT NULL,
  UNIQUE (merchant_id, name)
);

CREATE TABLE public.staff_roles (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  role_code text NOT NULL,
  display_name text NOT NULL,
  UNIQUE (merchant_id, role_code)
);

CREATE TABLE public.staff (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  role_id text NOT NULL REFERENCES public.staff_roles(id) ON DELETE RESTRICT,
  display_name text NOT NULL,
  role_code text NOT NULL,
  password_hash text NOT NULL,
  session_token text NOT NULL,
  api_access_token text NOT NULL,
  risk_review_status text NOT NULL
);

CREATE TABLE public.store_assignments (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  store_id text NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  staff_id text NOT NULL REFERENCES public.staff(id) ON DELETE CASCADE,
  assignment_role text NOT NULL,
  assigned_at timestamptz NOT NULL,
  UNIQUE (store_id, staff_id, assignment_role)
);

CREATE TABLE public.customers (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  email text NOT NULL,
  phone text NOT NULL,
  tax_id text NOT NULL,
  internal_risk_score integer NOT NULL CHECK (internal_risk_score BETWEEN 0 AND 1000),
  status text NOT NULL CHECK (status IN ('active', 'paused', 'closed')),
  created_at timestamptz NOT NULL
);

CREATE TABLE public.customer_addresses (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  customer_id text NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  address_line_1 text NOT NULL,
  address_line_2 text,
  city text NOT NULL,
  postal_code text NOT NULL,
  shipping_region text NOT NULL,
  home_address text NOT NULL
);

CREATE TABLE public.customer_sessions (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  customer_id text NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  session_token text NOT NULL,
  refresh_token text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE public.api_keys (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  owner_id text NOT NULL,
  key_name text NOT NULL,
  api_key_secret text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE public.suppliers (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  name text NOT NULL,
  status text NOT NULL,
  contact_email text NOT NULL
);

CREATE TABLE public.supplier_accounts (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  supplier_id text NOT NULL REFERENCES public.suppliers(id) ON DELETE CASCADE,
  bank_account_number text NOT NULL,
  routing_number text NOT NULL,
  payout_token text NOT NULL,
  payment_status text NOT NULL
);

CREATE TABLE public.product_categories (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  name text NOT NULL,
  category_group text NOT NULL,
  UNIQUE (merchant_id, name)
);

CREATE TABLE public.products (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  primary_category_id text NOT NULL REFERENCES public.product_categories(id) ON DELETE RESTRICT,
  supplier_id text NOT NULL REFERENCES public.suppliers(id) ON DELETE RESTRICT,
  owner_id text NOT NULL,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'active', 'retired')),
  version integer NOT NULL DEFAULT 1
);

CREATE TABLE public.product_variants (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  product_id text NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  sku text NOT NULL,
  card_brand_display text NOT NULL,
  pan_size_cm integer NOT NULL,
  list_price_cents integer NOT NULL CHECK (list_price_cents >= 0),
  UNIQUE (merchant_id, sku)
);

CREATE TABLE public.product_category_links (
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  product_id text NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  category_id text NOT NULL REFERENCES public.product_categories(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, category_id)
);

CREATE TABLE public.price_history (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  product_variant_id text NOT NULL REFERENCES public.product_variants(id) ON DELETE CASCADE,
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  effective_at timestamptz NOT NULL
);

CREATE TABLE public.warehouses (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  region_id text NOT NULL REFERENCES public.regions(id) ON DELETE RESTRICT,
  name text NOT NULL,
  status text NOT NULL
);

CREATE TABLE public.inventory_levels (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  warehouse_id text NOT NULL REFERENCES public.warehouses(id) ON DELETE RESTRICT,
  product_variant_id text NOT NULL REFERENCES public.product_variants(id) ON DELETE RESTRICT,
  assigned_manager_id text NOT NULL REFERENCES public.staff(id) ON DELETE RESTRICT,
  available_quantity integer NOT NULL CHECK (available_quantity >= 0),
  reserved_quantity integer NOT NULL CHECK (reserved_quantity >= 0),
  stockout_hours integer NOT NULL CHECK (stockout_hours >= 0),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (warehouse_id, product_variant_id)
);

CREATE TABLE public.stock_movements (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  inventory_level_id text NOT NULL REFERENCES public.inventory_levels(id) ON DELETE RESTRICT,
  movement_type text NOT NULL,
  quantity integer NOT NULL,
  occurred_at timestamptz NOT NULL
);

CREATE TABLE public.reorder_rules (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  inventory_level_id text NOT NULL REFERENCES public.inventory_levels(id) ON DELETE CASCADE,
  reorder_point integer NOT NULL CHECK (reorder_point >= 0),
  reorder_quantity integer NOT NULL CHECK (reorder_quantity > 0)
);

CREATE TABLE public.carts (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  store_id text NOT NULL REFERENCES public.stores(id) ON DELETE RESTRICT,
  customer_id text NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  status text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE public.cart_items (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  cart_id text NOT NULL REFERENCES public.carts(id) ON DELETE CASCADE,
  product_variant_id text NOT NULL REFERENCES public.product_variants(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity > 0)
);

CREATE TABLE public.checkout_sessions (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  cart_id text NOT NULL REFERENCES public.carts(id) ON DELETE RESTRICT,
  checkout_token text NOT NULL,
  status text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE public.orders (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  store_id text NOT NULL REFERENCES public.stores(id) ON DELETE RESTRICT,
  region_id text NOT NULL REFERENCES public.regions(id) ON DELETE RESTRICT,
  customer_id text NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  assigned_manager_id text NOT NULL REFERENCES public.staff(id) ON DELETE RESTRICT,
  channel text NOT NULL CHECK (channel IN ('retail', 'online', 'marketplace')),
  status text NOT NULL CHECK (status IN ('placed', 'processing', 'fulfilled', 'cancelled')),
  gross_revenue_cents integer NOT NULL CHECK (gross_revenue_cents >= 0),
  net_revenue_cents integer NOT NULL CHECK (net_revenue_cents >= 0),
  placed_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1,
  private_customer_note text NOT NULL
);

CREATE INDEX orders_trusted_scope_idx
  ON public.orders(merchant_id, assigned_manager_id, placed_at);

CREATE TABLE public.order_items (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  order_id text NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  product_id text NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  product_variant_id text NOT NULL REFERENCES public.product_variants(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity > 0),
  gross_line_revenue_cents integer NOT NULL CHECK (gross_line_revenue_cents >= 0),
  net_line_revenue_cents integer NOT NULL CHECK (net_line_revenue_cents >= 0)
);

CREATE TABLE public.payment_methods (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  customer_id text NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  card_on_file text NOT NULL,
  full_pan text NOT NULL,
  card_brand_display text NOT NULL,
  bank_account_number text NOT NULL,
  routing_number text NOT NULL
);

CREATE TABLE public.payments (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  order_id text NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  payment_method_id text NOT NULL REFERENCES public.payment_methods(id) ON DELETE RESTRICT,
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  payment_status text NOT NULL,
  payment_token text NOT NULL,
  pan_last_four text NOT NULL,
  cvv_value text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE public.payment_attempts (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  payment_id text NOT NULL REFERENCES public.payments(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL,
  status text NOT NULL,
  processor_token text NOT NULL,
  attempted_at timestamptz NOT NULL
);

CREATE TABLE public.refunds (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  order_id text NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  payment_id text NOT NULL REFERENCES public.payments(id) ON DELETE RESTRICT,
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  reason_code text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE public.shipments (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  order_id text NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  warehouse_id text NOT NULL REFERENCES public.warehouses(id) ON DELETE RESTRICT,
  carrier text NOT NULL,
  tracking_token text NOT NULL,
  status text NOT NULL,
  shipped_at timestamptz
);

CREATE TABLE public.fulfillment_events (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  shipment_id text NOT NULL REFERENCES public.shipments(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  delay_minutes integer NOT NULL CHECK (delay_minutes >= 0),
  occurred_at timestamptz NOT NULL
);

CREATE TABLE public.return_reasons (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  reason_category text NOT NULL,
  display_name text NOT NULL
);

CREATE TABLE public.returns (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  order_id text NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  reason_id text NOT NULL REFERENCES public.return_reasons(id) ON DELETE RESTRICT,
  status text NOT NULL,
  requested_at timestamptz NOT NULL
);

CREATE TABLE public.return_items (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  return_id text NOT NULL REFERENCES public.returns(id) ON DELETE CASCADE,
  order_item_id text NOT NULL REFERENCES public.order_items(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity > 0)
);

CREATE TABLE public.promotions (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  name text NOT NULL,
  promotion_category text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL
);

CREATE TABLE public.promotion_categories (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  name text NOT NULL
);

CREATE TABLE public.promotion_products (
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  promotion_id text NOT NULL REFERENCES public.promotions(id) ON DELETE CASCADE,
  product_id text NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  PRIMARY KEY (promotion_id, product_id)
);

CREATE TABLE public.discounts (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  order_id text NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  promotion_id text REFERENCES public.promotions(id) ON DELETE SET NULL,
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  discount_type text NOT NULL
);

CREATE TABLE public.support_cases (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  customer_id text NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  order_id text REFERENCES public.orders(id) ON DELETE SET NULL,
  assigned_agent_id text NOT NULL REFERENCES public.staff(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('open', 'waiting', 'resolved')),
  subject text NOT NULL,
  private_support_notes text NOT NULL,
  version integer NOT NULL DEFAULT 1
);

CREATE INDEX support_cases_trusted_scope_idx
  ON public.support_cases(merchant_id, assigned_agent_id);

CREATE TABLE public.support_case_notes (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  support_case_id text NOT NULL REFERENCES public.support_cases(id) ON DELETE CASCADE,
  author_id text NOT NULL REFERENCES public.staff(id) ON DELETE RESTRICT,
  public_note text NOT NULL,
  private_support_notes text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE public.sales_line_facts (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  store_id text NOT NULL REFERENCES public.stores(id) ON DELETE RESTRICT,
  region_id text NOT NULL REFERENCES public.regions(id) ON DELETE RESTRICT,
  product_id text NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  product_category_id text NOT NULL REFERENCES public.product_categories(id) ON DELETE RESTRICT,
  assigned_manager_id text NOT NULL REFERENCES public.staff(id) ON DELETE RESTRICT,
  order_id text NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  channel text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  net_revenue_cents integer NOT NULL CHECK (net_revenue_cents >= 0),
  sold_at timestamptz NOT NULL
);

CREATE INDEX sales_line_facts_scope_idx
  ON public.sales_line_facts(merchant_id, assigned_manager_id, sold_at);

CREATE TABLE public.domain_events (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  event_type text NOT NULL,
  payload_token text NOT NULL,
  occurred_at timestamptz NOT NULL
);

CREATE TABLE public.audit_events (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES public.merchants(id) ON DELETE RESTRICT,
  actor_id text NOT NULL,
  action text NOT NULL,
  object_type text NOT NULL,
  object_id text NOT NULL,
  private_audit_payload text NOT NULL,
  occurred_at timestamptz NOT NULL
);

INSERT INTO public.merchants VALUES
  ('merchant-northstar', 'Northstar Outfitters'),
  ('merchant-rival', 'Rival Retail Group');

INSERT INTO public.regions VALUES
  ('region-pacific', 'merchant-northstar', 'Pacific', 'west'),
  ('region-mountain', 'merchant-northstar', 'Mountain', 'central'),
  ('region-rival', 'merchant-rival', 'Rival Region', 'east');

INSERT INTO public.stores VALUES
  ('store-seattle', 'merchant-northstar', 'region-pacific', 'Seattle Flagship', 'retail', '2026-Q2'),
  ('store-portland', 'merchant-northstar', 'region-pacific', 'Portland Market', 'retail', '2026-Q2'),
  ('store-denver', 'merchant-northstar', 'region-mountain', 'Denver Outlet', 'outlet', '2026-Q2'),
  ('store-rival', 'merchant-rival', 'region-rival', 'Rival Store', 'retail', '2026-Q2');

INSERT INTO public.staff_roles VALUES
  ('role-manager', 'merchant-northstar', 'store_manager', 'Store manager'),
  ('role-support', 'merchant-northstar', 'support_agent', 'Support agent'),
  ('role-rival', 'merchant-rival', 'store_manager', 'Store manager');

INSERT INTO public.staff VALUES
  ('staff-manager-alex', 'merchant-northstar', 'role-manager', 'Alex Rivera', 'store_manager', 'synthetic-password-hash-alex', 'synthetic-session-token-alex', 'synthetic-api-token-alex', 'clear'),
  ('staff-manager-jordan', 'merchant-northstar', 'role-manager', 'Jordan Lee', 'store_manager', 'synthetic-password-hash-jordan', 'synthetic-session-token-jordan', 'synthetic-api-token-jordan', 'reviewed'),
  ('staff-support-maya', 'merchant-northstar', 'role-support', 'Maya Chen', 'support_agent', 'synthetic-password-hash-maya', 'synthetic-session-token-maya', 'synthetic-api-token-maya', 'clear'),
  ('staff-support-noah', 'merchant-northstar', 'role-support', 'Noah Smith', 'support_agent', 'synthetic-password-hash-noah', 'synthetic-session-token-noah', 'synthetic-api-token-noah', 'clear'),
  ('staff-rival', 'merchant-rival', 'role-rival', 'Rival Operator', 'store_manager', 'rival-password-hash', 'rival-session-token', 'rival-api-token', 'clear');

INSERT INTO public.store_assignments VALUES
  ('assign-1', 'merchant-northstar', 'store-seattle', 'staff-manager-alex', 'manager', '2026-01-01T00:00:00Z'),
  ('assign-2', 'merchant-northstar', 'store-portland', 'staff-manager-alex', 'manager', '2026-01-01T00:00:00Z'),
  ('assign-3', 'merchant-northstar', 'store-denver', 'staff-manager-jordan', 'manager', '2026-01-01T00:00:00Z'),
  ('assign-rival', 'merchant-rival', 'store-rival', 'staff-rival', 'manager', '2026-01-01T00:00:00Z');

INSERT INTO public.customers
SELECT
  'customer-' || n,
  'merchant-northstar',
  'customer' || n || '@example.test',
  '+1-555-01' || lpad(n::text, 2, '0'),
  'synthetic-tax-id-' || n,
  100 + n,
  'active',
  '2026-01-01T00:00:00Z'::timestamptz + (n || ' days')::interval
FROM generate_series(1, 12) AS n;

INSERT INTO public.customers VALUES
  ('customer-rival', 'merchant-rival', 'rival@example.test', '+1-555-9999', 'rival-tax-id', 900, 'active', '2026-01-01T00:00:00Z');

INSERT INTO public.customer_addresses VALUES
  ('address-1', 'merchant-northstar', 'customer-1', '101 Private Way', NULL, 'Seattle', '98101', 'west', '101 Private Way, Seattle'),
  ('address-rival', 'merchant-rival', 'customer-rival', '999 Rival Road', NULL, 'Boston', '02101', 'east', '999 Rival Road, Boston');

INSERT INTO public.customer_sessions VALUES
  ('customer-session-1', 'merchant-northstar', 'customer-1', 'synthetic-customer-session-token', 'synthetic-refresh-token', '2027-01-01T00:00:00Z');

INSERT INTO public.api_keys VALUES
  ('api-key-1', 'merchant-northstar', 'staff-manager-alex', 'warehouse sync', 'synthetic-secret-api-key', '2026-01-01T00:00:00Z');

INSERT INTO public.suppliers VALUES
  ('supplier-outdoor', 'merchant-northstar', 'Outdoor Supply Co', 'active', 'supplier@example.test'),
  ('supplier-rival', 'merchant-rival', 'Rival Supplier', 'active', 'rival-supplier@example.test');

INSERT INTO public.supplier_accounts VALUES
  ('supplier-account-1', 'merchant-northstar', 'supplier-outdoor', '000111222333', '110000000', 'synthetic-payout-token', 'verified');

INSERT INTO public.product_categories VALUES
  ('category-camping', 'merchant-northstar', 'Camping', 'outdoor'),
  ('category-running', 'merchant-northstar', 'Running', 'fitness'),
  ('category-rival', 'merchant-rival', 'Rival Category', 'other');

INSERT INTO public.products VALUES
  ('product-tent', 'merchant-northstar', 'category-camping', 'supplier-outdoor', 'catalog-owner-1', 'Trail Tent', 'active', 1),
  ('product-shoe', 'merchant-northstar', 'category-running', 'supplier-outdoor', 'catalog-owner-2', 'Ridge Runner Shoe', 'active', 1),
  ('product-rival', 'merchant-rival', 'category-rival', 'supplier-rival', 'rival-owner', 'Rival Product', 'active', 1);

INSERT INTO public.product_variants VALUES
  ('variant-tent', 'merchant-northstar', 'product-tent', 'TENT-001', 'not_applicable', 42, 19900),
  ('variant-shoe', 'merchant-northstar', 'product-shoe', 'SHOE-001', 'not_applicable', 31, 12900),
  ('variant-rival', 'merchant-rival', 'product-rival', 'RIVAL-001', 'not_applicable', 28, 9900);

INSERT INTO public.product_category_links VALUES
  ('merchant-northstar', 'product-tent', 'category-camping'),
  ('merchant-northstar', 'product-tent', 'category-running'),
  ('merchant-northstar', 'product-shoe', 'category-running');

INSERT INTO public.price_history VALUES
  ('price-1', 'merchant-northstar', 'variant-tent', 19900, '2026-01-01T00:00:00Z'),
  ('price-2', 'merchant-northstar', 'variant-shoe', 12900, '2026-01-01T00:00:00Z');

INSERT INTO public.warehouses VALUES
  ('warehouse-pacific', 'merchant-northstar', 'region-pacific', 'Pacific Warehouse', 'active'),
  ('warehouse-mountain', 'merchant-northstar', 'region-mountain', 'Mountain Warehouse', 'active');

INSERT INTO public.inventory_levels VALUES
  ('inventory-tent', 'merchant-northstar', 'warehouse-pacific', 'variant-tent', 'staff-manager-alex', 42, 8, 3, 1),
  ('inventory-shoe', 'merchant-northstar', 'warehouse-pacific', 'variant-shoe', 'staff-manager-alex', 64, 12, 1, 1);

INSERT INTO public.stock_movements VALUES
  ('movement-1', 'merchant-northstar', 'inventory-tent', 'receipt', 20, '2026-06-01T00:00:00Z');

INSERT INTO public.reorder_rules VALUES
  ('reorder-1', 'merchant-northstar', 'inventory-tent', 10, 50);

INSERT INTO public.carts VALUES
  ('cart-1', 'merchant-northstar', 'store-seattle', 'customer-1', 'active', '2026-06-01T00:00:00Z');

INSERT INTO public.cart_items VALUES
  ('cart-item-1', 'merchant-northstar', 'cart-1', 'variant-tent', 1);

INSERT INTO public.checkout_sessions VALUES
  ('checkout-1', 'merchant-northstar', 'cart-1', 'synthetic-checkout-token', 'complete', '2026-07-01T00:00:00Z');

INSERT INTO public.orders
SELECT
  'order-' || lpad(n::text, 3, '0'),
  'merchant-northstar',
  CASE WHEN n % 3 = 0 THEN 'store-portland' ELSE 'store-seattle' END,
  'region-pacific',
  'customer-' || (((n - 1) % 12) + 1),
  'staff-manager-alex',
  CASE WHEN n % 2 = 0 THEN 'online' ELSE 'retail' END,
  CASE WHEN n % 5 = 0 THEN 'processing' ELSE 'fulfilled' END,
  10000 + n * 100,
  9000 + n * 90,
  '2026-04-01T12:00:00Z'::timestamptz + (n * interval '3 days'),
  1,
  'synthetic private customer note ' || n
FROM generate_series(1, 30) AS n;

INSERT INTO public.orders VALUES
  ('order-manager-other', 'merchant-northstar', 'store-denver', 'region-mountain', 'customer-1', 'staff-manager-jordan', 'retail', 'processing', 18000, 16000, '2026-06-20T12:00:00Z', 1, 'other manager private note'),
  ('order-rival', 'merchant-rival', 'store-rival', 'region-rival', 'customer-rival', 'staff-rival', 'retail', 'fulfilled', 9900, 9000, '2026-06-20T12:00:00Z', 1, 'rival private note');

INSERT INTO public.order_items
SELECT
  'item-' || lpad(n::text, 3, '0'),
  'merchant-northstar',
  'order-' || lpad(n::text, 3, '0'),
  CASE WHEN n % 2 = 0 THEN 'product-shoe' ELSE 'product-tent' END,
  CASE WHEN n % 2 = 0 THEN 'variant-shoe' ELSE 'variant-tent' END,
  1,
  10000 + n * 100,
  9000 + n * 90
FROM generate_series(1, 30) AS n;

INSERT INTO public.payment_methods VALUES
  ('payment-method-1', 'merchant-northstar', 'customer-1', 'synthetic-card-on-file-token', '4111111111111111', 'Visa ending 1111', '000111222333', '110000000');

INSERT INTO public.payments
SELECT
  'payment-' || lpad(n::text, 3, '0'),
  'merchant-northstar',
  'order-' || lpad(n::text, 3, '0'),
  'payment-method-1',
  9000 + n * 90,
  'settled',
  'synthetic-payment-token-' || n,
  '1111',
  '123',
  '2026-04-01T12:05:00Z'::timestamptz + (n * interval '3 days')
FROM generate_series(1, 30) AS n;

INSERT INTO public.payment_attempts VALUES
  ('attempt-1', 'merchant-northstar', 'payment-001', 1, 'succeeded', 'synthetic-processor-token', '2026-04-04T12:05:00Z');

INSERT INTO public.refunds VALUES
  ('refund-1', 'merchant-northstar', 'order-005', 'payment-005', 1200, 'size', 'settled', '2026-05-01T00:00:00Z'),
  ('refund-2', 'merchant-northstar', 'order-010', 'payment-010', 800, 'damaged', 'settled', '2026-06-01T00:00:00Z');

INSERT INTO public.shipments VALUES
  ('shipment-1', 'merchant-northstar', 'order-001', 'warehouse-pacific', 'Synthetic Carrier', 'synthetic-tracking-token', 'delivered', '2026-04-05T00:00:00Z');

INSERT INTO public.fulfillment_events VALUES
  ('fulfillment-1', 'merchant-northstar', 'shipment-1', 'delivered', 15, '2026-04-07T00:00:00Z');

INSERT INTO public.return_reasons VALUES
  ('reason-size', 'merchant-northstar', 'size', 'Wrong size'),
  ('reason-damaged', 'merchant-northstar', 'damaged', 'Damaged item');

INSERT INTO public.returns VALUES
  ('return-1', 'merchant-northstar', 'order-005', 'reason-size', 'received', '2026-05-02T00:00:00Z'),
  ('return-2', 'merchant-northstar', 'order-010', 'reason-damaged', 'received', '2026-06-02T00:00:00Z');

INSERT INTO public.return_items VALUES
  ('return-item-1', 'merchant-northstar', 'return-1', 'item-005', 1);

INSERT INTO public.promotions VALUES
  ('promotion-spring', 'merchant-northstar', 'Spring Launch', 'seasonal', '2026-04-01T00:00:00Z', '2026-05-31T23:59:59Z');

INSERT INTO public.promotion_categories VALUES
  ('promotion-category-seasonal', 'merchant-northstar', 'Seasonal');

INSERT INTO public.promotion_products VALUES
  ('merchant-northstar', 'promotion-spring', 'product-tent'),
  ('merchant-northstar', 'promotion-spring', 'product-shoe');

INSERT INTO public.discounts VALUES
  ('discount-1', 'merchant-northstar', 'order-001', 'promotion-spring', 500, 'promotion');

INSERT INTO public.support_cases VALUES
  ('case-assigned', 'merchant-northstar', 'customer-1', 'order-001', 'staff-support-maya', 'open', 'Delivery question', 'synthetic private support note assigned', 1),
  ('case-unassigned', 'merchant-northstar', 'customer-2', 'order-002', 'staff-support-noah', 'open', 'Return question', 'synthetic private support note unassigned', 1),
  ('case-rival', 'merchant-rival', 'customer-rival', 'order-rival', 'staff-rival', 'open', 'Rival case', 'rival private support note', 1);

INSERT INTO public.support_case_notes VALUES
  ('case-note-1', 'merchant-northstar', 'case-assigned', 'staff-support-maya', 'We are checking delivery.', 'private escalation note', '2026-06-01T00:00:00Z');

INSERT INTO public.sales_line_facts
SELECT
  'sales-fact-' || lpad(n::text, 3, '0'),
  'merchant-northstar',
  CASE WHEN n % 3 = 0 THEN 'store-portland' ELSE 'store-seattle' END,
  'region-pacific',
  CASE WHEN n % 2 = 0 THEN 'product-shoe' ELSE 'product-tent' END,
  CASE WHEN n % 2 = 0 THEN 'category-running' ELSE 'category-camping' END,
  'staff-manager-alex',
  'order-' || lpad((((n - 1) % 30) + 1)::text, 3, '0'),
  CASE WHEN n % 2 = 0 THEN 'online' ELSE 'retail' END,
  1,
  5000 + n * 75,
  '2026-04-01T12:00:00Z'::timestamptz + (n * interval '3 hours')
FROM generate_series(1, 192) AS n;

INSERT INTO public.sales_line_facts VALUES
  ('sales-fact-other-manager', 'merchant-northstar', 'store-denver', 'region-mountain', 'product-tent', 'category-camping', 'staff-manager-jordan', 'order-manager-other', 'retail', 1, 16000, '2026-06-20T12:00:00Z'),
  ('sales-fact-rival', 'merchant-rival', 'store-rival', 'region-rival', 'product-rival', 'category-rival', 'staff-rival', 'order-rival', 'retail', 1, 9000, '2026-06-20T12:00:00Z');

INSERT INTO public.domain_events VALUES
  ('domain-event-1', 'merchant-northstar', 'order', 'order-001', 'order.fulfilled', 'synthetic-domain-payload-token', '2026-04-08T00:00:00Z');

INSERT INTO public.audit_events VALUES
  ('audit-event-1', 'merchant-northstar', 'staff-manager-alex', 'order.viewed', 'order', 'order-001', 'synthetic private audit payload', '2026-04-08T00:00:00Z');

ALTER TABLE public.merchants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.merchants FORCE ROW LEVEL SECURITY;
CREATE POLICY merchants_tenant_select
  ON public.merchants FOR SELECT TO retail_manager_reader, retail_writer
  USING (id = current_setting('app.tenant_id', true));

DO $$
DECLARE
  table_name text;
BEGIN
  FOR table_name IN
    SELECT c.table_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.column_name = 'merchant_id'
      AND c.table_name NOT IN ('orders', 'support_cases', 'sales_line_facts')
    ORDER BY c.table_name
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO retail_manager_reader, retail_writer USING (merchant_id = current_setting(''app.tenant_id'', true))',
      table_name || '_tenant_select',
      table_name
    );
  END LOOP;
END
$$;

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders FORCE ROW LEVEL SECURITY;
CREATE POLICY orders_manager_select
  ON public.orders FOR SELECT TO retail_manager_reader, retail_writer
  USING (
    merchant_id = current_setting('app.tenant_id', true)
    AND assigned_manager_id = current_setting('app.principal', true)
  );
CREATE POLICY orders_manager_update
  ON public.orders FOR UPDATE TO retail_writer
  USING (
    merchant_id = current_setting('app.tenant_id', true)
    AND assigned_manager_id = current_setting('app.principal', true)
  )
  WITH CHECK (
    merchant_id = current_setting('app.tenant_id', true)
    AND assigned_manager_id = current_setting('app.principal', true)
  );

ALTER TABLE public.support_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_cases FORCE ROW LEVEL SECURITY;
CREATE POLICY support_cases_agent_select
  ON public.support_cases FOR SELECT TO retail_manager_reader, retail_writer
  USING (
    merchant_id = current_setting('app.tenant_id', true)
    AND assigned_agent_id = current_setting('app.principal', true)
  );

ALTER TABLE public.sales_line_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_line_facts FORCE ROW LEVEL SECURITY;
CREATE POLICY sales_line_facts_manager_select
  ON public.sales_line_facts FOR SELECT TO retail_manager_reader, retail_writer
  USING (
    merchant_id = current_setting('app.tenant_id', true)
    AND assigned_manager_id = current_setting('app.principal', true)
  );

CREATE VIEW public.reviewed_order_performance
WITH (security_barrier = true, security_invoker = true) AS
SELECT
  orders.id AS order_id,
  orders.merchant_id,
  orders.assigned_manager_id,
  orders.region_id,
  ROUND(
    (orders.net_revenue_cents::numeric / NULLIF(orders.gross_revenue_cents, 0))
    * 10000
  )::integer AS net_revenue_retention_basis_points
FROM public.orders;

GRANT CONNECT ON DATABASE northstar_commerce TO retail_manager_reader, retail_writer, retail_setup;
GRANT USAGE ON SCHEMA public TO retail_manager_reader, retail_writer, retail_setup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO retail_manager_reader, retail_writer;
GRANT UPDATE (status, version) ON public.orders TO retail_writer;
GRANT UPDATE (available_quantity, reserved_quantity, version) ON public.inventory_levels TO retail_writer;

CREATE TABLE public.synapsor_fixture_ready (
  initialized_at timestamptz NOT NULL
);

INSERT INTO public.synapsor_fixture_ready VALUES (clock_timestamp());
