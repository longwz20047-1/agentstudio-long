# OpenCLI Bridge Phase 2: Pairing Protocol Design

**Status:** Draft
**Author:** Claude Code
**Date:** 2026-03-24
**Depends on:** Phase 1 (Core Channel) — completed
**Blocks:** Phase 4 (Management Console)

---

## 1. Goal

Replace Phase 1's in-memory bridge key with a secure, persistent pairing protocol. Users generate a one-time pairing token in weknora-ui, transfer it to the Electron bridge app via `obk://` protocol link or manual paste, and the bridge exchanges it for a permanent `obk_` API key over WebSocket.

## 2. Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Pairing UX | Dual-channel: `obk://` link + manual paste fallback | `obk://` is best UX; paste fallback required for Linux where custom protocol registration is unreliable |
| Key lifecycle | Never expires, manual revocation only | Local dev tool, not a production service. Phase 4 management console provides one-click revoke |
| Multi-user sharing | Single-user binding per bridge | opencli browser sessions are machine-level, no multi-profile isolation. Sharing bridge = sharing browser identity |
| Storage pattern | Copy apiKeyService (bcrypt + AES-256-GCM + JSON file) | Proven pattern already in codebase, no new dependencies |

## 3. Architecture

### 3.1 Token Types

| Token | Prefix | Lifetime | Storage | Purpose |
|-------|--------|----------|---------|---------|
| Pairing token | `obp_` | 10 minutes, single-use | Server memory (Map) | One-time exchange credential |
| Bridge API key | `obk_` | Permanent until revoked | Server: bcrypt hash in JSON file. Bridge: plaintext in `~/.opencli-bridge/config.json` | Long-lived authentication |

### 3.2 Data Flow

```
weknora-ui                        AgentStudio Backend                  Electron Bridge
──────────                        ──────────────────                  ────────────────

1. POST /api/opencli/pairing-token
   { projectId, userId }
                                  Generate obp_ token (crypto.randomBytes)
                                  Store in pairingTokens Map with:
                                    - 10min TTL
                                    - userId, projectId
                                  Encode config string:
                                    base64url({ v:1, s:wsUrl, t:obp_xxx, p:projectId, n:projectName, u:userId })
   ← { configString, protocolLink }

2. User copies config string
   or clicks obk:// link
                                                                      Parse config string
                                                                      Extract: wsUrl, obp_ token, projectId

3.                                                                    WS CONNECT wsUrl
                                                                      Header: X-Bridge-Pairing-Token: obp_xxx
                                  Validate obp_ token:
                                    - Exists in Map? → else reject
                                    - Expired? → else reject (close code 4002)
                                  Delete token from Map immediately
                                  Generate obk_ key (crypto.randomBytes)
                                  Persist: bcrypt hash → .a2a/opencli-bridge-keys.json
                                  Send { type: 'paired', obkKey: 'obk_yyy' }
                                                                      ──→
                                                                      Store obk_ in config.json
                                                                      Disconnect

4.                                                                    WS CONNECT wsUrl
                                                                      Header: X-Bridge-Key: obk_yyy
                                  Validate obk_ key (bcrypt compare)
                                  Update lastUsedAt
                                  Normal registration flow (Phase 1)
```

### 3.3 Config String Format

Protocol link: `obk://<base64url-encoded-json>`

Decoded JSON:
```json
{
  "v": 1,
  "s": "ws://localhost:4936/api/opencli/bridge",
  "t": "obp_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
  "p": "proj_001",
  "n": "My Project",
  "u": "alice@example.com"
}
```

Fields:
- `v` — version (always 1)
- `s` — WebSocket server URL
- `t` — pairing token (`obp_` prefix, 32 hex chars)
- `p` — project ID
- `n` — project display name (for bridge UI)
- `u` — user ID (email, for register message)

## 4. Server-Side Components

### 4.1 bridgeKeyService.ts (rewrite)

Rewrite from 23-line in-memory stub to full persistent service. Follow `apiKeyService.ts` patterns.

**Pairing token management (in-memory):**

```typescript
interface PairingToken {
  token: string;        // obp_xxx
  userId: string;
  projectId: string;
  expiresAt: Date;
}

const pairingTokens = new Map<string, PairingToken>();
```

**Rate limiting:** Max 5 tokens per userId per minute. Map total capacity: 1000 entries. Reject with 429 if exceeded.

**Token consumption:** Delete from Map immediately on successful exchange. 10-minute TTL cleanup via `setTimeout` as fallback (clear timeout on early consumption).

**Bridge key management (persistent):**

