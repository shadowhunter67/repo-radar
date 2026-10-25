/** Fields intentionally allowed to vary between otherwise identical analyses. */
export const REPORT_DETERMINISM_VARYING_FIELDS = [
  'generated_at',
  'analysis_manifest.external_source_retrieval_timestamps',
  'analysis_manifest.budgets.elapsed_ms',
  'analysis_manifest.request_counters',
  'analysis_manifest.duration_ms',
] as const;
