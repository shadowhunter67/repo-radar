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
} as const;
