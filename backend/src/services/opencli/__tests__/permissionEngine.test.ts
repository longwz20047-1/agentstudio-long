import { describe, it, expect, beforeEach } from 'vitest';
import {
  isWriteOperation,
  hasSessionApproval,
  grantSessionApproval,
  clearSessionApprovals,
  clearAllApprovals,
  buildConfirmationPrompt,
} from '../permissionEngine.js';
import { WRITE_OPERATIONS } from '../constants.js';

describe('permissionEngine', () => {
  describe('isWriteOperation', () => {
    it('returns true for twitter/post', () => {
      expect(isWriteOperation('twitter', 'post')).toBe(true);
    });
    it('returns true for boss/greet', () => {
      expect(isWriteOperation('boss', 'greet')).toBe(true);
    });
    it('returns true for notion/write', () => {
      expect(isWriteOperation('notion', 'write')).toBe(true);
    });
    it('returns true for discord-app/send', () => {
      expect(isWriteOperation('discord-app', 'send')).toBe(true);
    });
    it('returns false for twitter/timeline', () => {
      expect(isWriteOperation('twitter', 'timeline')).toBe(false);
    });
    it('returns false for bilibili/search', () => {
      expect(isWriteOperation('bilibili', 'search')).toBe(false);
    });
    it('returns false for twitter/download', () => {
      expect(isWriteOperation('twitter', 'download')).toBe(false);
    });
    it('returns false for bilibili/download', () => {
      expect(isWriteOperation('bilibili', 'download')).toBe(false);
    });
    it('returns false for any site/export', () => {
      expect(isWriteOperation('twitter', 'export')).toBe(false);
    });
    it('returns true for unknown-site/unknown-action', () => {
      expect(isWriteOperation('unknown-site', 'something')).toBe(true);
    });
    it('returns false for known site with unknown action', () => {
      expect(isWriteOperation('twitter', 'some-new-read-action')).toBe(false);
    });
    it('returns false for download on write-capable site', () => {
      expect(isWriteOperation('boss', 'download')).toBe(false);
    });
    it('returns false for export on write-capable site', () => {
      expect(isWriteOperation('notion', 'export')).toBe(false);
    });
    it('returns true for empty site and action', () => {
      expect(isWriteOperation('', '')).toBe(true);
    });

    // Parameterized: verify ALL entries in WRITE_OPERATIONS
    for (const [site, actions] of Object.entries(WRITE_OPERATIONS)) {
      for (const action of actions) {
        it(`returns true for ${site}/${action}`, () => {
          expect(isWriteOperation(site, action)).toBe(true);
        });
      }
    }
  });

  describe('session approval cache', () => {
    const sessionId = 'test-session-1';

    beforeEach(() => {
      clearAllApprovals();
    });

    it('returns false when no approval granted', () => {
      expect(hasSessionApproval(sessionId, 'twitter', 'post')).toBe(false);
    });
    it('returns true after granting approval', () => {
      grantSessionApproval(sessionId, 'twitter', 'post');
      expect(hasSessionApproval(sessionId, 'twitter', 'post')).toBe(true);
    });
    it('approval is scoped to site/action', () => {
      grantSessionApproval(sessionId, 'twitter', 'post');
      expect(hasSessionApproval(sessionId, 'twitter', 'reply')).toBe(false);
    });
    it('approval is scoped to session', () => {
      grantSessionApproval(sessionId, 'twitter', 'post');
      expect(hasSessionApproval('other-session', 'twitter', 'post')).toBe(false);
    });
    it('clearSessionApprovals removes all approvals for session', () => {
      grantSessionApproval(sessionId, 'twitter', 'post');
      grantSessionApproval(sessionId, 'boss', 'greet');
      clearSessionApprovals(sessionId);
      expect(hasSessionApproval(sessionId, 'twitter', 'post')).toBe(false);
      expect(hasSessionApproval(sessionId, 'boss', 'greet')).toBe(false);
    });
    it('clearSessionApprovals on non-existent session is no-op', () => {
      expect(() => clearSessionApprovals('never-existed')).not.toThrow();
    });
    it('clearAllApprovals removes all sessions', () => {
      grantSessionApproval('session-a', 'twitter', 'post');
      grantSessionApproval('session-b', 'boss', 'greet');
      clearAllApprovals();
      expect(hasSessionApproval('session-a', 'twitter', 'post')).toBe(false);
      expect(hasSessionApproval('session-b', 'boss', 'greet')).toBe(false);
    });
    it('granting same approval twice is idempotent', () => {
      grantSessionApproval(sessionId, 'twitter', 'post');
      grantSessionApproval(sessionId, 'twitter', 'post');
      expect(hasSessionApproval(sessionId, 'twitter', 'post')).toBe(true);
      clearSessionApprovals(sessionId);
      expect(hasSessionApproval(sessionId, 'twitter', 'post')).toBe(false);
    });
  });

  describe('buildConfirmationPrompt', () => {
    it('includes site and action', () => {
      const prompt = buildConfirmationPrompt('twitter', 'post', ['post', 'Hello world']);
      expect(prompt).toContain('twitter');
      expect(prompt).toContain('post');
    });
    it('includes command args', () => {
      const prompt = buildConfirmationPrompt('twitter', 'post', ['post', 'Hello world']);
      expect(prompt).toContain('Hello world');
    });
    it('includes confirmation instructions', () => {
      const prompt = buildConfirmationPrompt('twitter', 'post', ['post', 'test']);
      expect(prompt).toContain('confirm');
      expect(prompt).toContain('reject');
    });
    it('handles empty args array', () => {
      const prompt = buildConfirmationPrompt('twitter', 'post', []);
      expect(prompt).toContain('opencli twitter');
    });
  });
});
