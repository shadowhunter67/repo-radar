import type { Report } from '../report/schema.js';
/**
 * Partial is derived only from report-owned completeness signals: retrieval flags, warning/error diagnostics,
 * explicit rate/budget codes, scan limits, and failed/rate-limited dependency sections. Informational absence
 * diagnostics such as scorecard_unavailable and osv_no_exact_versions do not make a report partial.
 */
export function classifyReport(report: Report): 'completed' | 'partial' {
  const r = report as unknown as Record<string, unknown>;
  const retrieval = r.retrieval as Record<string, unknown> | undefined;
  const diagnostics = Array.isArray(r.diagnostics) ? diagnosticsOf(r.diagnostics) : [];
  const scan = ((r.code_analysis as Record<string, unknown> | undefined)?.scan ?? {}) as Record<
    string,
    unknown
  >;
  const limits = scan.limits_hit;
  const o = (v: unknown): Record<string, unknown> =>
    v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const BAD_STATES = ['unavailable', 'failed', 'rate_limited', 'partial', 'error', 'timeout'];
  // Structured checks only: a text search for "failed" would match the key `failed: 0` that every healthy report carries.
  const depRegistry = o(r.dependency_registry_intel);
  const depCoverage = o(depRegistry.coverage);
  const registry = o(r.registry_intel);
  const vulnerability = o(o(r.dependency_intel).vulnerability_lookup);
  const sectionPartial =
    Number(depCoverage.failed ?? 0) > 0 ||
    Number(depCoverage.skipped ?? 0) > 0 ||
    BAD_STATES.includes(String(depRegistry.status)) ||
    BAD_STATES.includes(String(registry.status)) ||
    (Array.isArray(registry.limits_hit) && registry.limits_hit.length > 0) ||
    BAD_STATES.includes(String(vulnerability.state));
  const diagPartial = diagnostics.some(
    (d) =>
      d.level === 'warn' || d.level === 'error' || /rate_limited|scan_limit|budget/.test(d.code),
  );
  const retrievalPartial =
    retrieval?.complete === false ||
    retrieval?.github_truncated === true ||
    (retrieval?.stopped_by !== undefined && retrieval.stopped_by !== 'complete') ||
    Number(retrieval?.failed_requests ?? 0) > 0;
  return retrievalPartial ||
    diagPartial ||
    (Array.isArray(limits) && limits.length > 0) ||
    sectionPartial
    ? 'partial'
    : 'completed';
}
function diagnosticsOf(value: unknown): Array<{ level: string; code: string }> {
  return (value as Array<Record<string, unknown>>).map((d) => ({
    level: String(d.level ?? ''),
    code: String(d.code ?? ''),
  }));
}
