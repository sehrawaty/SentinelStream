#!/usr/bin/env bash
# PLAN.md Part 7 -- "the five-second answer to 'is everything up'". Runs the
# graded path end to end (one create, one update, one delete, one
# aggregation, one explain, one ring check) and exits non-zero on failure.
# Run before the demo, not during it.
set -uo pipefail

API="${API_BASE:-http://localhost:8080}"
FAIL=0
step() { printf '%-28s' "$1"; }
ok()   { echo "OK  $1"; }
bad()  { echo "FAIL  $1"; FAIL=1; }

# ---- 0. health ----
step "health"
HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "$API/api/health")
[ "$HEALTH" = "200" ] && ok "" || bad "expected 200, got $HEALTH"

# ---- 1. CREATE ----
step "create (manual alert)"
CREATE_RESP=$(curl -s -X POST "$API/api/alerts/manual" -H "Content-Type: application/json" \
  -d '{"cardId":"C-0001","severity":"LOW","reason":"smoke test create","author":"smoke"}')
ALERT_ID=$(echo "$CREATE_RESP" | sed -n 's/.*"alertId":"\([^"]*\)".*/\1/p')
[ -n "$ALERT_ID" ] && ok "-> $ALERT_ID" || bad "no alertId in response: $CREATE_RESP"

# ---- 2. UPDATE (status transition) ----
step "update (status transition)"
if [ -n "$ALERT_ID" ]; then
  UPDATE_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$API/api/alerts/$ALERT_ID/status" \
    -H "Content-Type: application/json" -d '{"to":"INVESTIGATING","by":"smoke"}')
  [ "$UPDATE_CODE" = "200" ] && ok "" || bad "expected 200, got $UPDATE_CODE"
else
  bad "skipped -- no alert from create step"
fi

# ---- 3. DELETE (dismiss, separate alert -- INVESTIGATING isn't delete-eligible) ----
step "delete (dismiss)"
DEL_CREATE=$(curl -s -X POST "$API/api/alerts/manual" -H "Content-Type: application/json" \
  -d '{"cardId":"C-0002","severity":"LOW","reason":"smoke test delete","author":"smoke"}')
DEL_ID=$(echo "$DEL_CREATE" | sed -n 's/.*"alertId":"\([^"]*\)".*/\1/p')
if [ -n "$DEL_ID" ]; then
  DEL_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE \
    "$API/api/alerts/$DEL_ID?reason=smoke+test&by=smoke")
  [ "$DEL_CODE" = "200" ] && ok "" || bad "expected 200, got $DEL_CODE"
else
  bad "skipped -- could not create the delete-target alert"
fi

# ---- 4. AGGREGATION (the $facet KPI strip) ----
step "aggregation (kpi facet)"
KPI=$(curl -s "$API/api/stats/kpi?minutes=60")
echo "$KPI" | grep -q '"bySeverity"' && echo "$KPI" | grep -q '"byRule"' \
  && ok "" || bad "kpi response missing expected shape: $KPI"

# ---- 5. EXPLAIN evidence (Slice 8's captured report, not a live re-run) ----
step "explain (evidence captured)"
EVIDENCE="$(dirname "$0")/../docs/evidence/explain-report.md"
if [ -s "$EVIDENCE" ] && grep -q "IXSCAN" "$EVIDENCE"; then
  ok ""
else
  bad "docs/evidence/explain-report.md missing or has no IXSCAN evidence -- run explain-evidence.mjs"
fi

# ---- 6. RING (seeded ring_snapshots -- RING_FOR_CARD itself is Slice 12) ----
step "ring (seeded snapshot)"
RING_COUNT=$(docker exec sentinel-mongo mongosh sentinel --quiet --eval \
  "db.ring_snapshots.countDocuments({ringId:'R-0001'})" 2>/dev/null | tr -d '\r')
[ "$RING_COUNT" = "1" ] && ok "" || bad "expected 1 seeded ring_snapshots doc, got '$RING_COUNT'"

echo
if [ "$FAIL" = "0" ]; then
  echo "All checks passed."
else
  echo "SMOKE TEST FAILED -- see above."
fi
exit "$FAIL"
