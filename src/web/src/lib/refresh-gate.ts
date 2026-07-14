export type RefreshTask = () => Promise<void>;

export class RefreshGate {
  private readonly active = new Set<string>();
  private readonly lastStartedAt = new Map<string, number>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  async run(key: string, task: RefreshTask, minimumIntervalMs = 0): Promise<boolean> {
    const now = this.now();
    const lastStartedAt = this.lastStartedAt.get(key);

    if (
      this.active.has(key)
      || (lastStartedAt !== undefined && now - lastStartedAt < minimumIntervalMs)
    ) {
      return false;
    }

    this.active.add(key);
    this.lastStartedAt.set(key, now);
    try {
      await task();
      return true;
    } finally {
      this.active.delete(key);
    }
  }
}
