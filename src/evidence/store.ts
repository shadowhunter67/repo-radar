import type { Evidence } from './types.js';

/** Append-only, id-addressed evidence collection. */
export class EvidenceStore {
  private readonly byId = new Map<string, Evidence>();

  constructor(items: Evidence[] = []) {
    for (const e of items) this.add(e);
  }

  add(e: Evidence): void {
    if (this.byId.has(e.id)) throw new Error(`duplicate evidence id: ${e.id}`);
    this.byId.set(e.id, e);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get(id: string): Evidence | undefined {
    return this.byId.get(id);
  }

  /** Deterministic order (sorted by id). */
  all(): Evidence[] {
    return [...this.byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  get size(): number {
    return this.byId.size;
  }
}
