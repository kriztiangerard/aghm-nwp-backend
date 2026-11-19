-- NWP-PRICE-009 pre-check. Read-only: run BEFORE db/migrations/004_pricing_sync_schema.sql.
--   psql "$DATABASE_URL" -f scripts/pricing-schema-precheck.sql
--
-- Section 1 must return no rows, or the migration stops. Resolve any rows with the team first
-- (nothing is deleted automatically). Sections 2 and 3 are information only.

\echo '1. pricing: device/distributor pairs with more than one row (blocks the migration)'
SELECT p.device_id, d.sku, p.distributor_id, count(*) AS rows,
       array_agg(p.pricing_id ORDER BY p.pricing_id) AS pricing_ids,
       array_agg(p.source_id ORDER BY p.pricing_id) AS source_ids
FROM pricing AS p
JOIN device AS d ON d.device_id = p.device_id
GROUP BY p.device_id, d.sku, p.distributor_id
HAVING count(*) > 1
ORDER BY p.device_id, p.distributor_id;

\echo '2. id columns: identity or not, and current maximum (information)'
SELECT c.table_name, c.column_name, c.is_identity,
       pg_get_serial_sequence('public.' || c.table_name, c.column_name) AS sequence
FROM information_schema.columns AS c
WHERE c.table_schema = 'public'
  AND (c.table_name, c.column_name) IN (
      ('pricing', 'pricing_id'), ('update_log', 'upd_log_id'), ('vendor', 'vendor_id'),
      ('distributor', 'distributor_id'), ('pricing_source', 'source_id'), ('device', 'device_id'))
ORDER BY c.table_name;

\echo '3. Active pricing sources per vendor and distributor (information)'
SELECT v.name AS vendor, d.name AS distributor, count(*) AS active_sources
FROM pricing_source AS ps
JOIN vendor AS v ON v.vendor_id = ps.vendor_id
JOIN distributor AS d ON d.distributor_id = ps.distributor_id
WHERE ps.is_active
GROUP BY v.name, d.name
ORDER BY v.name, d.name;
