import type { Override, OverrideContext, OverrideStore } from '../core/types.js';
import { pickOverride, validateOverride } from './match.js';

/** Single-process override store; pairs with {@link MemoryStore}. */
export class MemoryOverrideStore implements OverrideStore {
  private readonly items = new Map<string, Override>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  async resolve(ctx: OverrideContext): Promise<Override | undefined> {
    this.prune(ctx.now);
    return pickOverride(this.items.values(), ctx);
  }

  async list(): Promise<Override[]> {
    this.prune(this.now());
    return [...this.items.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  async put(override: Override): Promise<void> {
    validateOverride(override);
    this.items.set(override.id, override);
  }

  async remove(id: string): Promise<boolean> {
    return this.items.delete(id);
  }

  /** Number of stored overrides, including expired ones not yet pruned. */
  get size(): number {
    return this.items.size;
  }

  private prune(now: number): void {
    for (const [id, override] of this.items) {
      if (override.expiresAt <= now) this.items.delete(id);
    }
  }
}
