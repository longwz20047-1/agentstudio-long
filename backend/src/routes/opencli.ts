import { Router, type Router as RouterType } from 'express';
import { bridgeKeyService, bridgeRegistry } from '../services/opencli/singletons.js';

const router: RouterType = Router();

/**
 * POST /api/opencli/pairing-token
 * Generate a one-time pairing token for connecting an opencli-bridge.
 *
 * Auth: JWT via authMiddleware (registered in index.ts).
 * Note: userId comes from req.body because AgentStudio JWT only contains
 * { authenticated: true } without user identity. The route is still protected
 * by JWT auth, so only authenticated users can generate tokens.
 * TODO: When JWT is extended with user info, extract userId from token instead.
 *
 * Body: { projectId: string, userId: string, projectName?: string }
 * Returns: { configString, protocolLink, expiresAt }
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
 * GET /api/opencli/keys
 * List all bridge keys (optionally include revoked).
 *
 * Query: { includeRevoked?: 'true' }
 * Returns: { keys: BridgeKeyRecord[] }
 */
router.get('/keys', (req, res) => {
  try {
    const includeRevoked = req.query.includeRevoked === 'true';
    const keys = bridgeKeyService.listBridgeKeys(includeRevoked);
    // Strip keyHash from response for security
    const safeKeys = keys.map(({ keyHash, ...rest }) => rest);
    res.json({ keys: safeKeys });
  } catch (err) {
    console.error('[OpenCLI] List keys error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/opencli/keys/:keyId
 * Revoke a bridge key.
 *
 * Returns: { success: boolean }
 */
router.delete('/keys/:keyId', (req, res) => {
  try {
    const { keyId } = req.params;
    if (!keyId || typeof keyId !== 'string') return res.status(400).json({ error: 'keyId required' });
    const success = bridgeKeyService.revokeBridgeKey(keyId);
    if (!success) return res.status(404).json({ error: 'Key not found or already revoked' });
    res.json({ success: true });
  } catch (err) {
    console.error('[OpenCLI] Revoke key error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/opencli/status
 * Get online bridge connections status.
 *
 * Query: { userId?: string, projectId?: string }
 * Returns: { bridges: Array<{ bridgeId, deviceName, userId, projectId, status, connectedAt, lastHeartbeat, capabilities }> }
 */
router.get('/status', (req, res) => {
  try {
    const { userId, projectId } = req.query;
    let entries;
    if (userId && typeof userId === 'string') {
      entries = bridgeRegistry.getAllForUser(userId);
    } else if (projectId && typeof projectId === 'string') {
      entries = bridgeRegistry.getAllForProject(projectId);
    } else {
      // No filter — return empty (require at least one filter for security)
      return res.status(400).json({ error: 'userId or projectId query parameter required' });
    }

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

export default router;
