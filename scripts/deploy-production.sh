#!/usr/bin/env bash
set -euo pipefail

pending="$(find migrations/pending -maxdepth 1 -type f -name '*.sql' -print -quit 2>/dev/null || true)"
if [ -n "$pending" ]; then
  echo "ERROR: production deployment is blocked by an unapplied D1 migration: $pending" >&2
  exit 1
fi

target_sha="$(git rev-parse HEAD)"
if [ -z "$target_sha" ]; then
  echo "ERROR: unable to determine the deployment commit SHA." >&2
  exit 1
fi

npx --yes wrangler@4.69.0 deploy \
  --config wrangler.toml \
  --tag "github-$target_sha" \
  --message "GitHub commit $target_sha"
