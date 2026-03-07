import { describe, it, expect, beforeEach } from 'vitest';
import { FirecrawlCircuitBreaker } from '../circuitBreaker.js';

describe('FirecrawlCircuitBreaker', () => {
  let cb: FirecrawlCircuitBreaker;

  beforeEach(() => {
    cb = new FirecrawlCircuitBreaker(3, 5000);
  });

  it('should start closed', () => {
    expect(cb.isOpen()).toBe(false);
  });

  it('should stay closed below threshold', () => {
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen()).toBe(false);
  });

  it('should open after threshold failures', () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen()).toBe(true);
  });

  it('should close after success', () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    cb.recordFailure(); // only 1 after reset
    expect(cb.isOpen()).toBe(false);
  });

  it('should reset via reset()', () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    cb.reset();
    expect(cb.isOpen()).toBe(false);
  });
});
