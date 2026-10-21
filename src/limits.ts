/**
 * Explicit resource limits. Hitting one must produce a diagnostic (never silently truncate results).
 * All repository content is attacker-controlled, so every loop and parser is bounded by these.
 */
export const LIMITS = {
  /** Files fetched for static scanning (scripts, build files, source sample). */
  maxScanFiles: 40,
  /** Per-file byte cap for scanned files. Larger files are skipped and counted. */
  maxScanFileBytes: 64 * 1024,
  /** Total bytes held in memory for scanned files. */
  maxScanTotalBytes: 2 * 1024 * 1024,
  /** Lines longer than this are cut before any regex runs (bounded regex input). */
  maxLineChars: 2000,
  /** Lines scanned per file. */
  maxLinesPerFile: 6000,
  /** Detections kept in the report (the rest is counted). */
  maxDetections: 300,
  maxSecretCandidates: 50,
  /** Execution graph size and script-resolution depth. */
  maxGraphNodes: 300,
  maxScriptDepth: 5,
  maxScriptsPerManifest: 100,
  maxScriptChars: 4000,
  /** Reference-following rounds when tracing install scripts to the files they run. */
  maxRefRounds: 2,
  maxRefsPerRound: 10,
  /** External domain extraction: URL length, observations kept, distinct hosts tracked and reported, references per file. */
  maxUrlChars: 300,
  maxDomainObservations: 3000,
  maxDomainsTracked: 600,
  maxDomainsReported: 300,
  maxDomainsPerFile: 80,
  /** Dependency artifact inspection limits. */
  maxArtifactsPerRun: 5,
  maxArtifactCompressedBytes: 4 * 1024 * 1024,
  maxArtifactTotalCompressedBytes: 12 * 1024 * 1024,
  maxArtifactEntries: 20_000,
  maxArtifactMetadataBytes: 16 * 1024 * 1024,
  maxArtifactFileBytes: 64 * 1024,
  /** Bounded dependency-introduction history collection. */
  maxDependencyHistoryCandidates: 25,
  maxDependencyHistoryCommits: 120,
  maxDependencyHistoryRequests: 60,
  maxDependencyHistoryMs: 10_000,
  maxDependencyHistoryChangedFiles: 120,
  maxDependencyHistoryBytes: 4 * 1024 * 1024,
} as const;
