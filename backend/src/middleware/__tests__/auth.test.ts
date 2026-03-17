import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response, NextFunction } from 'express';

// Mock jwt utils
vi.mock('../../utils/jwt.js', () => ({
  verifyToken: vi.fn(),
}));

import { authMiddleware } from '../auth.js';
import { verifyToken } from '../../utils/jwt.js';

const mockedVerifyToken = vi.mocked(verifyToken);

function createMockReqRes(token?: string) {
  const req = {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    query: {},
  } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  const next = vi.fn() as NextFunction;
  return { req, res, next };
}

describe('authMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NO_AUTH;
  });

  it('should reject invalid JWT tokens', async () => {
    mockedVerifyToken.mockResolvedValue(null);
    const { req, res, next } = createMockReqRes('invalid-token');

    authMiddleware(req, res, next);

    await new Promise(resolve => setTimeout(resolve, 10));

    expect(mockedVerifyToken).toHaveBeenCalledWith('invalid-token');
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should pass valid JWT tokens', async () => {
    mockedVerifyToken.mockResolvedValue({ authenticated: true, exp: 9999999999 });
    const { req, res, next } = createMockReqRes('valid-jwt-token');

    authMiddleware(req, res, next);

    await new Promise(resolve => setTimeout(resolve, 10));

    expect(mockedVerifyToken).toHaveBeenCalledWith('valid-jwt-token');
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('should return 401 when no token provided', async () => {
    const { req, res, next } = createMockReqRes();

    authMiddleware(req, res, next);

    await new Promise(resolve => setTimeout(resolve, 10));

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should accept token from query parameter', async () => {
    mockedVerifyToken.mockResolvedValue({ authenticated: true, exp: 9999999999 });
    const req = {
      headers: {},
      query: { token: 'query-jwt-token' },
    } as unknown as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as Response;
    const next = vi.fn() as NextFunction;

    authMiddleware(req, res, next);
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(mockedVerifyToken).toHaveBeenCalledWith('query-jwt-token');
    expect(next).toHaveBeenCalled();
  });

  it('should skip auth when NO_AUTH=true', async () => {
    process.env.NO_AUTH = 'true';
    const { req, res, next } = createMockReqRes();

    authMiddleware(req, res, next);

    await new Promise(resolve => setTimeout(resolve, 10));

    expect(next).toHaveBeenCalled();
    expect(mockedVerifyToken).not.toHaveBeenCalled();
  });
});