```typescript
interface BridgeKeyRecord {
  id: string;              // UUID
  userId: string;          // normalized lowercase
  deviceName: string;      // from register message
  bridgeId: string;        // from register message
  keyHash: string;         // bcrypt hash of obk_ key
  createdAt: string;       // ISO timestamp
  lastUsedAt: string;      // ISO timestamp, updated on each WS connect
  revokedAt: string | null; // ISO timestamp when revoked, null if active
}
```

**Storage file:** `{projectDataDir}/opencli-bridge-keys.json`

```json
{
  "version": "1.0.0",
  "keys": [BridgeKeyRecord, ...]
}
```

**Key methods:**

| Method | Purpose |
|--------|---------|
| `generatePairingToken(userId, projectId)` | Create obp_ token, store in Map, return config string |
| `consumePairingToken(token)` | Validate + delete from Map, return { userId, projectId } |
| `generateBridgeKey(userId, deviceName, bridgeId)` | Create obk_ key, bcrypt hash, persist to JSON file |
| `validateBridgeKey(key)` | Iterate keys, bcrypt compare, update lastUsedAt, return userId |
| `revokeBridgeKey(keyId)` | Set revokedAt timestamp (soft delete) |
| `listBridgeKeys(includeRevoked?)` | List all keys for management UI (Phase 4) |

**Implementation requirements:**
- Use `proper-lockfile` for atomic JSON file writes (same as apiKeyService)
- No `encryptedKey` field — obk_ key is delivered once via WS `paired` message, never displayed again. Phase 4 management UI shows only metadata (deviceName, createdAt, lastUsedAt), not the key itself.
- Bridge keys file is per-project: `{projectDataDir}/opencli-bridge-keys.json`. Key count per project is naturally bounded (1 user × 1 device = 1 key).

### 4.2 REST Route: POST /api/opencli/pairing-token

**File:** `backend/src/routes/opencli.ts` (new)

```
POST /api/opencli/pairing-token
Auth: JWT (weknora-ui user session, reuse existing auth.ts middleware)
Body: { projectId: string }
Response: {
  configString: string,      // base64url JSON
  protocolLink: string,      // obk://<configString>
  expiresAt: string          // ISO timestamp
}
```

**Middleware:** JWT auth (reuse existing `auth.ts`), rate limit (5/min per user).

**Route registration:** Add to `backend/src/index.ts` alongside other REST routes.

### 4.3 WS Error Codes

| Code | Meaning | When |
|------|---------|------|
| 4001 | Key revoked | Server revokes obk_ key via management UI |
| 4002 | Pairing token expired/invalid | obp_ token not found, expired, or already consumed |
| 4003 | Rate limited | Too many connection attempts |

### 4.3 opencliWs.ts (modify)

Modify the `server.on('upgrade')` handler to support two authentication modes:

```
Priority 1: X-Bridge-Key header → existing obk_ validation (Phase 1 flow)
Priority 2: X-Bridge-Pairing-Token header → pairing flow:
  1. consumePairingToken(token) → { userId, projectId }
  2. Accept WS upgrade
  3. On first 'register' message:
     a. generateBridgeKey(userId, deviceName, bridgeId)
     b. Send { type: 'paired', obkKey: key }
     c. Close connection (bridge will reconnect with obk_ key)
```

Neither header present → `socket.destroy()` (existing behavior).

## 5. Electron Bridge Components

### 5.1 protocolHandler.ts (new)

Register `obk://` custom protocol with Electron:

```typescript
app.setAsDefaultProtocolClient('obk');

// Handle protocol invocation
app.on('open-url', (event, url) => {
  event.preventDefault();
  const configString = url.replace('obk://', '');
  handlePairingConfig(configString);
});

// Windows: second-instance event
app.on('second-instance', (event, argv) => {
  const obkUrl = argv.find(a => a.startsWith('obk://'));
  if (obkUrl) handlePairingConfig(obkUrl.replace('obk://', ''));
});
```

`handlePairingConfig(configString)`:
1. Base64url decode → parse JSON
2. Validate: `v === 1`, required fields present
3. Add server to config with `paired: false`, `pairingToken: obp_xxx`
4. Trigger connection to server

### 5.2 connectionManager.ts (modify)

Add pairing handshake support:

**On connect with unpaired server:**
1. Use `X-Bridge-Pairing-Token` header instead of `X-Bridge-Key`
2. Send `register` message as normal
3. Listen for `{ type: 'paired', obkKey: 'obk_yyy' }` message
4. On `paired`: store obk_ key in config, mark server as `paired: true`, remove `pairingToken`
5. Disconnect and reconnect with `X-Bridge-Key: obk_yyy`

