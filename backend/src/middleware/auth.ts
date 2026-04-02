import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../utils/jwt';

/**
 * Middleware to authenticate requests using JWT token
 * Supports:
 * 1. Authorization header as "Bearer <token>"
 * 2. Query parameter "token=<token>" (for EventSource/SSE connections)
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Skip authentication if NO_AUTH is enabled (development only)
  if (process.env.NO_AUTH === 'true' && process.env.NODE_ENV !== 'production') {
    return next();
  }

  const authHeader = req.headers.authorization;
  const queryToken = req.query.token as string | undefined;

  let token: string | undefined;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (queryToken) {
    token = queryToken;
  }

  if (!token) {
    res.status(401).json({ error: 'Unauthorized: No token provided' });
    return;
  }

  (async () => {
    const payload = await verifyToken(token!);
    if (!payload) {
      res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
      return;
    }
    next();
  })().catch(next);
}
