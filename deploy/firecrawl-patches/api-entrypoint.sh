#!/bin/sh
# Entrypoint wrapper for firecrawl-api that applies self-host patches before starting
# Mount this as the container entrypoint via docker-compose

echo "=== Applying self-host patches ==="

# Patch 1: Enable screenshot in playwright engine feature flags
if [ -f /patches/patch-engines-index.sh ]; then
    sh /patches/patch-engines-index.sh
fi

# Patch 2: Playwright engine handler (volume-mounted directly, no action needed)
if [ -f /app/dist/src/scraper/scrapeURL/engines/playwright/index.js ]; then
    echo "[patch] Playwright engine handler: volume-mounted"
fi

echo "=== Patches applied, starting firecrawl-api ==="

# Execute original entrypoint with command args
exec docker-entrypoint.sh "$@"