**On connect with paired server:** Existing Phase 1 flow (X-Bridge-Key header).

### 5.3 Tray menu addition

Add "Add Server..." menu item:
1. Opens a small BrowserWindow with a text input
2. User pastes config string
3. Parse and trigger `handlePairingConfig()`
4. Close window, update tray status

### 5.4 configStore.ts (modify)

Add server management:

```typescript
interface ServerConfig {
  id: string;                // 'srv_' + crypto.randomUUID().slice(0,8)
  name: string;             // from config string 'n' field
  wsUrl: string;            // from config string 's' field
  apiKey?: string;          // obk_ key (set after pairing)
  pairingToken?: string;    // obp_ token (temporary, removed after pairing)
  paired: boolean;
  addedAt: string;
}
```

Methods: `addServer(configString)`, `markPaired(serverId, obkKey)`, `removeServer(serverId)`.

## 6. weknora-ui Components

### 6.1 OpenCliBridgeSettings.vue (new)

Location: `weknora-ui/src/components/a2a-project/OpenCliBridgeSettings.vue`

Renders in project settings page. Contains:

1. **"Generate Pairing Token" button** — calls `POST /api/opencli/pairing-token`
2. **Config string display** — read-only text field with copy button
3. **Protocol link** — clickable `obk://...` link (opens Electron app)
4. **Expiry countdown** — "Expires in 9:42" timer
5. **Instructions** — step-by-step guide for the user

### 6.2 API wrapper

Location: `weknora-ui/src/api/agentstudio/opencli-bridge.ts`

```typescript
export function generatePairingToken(projectId: string): Promise<{
  configString: string;
  protocolLink: string;
  expiresAt: string;
}>;
```

Uses AgentStudio proxy (`/api/opencli/pairing-token`), JWT auth (user's login session, proxied through weknora-ui's Vite proxy to AgentStudio backend).

## 7. Security Considerations

| Threat | Mitigation |
|--------|-----------|
| Config string intercepted | Contains only obp_ token (10min TTL, single-use). Real obk_ key never in config string. |
| obp_ token replay | Single-use: deleted from Map on first consumption. Cannot be reused. |
| obp_ token brute force | Rate limit: 5 tokens/min/user. Token is 32 hex chars (128-bit entropy). |
| Memory exhaustion (token Map) | Hard cap: 1000 entries. 10-min auto-cleanup. Rate limit per user. |
| obk_ key leak from bridge machine | User can revoke via Phase 4 management UI. Server sends WS close code 4001 (key revoked). |
| Man-in-the-middle | Production: WSS (TLS). Dev: localhost only. Config string contains server URL, so bridge connects to intended server. |

## 8. File Summary

### New Files

| File | Project | Lines (est.) |
|------|---------|-------------|
| `backend/src/routes/opencli.ts` | agentstudio | ~80 |
| `backend/src/services/opencli/__tests__/bridgeKeyService.test.ts` | agentstudio | ~100 |
| `backend/src/services/opencli/__tests__/pairingFlow.test.ts` | agentstudio | ~80 |
| `opencli-bridge/src/protocolHandler.ts` | opencli-bridge | ~50 |
| `weknora-ui/src/components/a2a-project/OpenCliBridgeSettings.vue` | weknora-ui | ~100 |
| `weknora-ui/src/api/agentstudio/opencli-bridge.ts` | weknora-ui | ~20 |

### Modified Files

| File | Project | Changes |
|------|---------|---------|
| `backend/src/services/opencli/bridgeKeyService.ts` | agentstudio | Rewrite: 23 → ~150 lines (persistent + pairing tokens) |
| `backend/src/routes/opencliWs.ts` | agentstudio | Add pairing handshake in upgrade handler (~40 lines) |
| `backend/src/index.ts` | agentstudio | Register opencli REST route (~3 lines) |
| `opencli-bridge/src/connectionManager.ts` | opencli-bridge | Pairing handshake + reconnect logic (~60 lines) |
| `opencli-bridge/src/configStore.ts` | opencli-bridge | Server management methods (~40 lines) |
| `opencli-bridge/src/tray.ts` | opencli-bridge | "Add Server..." menu item (~20 lines) |
| `opencli-bridge/src/main.ts` | opencli-bridge | Protocol handler registration (~10 lines) |
| weknora-ui i18n files (4 languages) | weknora-ui | Pairing UI labels (~40 lines total) |

### Total Estimate: ~700 lines new/modified code
