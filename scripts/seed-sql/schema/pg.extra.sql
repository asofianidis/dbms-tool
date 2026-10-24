-- Postgres-specific objects: JSONB/array GIN indexes, full text, BRIN, partial index, views, a matview, a function.
CREATE INDEX ix_products_attributes ON products USING gin (attributes jsonb_path_ops);
CREATE INDEX ix_products_tags ON products USING gin (tags);
CREATE INDEX ix_reviews_fts ON reviews USING gin (to_tsvector('english', title || ' ' || body));
CREATE INDEX ix_metrics_ts_brin ON metrics USING brin (ts);
CREATE INDEX ix_orders_open ON orders (created_at) WHERE status IN ('pending', 'paid', 'processing');

CREATE VIEW v_daily_revenue AS
SELECT created_at::date AS day, count(*) AS orders, sum(total_usd) AS revenue_usd, avg(total_usd)::numeric(12,2) AS aov_usd
FROM orders
WHERE status NOT IN ('cancelled', 'payment_failed')
GROUP BY 1;

CREATE VIEW v_customer_ltv AS
SELECT c.id AS customer_id, c.email, c.tier, c.country_code, count(o.id) AS orders, coalesce(sum(o.total_usd), 0) AS ltv_usd,
       min(o.created_at) AS first_order_at, max(o.created_at) AS last_order_at
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id AND o.status NOT IN ('cancelled', 'payment_failed')
GROUP BY c.id;

CREATE MATERIALIZED VIEW mv_product_sales AS
SELECT oi.product_id, p.sku, p.name, cat.path AS category, sum(oi.qty) AS units, count(DISTINCT oi.order_id) AS orders
FROM order_items oi
JOIN products p ON p.id = oi.product_id
JOIN categories cat ON cat.id = p.category_id
GROUP BY oi.product_id, p.sku, p.name, cat.path;
CREATE UNIQUE INDEX ux_mv_product_sales ON mv_product_sales (product_id);

CREATE FUNCTION customer_ltv_usd(p_customer_id bigint) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(total_usd), 0) FROM orders WHERE customer_id = p_customer_id AND status NOT IN ('cancelled', 'payment_failed')
$$;

COMMENT ON TABLE orders IS 'One row per checkout. Money columns are in the order currency; total_usd is converted at order time.';
COMMENT ON COLUMN orders.channel IS 'NULL for schema_version 1 orders (before the 2024-04 checkout rewrite).';
COMMENT ON TABLE events IS 'Clickstream, range-partitioned by month on ts.';
