-- SQLite-specific objects: views. (No FTS5 table: node:sqlite, which builds this file, is compiled without it.)

CREATE VIEW v_daily_revenue AS
SELECT date(created_at) AS day, count(*) AS orders, round(sum(total_usd), 2) AS revenue_usd, round(avg(total_usd), 2) AS aov_usd
FROM orders
WHERE status NOT IN ('cancelled', 'payment_failed')
GROUP BY date(created_at);

CREATE VIEW v_customer_ltv AS
SELECT c.id AS customer_id, c.email, c.tier, c.country_code, count(o.id) AS orders, coalesce(round(sum(o.total_usd), 2), 0) AS ltv_usd,
       min(o.created_at) AS first_order_at, max(o.created_at) AS last_order_at
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id AND o.status NOT IN ('cancelled', 'payment_failed')
GROUP BY c.id;
