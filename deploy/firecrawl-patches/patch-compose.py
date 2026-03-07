#!/usr/bin/env python3
"""Patch docker-compose.yml to enable Firecrawl screenshot support in self-hosted mode."""

import sys

COMPOSE_PATH = "/opt/WeKnora/docker-compose.yml"

with open(COMPOSE_PATH, "r") as f:
    lines = f.readlines()

result = []
i = 0
while i < len(lines):
    line = lines[i]

    # Patch 1: Insert entrypoint+volumes before "command:" in firecrawl-api
    if line.strip() == "command: node dist/src/harness.js --start-docker":
        result.append("    # --- Self-host screenshot patches ---\n")
        result.append('    entrypoint: ["/bin/sh", "/patches/api-entrypoint.sh"]\n')
        result.append("    volumes:\n")
        result.append("      - ./firecrawl-patches/playwright-engine.js:/app/dist/src/scraper/scrapeURL/engines/playwright/index.js:ro\n")
        result.append("      - ./firecrawl-patches/patch-engines-index.sh:/patches/patch-engines-index.sh:ro\n")
        result.append("      - ./firecrawl-patches/api-entrypoint.sh:/patches/api-entrypoint.sh:ro\n")
        result.append(line)  # keep original command line
        i += 1
        continue

    # Patch 2: Insert volumes in firecrawl-playwright service definition
    if line.rstrip() == "  firecrawl-playwright:":
        # Check this is service definition (has "image:" within next 3 lines)
        is_service = any("image:" in lines[j] for j in range(i + 1, min(i + 4, len(lines))))
        if is_service:
            result.append(line)
            i += 1
            # Scan for cpus: line within this service block
            while i < len(lines):
                sline = lines[i]
                if sline.strip().startswith("cpus:"):
                    result.append("    # --- Self-host screenshot patch ---\n")
                    result.append("    volumes:\n")
                    result.append("      - ./firecrawl-patches/playwright-api.js:/usr/src/app/dist/api.js:ro\n")
                    result.append(sline)
                    i += 1
                    break
                result.append(sline)
                i += 1
            continue

    result.append(line)
    i += 1

with open(COMPOSE_PATH, "w") as f:
    f.writelines(result)

print("docker-compose.yml patched successfully!")
