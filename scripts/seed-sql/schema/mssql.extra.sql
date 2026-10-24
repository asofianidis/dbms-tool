-- SQL Server-specific objects: a columnstore index for the metrics table and views.

-- BULK INSERT reads a quoted empty CSV field as NULL; v1 customers store a missing phone as ''.
UPDATE customers SET legacy_phone = '' WHERE schema_version = 1 AND legacy_phone IS NULL;
CREATE NONCLUSTERED COLUMNSTORE INDEX ncci_metrics ON metrics (host_id, ts, cpu_pct, mem_pct, rps, latency_p50_ms, latency_p95_ms, latency_p99_ms, errors_5xx);
GO

CREATE VIEW v_daily_revenue AS
SELECT CAST(created_at AS date) AS day, COUNT_BIG(*) AS orders, SUM(total_usd) AS revenue_usd, CAST(AVG(total_usd) AS decimal(12,2)) AS aov_usd
FROM orders
WHERE status NOT IN ('cancelled', 'payment_failed')
GROUP BY CAST(created_at AS date);
GO

CREATE VIEW v_customer_ltv AS
SELECT c.id AS customer_id, c.email, c.tier, c.country_code, COUNT(o.id) AS orders, COALESCE(SUM(o.total_usd), 0) AS ltv_usd,
       MIN(o.created_at) AS first_order_at, MAX(o.created_at) AS last_order_at
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id AND o.status NOT IN ('cancelled', 'payment_failed')
GROUP BY c.id, c.email, c.tier, c.country_code;
GO
