-- NWP: catalog vendors with the fixed IDs the db/catalog JSON files use.
-- Run after 004_pricing_sync_schema.sql and BEFORE "2026 11 11 erd fields and generic enclosures.sql".
-- Safe to run more than once.
BEGIN;

-- The ERD migration adds this column too (IF NOT EXISTS), so adding it here first is harmless.
ALTER TABLE vendor ADD COLUMN IF NOT EXISTS management_modes text[];

INSERT INTO vendor (vendor_id, name, need_controller, management_modes) VALUES
  (1, 'HPE Aruba Instant On',  false, ARRAY['dashboard']::text[]),
  (2, 'TP-Link Omada',         true,  ARRAY['dashboard']::text[]),
  (3, 'Ubiquiti UniFi',        false, ARRAY['dashboard']::text[]),
  (4, 'Ruijie',                false, ARRAY['dashboard']::text[]),
  (5, 'Grandstream GWN Cloud', false, ARRAY['dashboard']::text[]),
  (6, 'Cisco Business',        false, ARRAY['dashboard', 'cli']::text[]),
  (11, 'Generic',        false, ARRAY[]::text[])
ON CONFLICT DO NOTHING;

-- New vendors (Generic, from the ERD migration) get IDs after 6.
SELECT setval(pg_get_serial_sequence('vendor', 'vendor_id'), (SELECT max(vendor_id) FROM vendor));

COMMIT;