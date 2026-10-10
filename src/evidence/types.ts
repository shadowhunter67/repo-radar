import { z } from 'zod';

export const EVIDENCE_SCHEMA_VERSION = '0.2';

export const EvidenceSources = [
  'github',
  'scorecard',
  'osv',
  'manifest',
  'heuristic',
  'identity',
  'derived',
] as const;
export type EvidenceSource = (typeof EvidenceSources)[number];

export const EvidenceValueSchema = z.union([
  z.boolean(),
  z.number(),
  z.string(),
  z.array(z.string()),
]);
export type EvidenceValue = z.infer<typeof EvidenceValueSchema>;

export const EvidenceIdSchema = z
  .string()
  .regex(/^[a-z0-9_]+(\.[a-z0-9_-]+)+$/, 'invalid evidence id');

export const EvidenceSchema = z.object({
  id: EvidenceIdSchema,
  value: EvidenceValueSchema,
  source: z.enum(EvidenceSources),
  /** `fact`: read directly from an API/file. `heuristic`: inferred by a rule of thumb. */
  kind: z.enum(['fact', 'heuristic']),
  observed_at: z.string(),
  /** How sure the collector is that `value` is correct (sample size, parsing certainty...). */
  confidence: z.number().min(0).max(1),
  provenance: z.object({
    url: z.string().optional(),
    ref: z.string().optional(),
    http_status: z.number().optional(),
    method: z.string().optional(),
  }),
  metadata: z.record(z.string(), z.unknown()),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export type DiagnosticLevel = 'info' | 'warn' | 'error';
export interface Diagnostic {
  source: string;
  level: DiagnosticLevel;
  code: string;
  message: string;
  /** Evidence-id prefixes that could not be collected because of this problem. */
  affects?: string[];
}

export interface CollectorResult {
  evidence: Evidence[];
  diagnostics: Diagnostic[];
}

/** Per-source reliability multiplier used by the confidence model (see docs/methodology.md). */
export const SOURCE_RELIABILITY: Record<EvidenceSource, number> = {
  github: 1.0,
  scorecard: 0.9,
  osv: 0.9,
  manifest: 0.9,
  heuristic: 0.6,
  identity: 0.7,
  /** Derived facts carry their own confidence; no extra source discount. */
  derived: 1.0,
};
