-- NWP-PRICE-001: deactivate the pricing sources replaced on 2026-11-19 and 2026-11-20.
-- Run once on every database that was seeded before scripts/seed-distributor-sources.ts changed:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/deactivate-replaced-sources.sql
-- Then run the seed script again to add the replacements (it skips rows that already exist).
--
-- Rows are deactivated, not deleted: pricing.source_id may point at them, and their history stays.
-- The TP-Link Shopee store stays ACTIVE on purpose: it is the demonstration source for a blocked site.
-- Safe to run more than once.

BEGIN;

UPDATE pricing_source
SET is_active = FALSE,
    last_updated = NOW()
WHERE is_active
  AND source_url IN (
    'https://northcircuit.ph/',                                  -- home page (TP-Link Omada and Ubiquiti UniFi rows)
    'https://www.lazada.com.ph/shop/ubiquiti/?path=index.htm',   -- marketplace store, bot-protected
    'https://technosureph.com/',                                 -- home page
    'https://www.imvphil.com/',                                  -- home page
    -- Added 2026-11-20:
    'https://pcx.com.ph/collections/vendors?q=tp-link',          -- replaced by PC Express's Omada-only collection
    'https://ardentnetworks.com.ph/empowering-smarter-communication-grandstream-now-available-in-the-philippines-through-ardent-networks/'  -- news post, not a listing
  );

SELECT v.name AS vendor, d.name AS distributor, ps.source_url, ps.is_active
FROM pricing_source AS ps
JOIN vendor AS v ON v.vendor_id = ps.vendor_id
JOIN distributor AS d ON d.distributor_id = ps.distributor_id
ORDER BY v.name, ps.is_active DESC, d.name;

COMMIT;
