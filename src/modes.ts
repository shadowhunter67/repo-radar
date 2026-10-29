import type { DepRegistryBudget } from './registry/dependency-model.js';
import { LIMITS } from './limits.js';

/**
 * Quick and Deep are two RETRIEVAL profiles over the SAME analyzer: the same facts, rules, scoring, findings, schema and
 * methodology. Deep reads more (more source files, larger files, more dependency lookups), nothing else. If both observe the same
 * evidence they reach the same conclusion about it.
 *
 * Quick is the screening profile (and the only one the hosted Web Analyzer uses); its values are exactly the long-standing
 * defaults of the engine, so an analysis without a mode behaves as before. Deep is a generous but still bounded profile meant
 * for a developer workstation. Expensive optional collectors (history, artifact inspection, cryptographic verification) are
 * NOT switched on by Deep; they keep their own explicit flags.
 */
export const ANALYSIS_MODES = ['quick', 'deep'] as const;
export type AnalysisMode = (typeof ANALYSIS_MODES)[number];

export interface ScanBudget {
  /** Source/script/build files fetched for static scanning (workflows and manifests are counted separately). */
  maxFiles: number;
  /** Per-file byte cap; larger files are skipped and counted. */
  maxFileBytes: number;
  /** Total bytes of scanned files held in memory. */
  maxTotalBytes: number;
  /** Reference-following rounds when tracing install scripts to the files they run. */
  maxRefRounds: number;
}

export interface AnalysisProfile {
  mode: AnalysisMode;
  scan: ScanBudget;
  /** Overrides on top of DEP_REGISTRY_BUDGET_DEFAULTS (empty = engine defaults). */
  dependencyRegistry: Partial<DepRegistryBudget>;
}

const QUICK: AnalysisProfile = {
  mode: 'quick',
  scan: {
    maxFiles: LIMITS.maxScanFiles,
    maxFileBytes: LIMITS.maxScanFileBytes,
    maxTotalBytes: LIMITS.maxScanTotalBytes,
    maxRefRounds: LIMITS.maxRefRounds,
  },
  dependencyRegistry: {},
};

const DEEP: AnalysisProfile = {
  mode: 'deep',
  scan: {
    maxFiles: 200,
    maxFileBytes: 128 * 1024,
    maxTotalBytes: 12 * 1024 * 1024,
    maxRefRounds: 3,
  },
  dependencyRegistry: {
    maxDependencies: 150,
    maxRequests: 300,
    maxElapsedMs: 180_000,
    maxBytes: 160 * 1024 * 1024,
  },
};

export function isAnalysisMode(value: unknown): value is AnalysisMode {
  return typeof value === 'string' && (ANALYSIS_MODES as readonly string[]).includes(value);
}

/** The single place where the two profiles are defined. Returns a copy: callers may not mutate the profiles. */
export function getAnalysisProfile(mode: AnalysisMode = 'quick'): AnalysisProfile {
  const p = mode === 'deep' ? DEEP : QUICK;
  return { mode: p.mode, scan: { ...p.scan }, dependencyRegistry: { ...p.dependencyRegistry } };
}
