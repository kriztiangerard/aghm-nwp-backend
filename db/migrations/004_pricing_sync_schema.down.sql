-- NWP-PRICE-009 rollback for 004_pricing_sync_schema.sql. Run manually, only if 004 must be undone.
--
-- Removes the UNIQUE and CHECK constraints, the identity defaults on pricing_id and upd_log_id,
-- the new indexes and the column comments. Keeps the failure-tracking columns (they come from 001)
-- and leaves the other identity sequences where 004 moved them (moving them back would cause collisions).
-- After this, inserts into pricing and update_log must supply ids again.

BEGIN;

DROP INDEX IF EXISTS update_log_device_distributor_run_at_idx;
DROP INDEX IF EXISTS update_log_run_at_idx;
DROP INDEX IF EXISTS pricing_source_id_idx;

ALTER TABLE pricing
    DROP CONSTRAINT IF EXISTS pricing_consecutive_failure_count_check,
    DROP CONSTRAINT IF EXISTS pricing_device_distributor_key;

ALTER TABLE pricing ALTER COLUMN pricing_id DROP IDENTITY IF EXISTS;
ALTER TABLE update_log ALTER COLUMN upd_log_id DROP IDENTITY IF EXISTS;

COMMENT ON COLUMN pricing.source_id IS NULL;
COMMENT ON COLUMN pricing.is_stale IS NULL;
COMMENT ON COLUMN pricing.consecutive_failure_count IS NULL;
COMMENT ON COLUMN pricing.needs_manual_review IS NULL;
COMMENT ON COLUMN update_log.error IS NULL;
COMMENT ON COLUMN update_log.run_at IS NULL;

COMMIT;
