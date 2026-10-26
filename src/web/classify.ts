import type { Report } from '../report/schema.js';
/** A report is partial whenever its own coverage says that a relevant source was incomplete. */
export function classifyReport(report: Report): 'completed' | 'partial' {
  const r = report as unknown as Record<string, unknown>;
  const retrieval = r.retrieval as Record<string, unknown> | undefined;
  const coverage = r.coverage_map as Record<string, unknown> | undefined;
  const diagnostics = Array.isArray(r.diagnostics) ? r.diagnostics : [];
  const text = JSON.stringify({ retrieval, coverage, diagnostics }).toLowerCase();
  return retrieval?.completeness === 'partial' ||
    retrieval?.completeness === 'incomplete' ||
    Object.values(coverage ?? {}).some((v) =>
      ['unknown', 'unavailable', 'partial'].includes(String(v)),
    ) ||
    /rate.?limit|truncat|budget.?reach|unavailable/.test(text)
    ? 'partial'
    : 'completed';
}
