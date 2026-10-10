import type { Evidence, EvidenceSource, EvidenceValue, Diagnostic } from './types.js';

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

export interface AddOptions {
  kind?: 'fact' | 'heuristic';
  confidence?: number;
  url?: string;
  ref?: string;
  http_status?: number;
  method?: string;
  metadata?: Record<string, unknown>;
  source?: EvidenceSource;
}

/** Collects evidence + diagnostics for one collector, stamping source/time consistently. */
export class EvidenceBuilder {
  readonly evidence: Evidence[] = [];
  readonly diagnostics: Diagnostic[] = [];

  constructor(
    private readonly source: EvidenceSource,
    private readonly clock: Clock,
  ) {}

  add(id: string, value: EvidenceValue, opts: AddOptions = {}): void {
    const provenance: Evidence['provenance'] = {};
    if (opts.url !== undefined) provenance.url = opts.url;
    if (opts.ref !== undefined) provenance.ref = opts.ref;
    if (opts.http_status !== undefined) provenance.http_status = opts.http_status;
    if (opts.method !== undefined) provenance.method = opts.method;
    this.evidence.push({
      id,
      value,
      source: opts.source ?? this.source,
      kind: opts.kind ?? 'fact',
      observed_at: this.clock.now().toISOString(),
      confidence: Math.max(0, Math.min(1, opts.confidence ?? 1)),
      provenance,
      metadata: opts.metadata ?? {},
    });
  }

  diag(level: Diagnostic['level'], code: string, message: string, affects?: string[]): void {
    this.diagnostics.push({
      source: this.source,
      level,
      code,
      message,
      ...(affects && affects.length > 0 ? { affects } : {}),
    });
  }
}
