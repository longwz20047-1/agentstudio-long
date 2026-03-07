#!/bin/sh
# Patch engines/index.js to enable screenshot + actions support for playwright engine
# This is applied at container startup via entrypoint wrapper

TARGET="/app/dist/src/scraper/scrapeURL/engines/index.js"

if [ ! -f "$TARGET" ]; then
    echo "[patch] Target file not found: $TARGET"
    exit 0
fi

# Find the standalone "playwright: {" block (not fire-engine;playwright)
PLAYWRIGHT_LINE=$(grep -n '^\s*playwright: {$' "$TARGET" | head -1 | cut -d: -f1)
if [ -z "$PLAYWRIGHT_LINE" ]; then
    echo "[patch] Could not find 'playwright: {' block, skipping"
    exit 0
fi
END_LINE=$((PLAYWRIGHT_LINE + 20))

# --- Screenshot patch ---
if grep -A2 'playwright: {' "$TARGET" | grep -q 'screenshot: true'; then
    echo "[patch] Screenshot already patched"
else
    echo "[patch] Enabling screenshot for playwright engine (lines $PLAYWRIGHT_LINE-$END_LINE)..."
    sed -i "${PLAYWRIGHT_LINE},${END_LINE}s/screenshot: false/screenshot: true/g" "$TARGET"
    sed -i "${PLAYWRIGHT_LINE},${END_LINE}s/\"screenshot@fullScreen\": false/\"screenshot@fullScreen\": true/g" "$TARGET"
    echo "[patch] Screenshot patch done"
fi

# --- Actions patch ---
# Check current state by extracting the actions line within the playwright block
ACTIONS_STATE=$(sed -n "${PLAYWRIGHT_LINE},${END_LINE}p" "$TARGET" | grep 'actions:' | head -1)
if echo "$ACTIONS_STATE" | grep -q 'actions: true'; then
    echo "[patch] Actions already patched"
else
    echo "[patch] Enabling actions for playwright engine (lines $PLAYWRIGHT_LINE-$END_LINE)..."
    sed -i "${PLAYWRIGHT_LINE},${END_LINE}s/actions: false/actions: true/" "$TARGET"
    echo "[patch] Actions patch done"
fi

echo "[patch] All patches applied"
