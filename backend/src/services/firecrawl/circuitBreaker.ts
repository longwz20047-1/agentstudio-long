// backend/src/services/firecrawl/circuitBreaker.ts

export class FirecrawlCircuitBreaker {
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;

  constructor(
    private readonly threshold = 3,
    private readonly cooldownMs = 5 * 60 * 1000
  ) {}

  isOpen(): boolean {
    if (this.consecutiveFailures < this.threshold) return false;
    if (Date.now() >= this.circuitOpenUntil) {
      this.consecutiveFailures = 0;
      this.circuitOpenUntil = 0;
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.circuitOpenUntil = 0;
  }

  recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.threshold) {
      this.circuitOpenUntil = Date.now() + this.cooldownMs;
    }
  }

  reset(): void {
    this.consecutiveFailures = 0;
    this.circuitOpenUntil = 0;
  }
}

// 模块级单例，所有 Firecrawl 调用共享
export const firecrawlCircuitBreaker = new FirecrawlCircuitBreaker();
