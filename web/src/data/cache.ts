/**
 * The decoded array cache.
 *
 * Architecture section 9.3. Holds what came back from the store, keyed by level
 * and tile, so a tile whose texture was evicted can be uploaded again without a
 * round trip. It sits above the texture pool and below the view, and holds
 * nothing GPU, which is what lets one cache serve several views.
 *
 * The budget is split evenly across the levels resident rather than being one
 * pool. Levels are not held over the same extent: the target level covers the
 * viewport and a ring, and each coarser level covers twice the extent of the
 * one below for the same bytes. A single pool would be spent entirely on the
 * finest level, which is the one whose tiles are least likely to be wanted
 * again, because it is the one a pan leaves behind fastest.
 */

export interface CacheOptions {
  /** Bytes to hold across every level. */
  budget: number;
}

interface Entry<T> {
  value: T;
  bytes: number;
}

/** Bytes to hold in decoded arrays, which is host memory rather than GPU. */
export const DEFAULT_ARRAY_BUDGET = 256 * 1024 * 1024;

export class ArrayCache<T> {
  private budget: number;
  /** One map per level, in access order: a Map iterates oldest first. */
  private levels = new Map<number, Map<string, Entry<T>>>();
  private bytes = 0;

  constructor(options: CacheOptions) {
    this.budget = options.budget;
  }

  /** Bytes held. */
  get size(): number {
    return this.bytes;
  }

  /** Levels holding anything, which is what the budget is divided between. */
  get levelCount(): number {
    return this.levels.size;
  }

  /** What each level may hold before it evicts its own oldest. */
  get share(): number {
    return this.budget / Math.max(1, this.levels.size);
  }

  has(level: number, key: string): boolean {
    return this.levels.get(level)?.has(key) ?? false;
  }

  /** Read an entry, which counts as using it. */
  get(level: number, key: string): T | undefined {
    const held = this.levels.get(level);
    const entry = held?.get(key);
    if (!entry || !held) return undefined;
    // Delete and re-set, so the map's insertion order is access order and the
    // first key it yields is the least recently used.
    held.delete(key);
    held.set(key, entry);
    return entry.value;
  }

  set(level: number, key: string, value: T, bytes: number) {
    let held = this.levels.get(level);
    if (!held) {
      held = new Map();
      this.levels.set(level, held);
    }
    const existing = held.get(key);
    if (existing) this.bytes -= existing.bytes;
    held.delete(key);
    held.set(key, { value, bytes });
    this.bytes += bytes;
    this.enforce(level, key);
  }

  delete(level: number, key: string) {
    const held = this.levels.get(level);
    const entry = held?.get(key);
    if (!entry || !held) return;
    held.delete(key);
    this.bytes -= entry.bytes;
    if (!held.size) this.levels.delete(level);
  }

  /** Let go of a level entirely, as when the view stops holding it. */
  dropLevel(level: number) {
    const held = this.levels.get(level);
    if (!held) return;
    for (const entry of held.values()) this.bytes -= entry.bytes;
    this.levels.delete(level);
  }

  clear() {
    this.levels.clear();
    this.bytes = 0;
  }

  /**
   * Bring every level back inside its share, then the whole cache inside the
   * budget.
   *
   * `keep` is the entry just written. A tile larger than a level's share would
   * otherwise be evicted by the very insertion that added it, and the caller
   * would be handed a cache that never holds anything.
   */
  private enforce(keep: number, keepKey: string) {
    for (const [level, held] of this.levels) {
      // Read per level rather than once. Emptying a level removes it, which
      // widens the share for the levels not yet swept, and a stale narrow share
      // would evict from them on the strength of a level that has gone.
      const share = this.share;
      let levelBytes = 0;
      for (const entry of held.values()) levelBytes += entry.bytes;
      for (const [key, entry] of held) {
        if (levelBytes <= share) break;
        if (level === keep && key === keepKey) continue;
        held.delete(key);
        levelBytes -= entry.bytes;
        this.bytes -= entry.bytes;
      }
      if (!held.size) this.levels.delete(level);
    }

    // A level count that changed during the sweep, or one level holding a
    // single oversized entry, can leave the total over budget. Oldest first
    // across everything, still sparing the new entry.
    if (this.bytes <= this.budget) return;
    for (const [level, held] of this.levels) {
      for (const [key, entry] of held) {
        if (this.bytes <= this.budget) return;
        if (level === keep && key === keepKey) continue;
        held.delete(key);
        this.bytes -= entry.bytes;
      }
      if (!held.size) this.levels.delete(level);
    }
  }
}
