import type { Clock, PracticeId } from '../ports.js';

export interface TokenBucketConfig {
  /** Most tokens the bucket holds (burst size). */
  readonly capacity: number;
  /** Tokens added per second. */
  readonly refillPerSecond: number;
}

/** A token bucket driven by an injected clock. Starts full. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly config: TokenBucketConfig,
    private readonly clock: Clock,
  ) {
    if (!(config.capacity >= 1) || !(config.refillPerSecond > 0)) {
      throw new Error('token bucket needs capacity >= 1 and refillPerSecond > 0');
    }
    this.tokens = config.capacity;
    this.last = clock.now().getTime();
  }

  private refill(): void {
    const now = this.clock.now().getTime();
    const elapsed = Math.max(0, now - this.last);
    this.tokens = Math.min(this.config.capacity, this.tokens + (elapsed / 1000) * this.config.refillPerSecond);
    this.last = now;
  }

  available(): number {
    this.refill();
    return this.tokens;
  }

  tryTake(count = 1): boolean {
    this.refill();
    if (this.tokens < count) return false;
    this.tokens -= count;
    return true;
  }

  /** Milliseconds until `count` tokens are available (0 if they are now). */
  msUntil(count = 1): number {
    this.refill();
    if (this.tokens >= count) return 0;
    return Math.ceil(((count - this.tokens) / this.config.refillPerSecond) * 1000);
  }
}

/** One token bucket per practice, so one busy practice cannot spend another's request budget. */
export class PracticeRateLimiter {
  private readonly buckets = new Map<PracticeId, TokenBucket>();

  constructor(
    private readonly defaults: TokenBucketConfig,
    private readonly clock: Clock,
    private readonly overrides: ReadonlyMap<PracticeId, TokenBucketConfig> = new Map(),
  ) {}

  private bucket(practiceId: PracticeId): TokenBucket {
    let b = this.buckets.get(practiceId);
    if (!b) {
      b = new TokenBucket(this.overrides.get(practiceId) ?? this.defaults, this.clock);
      this.buckets.set(practiceId, b);
    }
    return b;
  }

  tryTake(practiceId: PracticeId): boolean {
    return this.bucket(practiceId).tryTake();
  }

  msUntilAvailable(practiceId: PracticeId): number {
    return this.bucket(practiceId).msUntil();
  }

  /** Practices seen so far whose bucket is empty right now. */
  exhaustedPractices(): PracticeId[] {
    return [...this.buckets.entries()].filter(([, b]) => b.available() < 1).map(([id]) => id);
  }
}
