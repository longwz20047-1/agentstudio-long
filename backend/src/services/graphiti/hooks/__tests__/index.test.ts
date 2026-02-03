// backend/src/services/graphiti/hooks/__tests__/index.test.ts

import { describe, it, expect, vi } from 'vitest';
import { createGraphitiHooks } from '../index.js';
import type { GraphitiContext } from '../../types.js';

// Mock console.warn to avoid noisy output
vi.spyOn(console, 'warn').mockImplementation(() => {});

describe('createGraphitiHooks', () => {
  const mockContext: GraphitiContext = {
    base_url: 'http://localhost:8000',
    user_id: 'test-user',
  };

  it('should create SessionStart hook by default', () => {
    const hooks = createGraphitiHooks(mockContext);

    expect(hooks.SessionStart).toBeDefined();
    expect(hooks.SessionStart).toHaveLength(1);
    expect(hooks.SessionStart![0].hooks).toHaveLength(1);
  });

  it('should not create SessionStart hook when disabled', () => {
    const hooks = createGraphitiHooks(mockContext, {
      enableSessionStartHook: false,
    });

    expect(hooks.SessionStart).toBeUndefined();
  });

  it('should return empty hooks object when all disabled', () => {
    const hooks = createGraphitiHooks(mockContext, {
      enableSessionStartHook: false,
    });

    expect(Object.keys(hooks)).toHaveLength(0);
  });

  it('should return empty hooks object when context is undefined', () => {
    const hooks = createGraphitiHooks(undefined);

    expect(Object.keys(hooks)).toHaveLength(0);
  });

  it('should return empty hooks object when context is null', () => {
    const hooks = createGraphitiHooks(null);

    expect(Object.keys(hooks)).toHaveLength(0);
  });

  it('should return empty hooks object when context has no base_url', () => {
    const hooks = createGraphitiHooks({ user_id: 'test' } as any);

    expect(Object.keys(hooks)).toHaveLength(0);
  });

  it('should return empty hooks object when context has no user_id', () => {
    const hooks = createGraphitiHooks({ base_url: 'http://localhost' } as any);

    expect(Object.keys(hooks)).toHaveLength(0);
  });
});
