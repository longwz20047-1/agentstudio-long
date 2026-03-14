import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock ClaudeSession
vi.mock('../claudeSession.js', () => ({
  ClaudeSession: vi.fn().mockImplementation((agentId) => ({
    getAgentId: () => agentId,
    isSessionActive: () => true,
    getLastActivity: () => Date.now(),
    getProjectPath: () => null,
    getClaudeVersionId: () => undefined,
    getModelId: () => undefined,
    getSessionTitle: () => undefined,
    close: vi.fn().mockResolvedValue(undefined),
    isIdle: () => false,
  })),
}));

vi.mock('../../config/sdkConfig.js', () => ({
  getProjectsDir: () => '/tmp/test-projects',
}));

import { SessionManager } from '../sessionManager.js';

describe('SessionManager events', () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager();
  });

  it('should have an events property of type EventEmitter', () => {
    expect(sm.events).toBeDefined();
    expect(typeof sm.events.on).toBe('function');
    expect(typeof sm.events.emit).toBe('function');
  });

  it('should emit session:changed when creating a session with resumeSessionId', () => {
    const handler = vi.fn();
    sm.events.on('session:changed', handler);
    sm.createNewSession('agent-1', {} as any, 'session-1');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should emit session:changed when creating a temp session (no resumeSessionId)', () => {
    const handler = vi.fn();
    sm.events.on('session:changed', handler);
    sm.createNewSession('agent-1', {} as any);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should emit session:changed when removing a session', async () => {
    const handler = vi.fn();
    sm.createNewSession('agent-1', {} as any, 'session-1');
    sm.events.on('session:changed', handler);
    await sm.removeSession('session-1');
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
