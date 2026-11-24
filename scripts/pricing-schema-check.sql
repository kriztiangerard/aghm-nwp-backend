-- NWP-PRICE-009 post-migration check. Read-only: run AFTER db/migrations/004_pricing_sync_schema.sql.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/pricing-schema-check.sql
--
-- Raises an error naming the first missing or wrong item; prints a NOTICE when everything is in place.

SET client_min_messages = notice;

DO $$
DECLARE
    expected RECORD;
    actual RECORD;
    seq TEXT;
    next_id BIGINT;
    max_id BIGINT;
BEGIN
    -- Columns: table, column, data type, nullable, default
    FOR expected IN
        SELECT * FROM (VALUES
            ('pricing', 'is_stale',                  'boolean', 'NO', 'false'),
            ('pricing', 'consecutive_failure_count', 'integer', 'NO', '0'),
            ('pricing', 'needs_manual_review',       'boolean', 'NO', 'false')
        ) AS t(table_name, column_name, data_type, is_nullable, column_default)
    LOOP
        SELECT c.data_type, c.is_nullable, c.column_default INTO actual
        FROM information_schema.columns AS c
        WHERE c.table_schema = 'public'
          AND c.table_name = expected.table_name
          AND c.column_name = expected.column_name;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Missing column %.%', expected.table_name, expected.column_name;
        END IF;
        IF actual.data_type <> expected.data_type OR actual.is_nullable <> expected.is_nullable
           OR actual.column_default IS DISTINCT FROM expected.column_default THEN
            RAISE EXCEPTION 'Column %.% is (%, nullable %, default %), expected (%, nullable %, default %)',
                expected.table_name, expected.column_name,
                actual.data_type, actual.is_nullable, actual.column_default,
                expected.data_type, expected.is_nullable, expected.column_default;
        END IF;
    END LOOP;

    -- Identity columns, and their sequences ahead of the data
    FOR expected IN
        SELECT * FROM (VALUES ('pricing', 'pricing_id'), ('update_log', 'upd_log_id')) AS t(table_name, column_name)
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = expected.table_name
              AND column_name = expected.column_name AND is_identity = 'YES'
        ) THEN
            RAISE EXCEPTION '%.% is not an identity column', expected.table_name, expected.column_name;
        END IF;
    END LOOP;

    FOR expected IN
        SELECT * FROM (VALUES
            ('pricing', 'pricing_id'), ('update_log', 'upd_log_id'), ('vendor', 'vendor_id'),
            ('distributor', 'distributor_id'), ('pricing_source', 'source_id'), ('device', 'device_id')
        ) AS t(table_name, column_name)
    LOOP
        seq := pg_get_serial_sequence('public.' || expected.table_name, expected.column_name);
        CONTINUE WHEN seq IS NULL;
        EXECUTE format('SELECT CASE WHEN is_called THEN last_value + 1 ELSE last_value END FROM %s', seq) INTO next_id;
        EXECUTE format('SELECT max(%I) FROM public.%I', expected.column_name, expected.table_name) INTO max_id;
        IF max_id IS NOT NULL AND next_id <= max_id THEN
            RAISE EXCEPTION 'Sequence for %.% would hand out % but the table already has ids up to %',
                expected.table_name, expected.column_name, next_id, max_id;
        END IF;
    END LOOP;

    -- Constraints
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'pricing_device_distributor_key' AND contype = 'u' AND conrelid = 'public.pricing'::regclass
    ) THEN
        RAISE EXCEPTION 'Missing UNIQUE (device_id, distributor_id) on pricing';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'pricing_consecutive_failure_count_check' AND contype = 'c' AND conrelid = 'public.pricing'::regclass
    ) THEN
        RAISE EXCEPTION 'Missing CHECK (consecutive_failure_count >= 0) on pricing';
    END IF;

    -- Indexes
    FOR expected IN
        SELECT * FROM (VALUES
            ('pricing_source_id_idx'), ('update_log_run_at_idx'), ('update_log_device_distributor_run_at_idx')
        ) AS t(index_name)
    LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = expected.index_name) THEN
            RAISE EXCEPTION 'Missing index %', expected.index_name;
        END IF;
    END LOOP;

    RAISE NOTICE 'NWP-PRICE-009 schema check passed.';
END $$;
