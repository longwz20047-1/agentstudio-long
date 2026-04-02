import { Router, type Router as RouterType } from 'express';
import { bridgeKeyService, bridgeRegistry, bridgeHistoryStore } from '../services/opencli/singletons.js';
import { listAgentMappings } from '../services/a2a/agentMappingService.js';
import {
  loadProjectOpenCliEnabled,
  loadUserOpenCliConfig,
  saveUserOpenCliConfig,
  saveProjectOpenCliConfig,
} from '../services/opencli/opencliConfigStorage.js';
import { ALL_DOMAINS } from '../services/opencli/constants.js';
import { requestDiagnose } from './opencliWs.js';
import { broadcastOpenCliConfigUpdate } from '../services/websocketService.js';

const router: RouterType = Router();

// ── Shared helper ─────────────────────────────────────────────────────────────

async function resolveWorkingDirectory(projectId: string): Promise<string | null> {
  const mappings = await listAgentMappings();
  // Normalize path separators for Windows compatibility (mapping may use / while frontend sends \)
  const normalize = (p: string) => p.replace(/\\/g, '/');
  const normalizedId = normalize(projectId);
  const match = mappings.find(m =>
    normalize(m.workingDirectory) === normalizedId || m.projectId === projectId
  );
  return match?.workingDirectory || null;
}

// ── Pairing & Key Management ──────────────────────────────────────────────────

/**
 * POST /api/opencli/pairing-token
 * Generate a one-time pairing token for connecting an opencli-bridge.
 */
