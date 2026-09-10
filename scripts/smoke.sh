#!/usr/bin/env bash
# StayQuiet — verify a deployed URL really serves the product.
#   bash scripts/smoke.sh https://xxxx.us-west-2.awsapprunner.com
set -euo pipefail
URL="${1:-${PUBLIC_URL:-}}"
: "${URL:?usage: bash scripts/smoke.sh <https://host>}"
URL="${URL%/}"

fail() { echo "SMOKE FAIL: $1" >&2; exit 1; }

curl -fsS "${URL}/healthz" | grep -q '"ok":true' || fail "/healthz did not report ok"
curl -fsS "${URL}/" | grep -qi 'stayquiet' || fail "/ did not serve the app"
STATE="$(curl -fsS "${URL}/api/state")"
echo "$STATE" | grep -q '"track": *"Professional Agents"' || fail "/api/state missing the track"
echo "$STATE" | grep -q '"synthetic": *true' || fail "/api/state missing the synthetic marker"
curl -fsS "${URL}/events" | grep -q '"status": *"complete"' || fail "/events snapshot malformed"
echo "SMOKE OK: ${URL}"
