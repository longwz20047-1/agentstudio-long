import { Router, type Router as RouterType } from 'express';
import { bridgeKeyService } from '../services/opencli/singletons.js';

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

export default router;