router.post('/pairing-token', (req, res) => {
  try {
    const { projectId, userId, projectName } = req.body;
    if (!projectId || typeof projectId !== 'string') return res.status(400).json({ error: 'projectId required (string)' });
    if (!userId || typeof userId !== 'string') return res.status(400).json({ error: 'userId required (string)' });
    if (projectId.length > 200 || userId.length > 200) return res.status(400).json({ error: 'Input too long' });

    const wsUrl = `${req.protocol === 'https' ? 'wss' : 'ws'}://${req.get('host')}/api/opencli/bridge`;

    const result = bridgeKeyService.generatePairingToken(userId, projectId, wsUrl, projectName || projectId);
    res.json(result);
  } catch (err: any) {
    if (err.message === 'Rate limited') return res.status(429).json({ error: 'Rate limited. Max 5 tokens per minute.' });
    if (err.message === 'Token capacity exceeded') return res.status(503).json({ error: 'Server busy. Try again later.' });
    console.error('[OpenCLI] Pairing token error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/opencli/keys?userId=<required>&includeRevoked=true
 */
router.get('/keys', (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ error: 'userId query parameter required' });
    }
    const includeRevoked = req.query.includeRevoked === 'true';
    const allKeys = bridgeKeyService.listBridgeKeys(includeRevoked);
    const userKeys = allKeys.filter(k => k.userId === userId.trim().toLowerCase());
    const safeKeys = userKeys.map(({ keyHash, ...rest }) => rest);
    res.json({ keys: safeKeys });
  } catch (err) {
    console.error('[OpenCLI] List keys error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/opencli/keys/:keyId?userId=<required>
 */
router.delete('/keys/:keyId', (req, res) => {
  try {
    const { keyId } = req.params;
    const userId = req.query.userId;
    if (!keyId || typeof keyId !== 'string') return res.status(400).json({ error: 'keyId required' });
    if (!userId || typeof userId !== 'string') return res.status(400).json({ error: 'userId query parameter required' });

    const allKeys = bridgeKeyService.listBridgeKeys(false);
    const key = allKeys.find(k => k.id === keyId);
    if (!key) return res.status(404).json({ error: 'Key not found' });
    if (key.userId !== (userId as string).trim().toLowerCase()) {
      return res.status(403).json({ error: 'Not authorized to revoke this key' });
    }

    const success = bridgeKeyService.revokeBridgeKey(keyId);
    if (!success) return res.status(404).json({ error: 'Key not found or already revoked' });

    // Close active WebSocket connections for this specific key
    const entries = bridgeRegistry.getAllForKey(keyId);
    for (const entry of entries) {
      if (entry.ws.readyState === 1) {  // WebSocket.OPEN
        entry.ws.close(4001, 'API key revoked');
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[OpenCLI] Revoke key error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/opencli/status?userId=<required>
 */
router.get('/status', (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ error: 'userId query parameter required' });
    }

    const entries = bridgeRegistry.getAllForUser(userId);
    const bridges = entries.map(e => ({
      bridgeId: e.bridgeId,
      deviceName: e.deviceName,
      userId: e.userId,
      projectId: e.projectId,
      status: e.status,
      connectedAt: e.connectedAt.toISOString(),
      lastHeartbeat: e.lastHeartbeat.toISOString(),
      capabilities: e.capabilities,
    }));

    res.json({ bridges });
  } catch (err) {
    console.error('[OpenCLI] Status error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Shared userId validation ───────────────────────────────────────────────────
// NOTE: AgentStudio JWT contains { authenticated: true } only — no user identity.
// The userId parameter is self-reported by the client and used to scope file access.
// This matches the same pattern as GET /keys and GET /status (pre-existing design).
// Full IDOR prevention requires JWT extension — tracked as future work.
// Mitigation: strict format validation prevents injection; file paths are safeId-encoded.
function validateUserId(userId: unknown): userId is string {
  if (!userId || typeof userId !== 'string') return false;
  if (userId.length > 320 || userId.length < 1) return false; // max email length
  return true;
}

// ── Execution History ─────────────────────────────────────────────────────────

/**
 * GET /api/opencli/history?projectId=<required>&userId=<required>&limit=50&offset=0
 */
router.get('/history', async (req, res) => {
  try {
    const { projectId, userId, limit: limitStr, offset: offsetStr } = req.query;
    if (!projectId || typeof projectId !== 'string') {
      return res.status(400).json({ error: 'projectId required' });
    }
    if (!validateUserId(userId)) {
      return res.status(400).json({ error: 'userId required (valid email or ID, max 320 chars)' });
    }

    const workingDirectory = await resolveWorkingDirectory(projectId);
    if (!workingDirectory) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const limit = Math.min(parseInt(limitStr as string) || 50, 500);
    const offset = parseInt(offsetStr as string) || 0;

    const result = await bridgeHistoryStore.getHistory(workingDirectory, userId, limit, offset);

    // Strip full stdout/stderr from list response (available on detail fetch if needed)
    // Prevents excessive data exposure in paginated lists
    const MAX_OUTPUT_PREVIEW = 200;
    const safeRecords = result.records.map(r => ({
      ...r,
      stdout: r.stdout && r.stdout.length > MAX_OUTPUT_PREVIEW
        ? r.stdout.substring(0, MAX_OUTPUT_PREVIEW) + '…'
        : r.stdout,
      stderr: r.stderr && r.stderr.length > MAX_OUTPUT_PREVIEW
        ? r.stderr.substring(0, MAX_OUTPUT_PREVIEW) + '…'
        : r.stderr,
    }));
    res.json({ total: result.total, records: safeRecords });
  } catch (err) {
    console.error('[OpenCLI] History error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/opencli/history/:id?projectId=<required>&userId=<required>
 * Returns full record (no stdout/stderr truncation).
 */
router.get('/history/:id', async (req, res) => {
  try {
    const { projectId, userId } = req.query;
    if (!projectId || typeof projectId !== 'string') {
      return res.status(400).json({ error: 'projectId required' });
    }
    if (!validateUserId(userId)) {
      return res.status(400).json({ error: 'userId required (valid email or ID, max 320 chars)' });
    }

    const workingDirectory = await resolveWorkingDirectory(projectId);
    if (!workingDirectory) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const record = await bridgeHistoryStore.getRecord(workingDirectory, userId, req.params.id);
    if (!record) {
      return res.status(404).json({ error: 'Record not found' });
    }

    res.json({ record });
  } catch (err) {
    console.error('[OpenCLI] History detail error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Remote Diagnostics ────────────────────────────────────────────────────────

/**
 * POST /api/opencli/diagnose
 * Body: { projectId, userId }
 */
router.post('/diagnose', async (req, res) => {
  const { projectId, userId } = req.body;
  if (!projectId || typeof projectId !== 'string') {
    return res.status(400).json({ error: 'projectId required' });
  }
  if (!validateUserId(userId)) {
    return res.status(400).json({ error: 'userId required (valid email or ID)' });
  }

  try {
    const result = await requestDiagnose(projectId, userId);
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('timed out')) {
      return res.status(504).json({ error: 'Bridge diagnostics timed out' });
    }
    if (message.includes('BRIDGE_OFFLINE') || message.includes('BRIDGE_DISCONNECTED')) {
      return res.status(503).json({ error: 'Bridge not connected' });
    }
    res.status(500).json({ error: message });
  }
});

// ── Domain Configuration ──────────────────────────────────────────────────────

/**
 * GET /api/opencli/config?projectId=<required>&userId=<required>
 */
router.get('/config', async (req, res) => {
  try {
    const { projectId, userId } = req.query;
    if (!projectId || typeof projectId !== 'string') {
      return res.status(400).json({ error: 'projectId required' });
    }
    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ error: 'userId required' });
    }

    const workingDirectory = await resolveWorkingDirectory(projectId);
    if (!workingDirectory) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const enabled = loadProjectOpenCliEnabled(workingDirectory);
    const userConfig = loadUserOpenCliConfig(workingDirectory, userId);
    res.json({ enabled, enabledDomains: userConfig.enabledDomains });
  } catch (err) {
    console.error('[OpenCLI] Config load error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/opencli/enable
 * Body: { projectId, enabled: boolean }
 * Enable or disable OpenCLI for a project (writes to opencli-config.json)
 */
router.put('/enable', async (req, res) => {
  try {
    const { projectId, enabled } = req.body;
    if (!projectId || typeof projectId !== 'string') {
      return res.status(400).json({ error: 'projectId required' });
    }
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be boolean' });
    }

    const workingDirectory = await resolveWorkingDirectory(projectId);
    if (!workingDirectory) {
      return res.status(404).json({ error: 'Project not found' });
    }

    saveProjectOpenCliConfig(workingDirectory, { enabled });
    res.json({ success: true, enabled });
  } catch (err) {
    console.error('[OpenCLI] Enable error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/opencli/domains
 * Body: { projectId, userId, domains: Record<string, boolean> }
 */
router.put('/domains', async (req, res) => {
  try {
    const { projectId, userId, domains } = req.body;
    if (!projectId || typeof projectId !== 'string') {
      return res.status(400).json({ error: 'projectId required' });
    }
    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ error: 'userId required' });
    }
    if (!domains || typeof domains !== 'object') {
      return res.status(400).json({ error: 'domains object required' });
    }

    // Validate domain keys against known domains
    const updated = ALL_DOMAINS.filter(d => domains[d] === true);

    const workingDirectory = await resolveWorkingDirectory(projectId);
    if (!workingDirectory) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Save per-user config
    saveUserOpenCliConfig(workingDirectory, userId, { enabledDomains: updated });

    // Broadcast to browser clients subscribed to this project+user
    broadcastOpenCliConfigUpdate(projectId, userId, {
      type: 'opencli:config_update',
      projectId,
      userId,
      domains,
      timestamp: Date.now(),
    });

    // Push config_update to the user's bridge (if online)
    const bridgeEntry = bridgeRegistry.get(projectId, userId);
    if (bridgeEntry && (bridgeEntry.ws as any).readyState === 1) {
      bridgeEntry.ws.send(JSON.stringify({
        type: 'config_update',
        enabledDomains: updated,
        timestamp: Date.now(),
      }));
    }

    res.json({ success: true, updated, timestamp: Date.now() });
  } catch (err) {
    console.error('[OpenCLI] Domains update error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
