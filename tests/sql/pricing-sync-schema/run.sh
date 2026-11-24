#!/usr/bin/env bash
# NWP-PRICE-009: scenario tests for db/migrations/004_pricing_sync_schema.sql, run against the REAL
# migrations in db/migrations/.
#
# Usage:
#   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/nwp_test tests/sql/pricing-sync-schema/run.sh
#
# DESTRUCTIVE for the target database: every scenario drops and re-creates its public schema (the
# existing migrations use the public schema by name). The script refuses to run unless the database
# name contains "test". Never point it at RDS. Needs psql on PATH.
set -u

if [ -z "${TEST_DATABASE_URL:-}" ]; then
  echo "Set TEST_DATABASE_URL to a local, throwaway PostgreSQL database whose name contains 'test'." >&2
  exit 2
fi

PSQL="psql $TEST_DATABASE_URL -q -X -v ON_ERROR_STOP=1"
export PGOPTIONS="-c client_min_messages=warning"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MIG="$ROOT/db/migrations"
M004="$MIG/004_pricing_sync_schema.sql"
M2026="$MIG/2026 11 11 erd fields and generic enclosures.sql"
ROLLBACK="$MIG/rollback/004_pricing_sync_schema.down.sql"
CHECK="$ROOT/scripts/pricing-schema-check.sql"
PRECHECK="$ROOT/scripts/pricing-schema-precheck.sql"

dbname=$($PSQL -tA -c "select current_database()") || exit 2
case "$dbname" in
  *test*) ;;
  *) echo "Refusing to run: database '$dbname' does not contain 'test'." >&2; exit 2 ;;
esac

pass=0; fail=0
ok()  { echo "  PASS  $1"; pass=$((pass+1)); }
bad() { echo "  FAIL  $1"; fail=$((fail+1)); }
q()   { $PSQL -tA -c "$1" 2>&1; }
run() { $PSQL -f "$1" 2>&1; }

reset_db() {
  $PSQL -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" >/dev/null 2>&1
}
apply_base() {   # 001, 002 (both), 003: the migrations every database has
  for f in "$MIG/001_initial_schema.sql" "$MIG/002_add_product_line_and_unifi_spec_fields.sql" \
           "$MIG/002_engine_catalog.sql" "$MIG/003_pricing_is_stale.sql"; do
    out=$(run "$f") || { echo "base migration failed: $f: $out"; exit 1; }
  done
}
check_passes() { out=$($PSQL -f "$CHECK" 2>&1) && echo "$out" | grep -q "check passed"; }
expect_fail() {  # name, sql, pattern
  local out; out=$($PSQL -c "$2" 2>&1) && { bad "$1 (statement succeeded)"; return; }
  echo "$out" | grep -q "$3" && ok "$1" || bad "$1: $out"
}

echo "Scenario A: fresh database in file-name order (001 ... 004, then 2026 11 11)"
reset_db; apply_base
out=$(run "$M004") && ok "004 applies" || bad "004: $out"
out=$(run "$M2026") && ok "2026 11 11 applies after 004" || bad "2026: $out"
check_passes && ok "post-check passes" || bad "post-check: $out"
id=$(q "INSERT INTO pricing (device_id, distributor_id, price) SELECT d.device_id, (SELECT distributor_id FROM distributor ORDER BY distributor_id LIMIT 1), 1 FROM device d WHERE d.sku = 'GEN-RACK-42U' ON CONFLICT DO NOTHING RETURNING pricing_id")
[ -z "$id" ] && ok "seeded rack keeps its single manual row (UNIQUE pair)" || bad "unexpected insert: $id"
q "INSERT INTO distributor (name) VALUES ('Distributor A')" >/dev/null
id=$(q "INSERT INTO pricing (device_id, distributor_id, price) SELECT d.device_id, (SELECT distributor_id FROM distributor WHERE name = 'Distributor A'), 1 FROM device d WHERE d.sku = 'GEN-RACK-42U' RETURNING pricing_id")
[ -n "$id" ] && [ "$id" -gt 7 ] && ok "default pricing_id ($id) comes after the 7 seeded explicit ids" || bad "default pricing_id: $id"

