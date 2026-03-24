import { Router, type Router as RouterType } from 'express';
import { bridgeKeyService } from '../services/opencli/singletons.js';

const router: RouterType = Router();

/**
 * POST /api/opencli/pairing-token
 * Generate a one-time pairing token for connecting an opencli-bridge.
 * Body: { projectId: string, userId: string, projectName?: string }
 * Returns: { configString, protocolLink, expiresAt }
 */
router.post('/pairing-token', (req, res) => {
  try {
    const { projectId, userId, projectName } = req.body;
    if (!projectId) return res.status(400).json({ error: 'projectId required' });
    if (!userId) return res.status(400).json({ error: 'userId required' });

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
