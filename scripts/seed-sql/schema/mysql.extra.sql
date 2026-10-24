-- MySQL-specific objects: full text index and views.
CREATE FULLTEXT INDEX ft_reviews_title_body ON reviews (title, body);

CREATE VIEW v_daily_revenue AS
SELECT DATE(created_at) AS day, COUNT(*) AS orders, SUM(total_usd) AS revenue_usd, CAST(AVG(total_usd) AS DECIMAL(12,2)) AS aov_usd
FROM orders
WHERE status NOT IN ('cancelled', 'payment_failed')
GROUP BY DATE(created_at);

CREATE VIEW v_customer_ltv AS
SELECT c.id AS customer_id, c.email, c.tier, c.country_code, COUNT(o.id) AS orders, COALESCE(SUM(o.total_usd), 0) AS ltv_usd,
       MIN(o.created_at) AS first_order_at, MAX(o.created_at) AS last_order_at
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id AND o.status NOT IN ('cancelled', 'payment_failed')
GROUP BY c.id, c.email, c.tier, c.country_code;