echo "Scenario B: existing database order (001 ... 003, 2026 11 11, then 004)"
reset_db; apply_base
run "$M2026" >/dev/null || bad "2026 before 004"
# simulate rows inserted with explicit MAX + 1 ids (old distributor-source.ts behaviour)
q "INSERT INTO vendor (vendor_id, name, need_controller) VALUES ((SELECT max(vendor_id) + 5 FROM vendor), 'Explicit Vendor', false)" >/dev/null
q "INSERT INTO update_log (upd_log_id, distributor_id, device_id, status) SELECT 1, distributor_id, (SELECT min(device_id) FROM device), 'success' FROM distributor LIMIT 1" >/dev/null
before=$(q "SELECT string_agg(pricing_id||':'||device_id||':'||distributor_id||':'||price, ',' ORDER BY pricing_id) FROM pricing")
out=$(run "$M004") && ok "004 applies on existing data" || bad "004: $out"
after=$(q "SELECT string_agg(pricing_id||':'||device_id||':'||distributor_id||':'||price, ',' ORDER BY pricing_id) FROM pricing")
[ "$before" = "$after" ] && ok "existing pricing rows unchanged" || bad "pricing rows changed"
check_passes && ok "post-check passes" || bad "post-check: $out"
out=$(q "INSERT INTO vendor (name, need_controller) VALUES ('Default Vendor', false) RETURNING vendor_id") && ok "default vendor id no longer collides with an explicit id ($out)" || bad "vendor insert: $out"
out=$(q "INSERT INTO update_log (distributor_id, device_id, status) SELECT distributor_id, (SELECT min(device_id) FROM device), 'success' FROM distributor LIMIT 1 RETURNING upd_log_id") && [ "$out" = "2" ] && ok "update_log ids continue after existing rows" || bad "update_log insert: $out"

echo "Scenario B (continued): constraints"
expect_fail "duplicate device/distributor pricing row rejected" \
  "INSERT INTO pricing (device_id, distributor_id, price) SELECT device_id, distributor_id, 1 FROM pricing LIMIT 1" "pricing_device_distributor_key"
expect_fail "negative failure count rejected" \
  "UPDATE pricing SET consecutive_failure_count = -1 WHERE pricing_id = 1" "pricing_consecutive_failure_count_check"

echo "Scenario C: rerun is harmless"
out=$(run "$M004") && ok "004 runs a second time" || bad "rerun: $out"
check_passes && ok "post-check still passes" || bad "post-check after rerun"

echo "Scenario D: parallel writers no longer collide"
q "TRUNCATE update_log" >/dev/null
for w in 1 2 3 4; do
  $PSQL -c "INSERT INTO update_log (distributor_id, device_id, status) SELECT (SELECT min(distributor_id) FROM distributor), (SELECT min(device_id) FROM device), 'success' FROM generate_series(1, 250)" >/tmp/nwp-par-$w.log 2>&1 &
done
wait
errors=$(cat /tmp/nwp-par-*.log | grep -c ERROR); rm -f /tmp/nwp-par-*.log
[ "$errors" = "0" ] && [ "$(q 'SELECT count(*) FROM update_log')" = "1000" ] && ok "4 concurrent writers inserted 1000 log rows with no id collisions" || bad "concurrent inserts: $errors errors"

echo "Scenario E: duplicate pricing rows stop the migration, nothing changed"
reset_db; apply_base; run "$M2026" >/dev/null
q "INSERT INTO pricing (pricing_id, device_id, distributor_id, price) SELECT 100, device_id, distributor_id, price + 1 FROM pricing WHERE pricing_id = 1" >/dev/null
out=$(run "$M004") && bad "004 should stop" || { echo "$out" | grep -q "more than one pricing row" && ok "clear error for duplicates" || bad "wrong error: $out"; }
[ "$(q "SELECT is_identity FROM information_schema.columns WHERE table_schema='public' AND table_name='pricing' AND column_name='pricing_id'")" = "NO" ] && ok "no partial changes (pricing_id untouched)" || bad "partial changes left"
out=$(run "$PRECHECK")
echo "$out" | grep -q "GEN-WALL-4U" && ok "pre-check lists the duplicate" || bad "pre-check output: $out"

echo "Scenario F: rollback, then migrate again"
reset_db; apply_base; run "$M2026" >/dev/null; run "$M004" >/dev/null
out=$(run "$ROLLBACK") && ok "rollback applies" || bad "rollback: $out"
[ "$(q "SELECT count(*) FROM pg_constraint WHERE conname IN ('pricing_device_distributor_key','pricing_consecutive_failure_count_check')")" = "0" ] && ok "rollback removes the constraints" || bad "constraints left"
[ "$(q "SELECT is_identity FROM information_schema.columns WHERE table_schema='public' AND table_name='update_log' AND column_name='upd_log_id'")" = "NO" ] && ok "rollback removes the identity default" || bad "identity left"
[ "$(q "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='pricing' AND column_name IN ('is_stale','consecutive_failure_count','needs_manual_review')")" = "3" ] && ok "rollback keeps the 001 columns" || bad "001 columns dropped"
out=$(run "$M004") && check_passes && ok "004 applies again after rollback" || bad "re-migrate: $out"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
