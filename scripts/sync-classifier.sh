#!/usr/bin/env bash
# Re-fetch lot-map's classifier at a pinned commit and update the hash in tests.
# Requires an authenticated `gh` (github.com:443 may be blocked; api.github.com works).
set -euo pipefail
commit="${1:?usage: scripts/sync-classifier.sh <40-hex commit>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
gh api "repos/alexeyw/lot-map/contents/hooks/classify.ts?ref=${commit}" --jq .content \
  | base64 -d > "${root}/vendor/lot-map-classify.ts"
sha="$(sha256sum "${root}/vendor/lot-map-classify.ts" | cut -d' ' -f1)"
echo "new sha256: ${sha}"
echo "update the pinned hash in tests/run.mjs and README before committing"
