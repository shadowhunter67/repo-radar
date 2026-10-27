import type { Report } from '../report/schema.js';
const BAD_STATES = ['unavailable', 'failed', 'rate_limited', 'partial', 'error', 'timeout'];
export type PartialReason = { code: string; message: string };
const o = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
/**
 * Why a report is partial, derived only from report-owned completeness signals: retrieval flags, warning/error diagnostics,
 * explicit rate/budget codes, scan limits, and failed/rate-limited dependency sections. Informational absence diagnostics
 * such as scorecard_unavailable and osv_no_exact_versions do not make a report partial. Structured checks only: a text
 * search for "failed" would match the key `failed: 0` that every healthy report carries.
 */
export function explainPartial(report: Report): PartialReason[] {
  const r = report as unknown as Record<string, unknown>;
  const reasons: PartialReason[] = [];
  const retrieval = o(r.retrieval);
  if (retrieval.complete === false || retrieval.github_truncated === true)
    reasons.push({
      code: 'retrieval_incomplete',
      message: 'The repository file tree could not be read completely.',
    });
  if (retrieval.stopped_by !== undefined && retrieval.stopped_by !== 'complete')
    reasons.push({
      code: 'retrieval_stopped',
      message: `File retrieval stopped early (${String(retrieval.stopped_by)}).`,
    });
  if (Number(retrieval.failed_requests ?? 0) > 0)
    reasons.push({
      code: 'retrieval_failed_requests',
      message: `${Number(retrieval.failed_requests)} repository request(s) failed.`,
    });
  const limits = o(o(r.code_analysis).scan).limits_hit;
  if (Array.isArray(limits) && limits.length > 0)
    reasons.push({
      code: 'scan_limits',
      message: `Source scan limits were reached: ${limits.map(String).slice(0, 3).join('; ')}.`,
    });
  const depRegistry = o(r.dependency_registry_intel);
  const depCoverage = o(depRegistry.coverage);
  if (Number(depCoverage.failed ?? 0) > 0)
    reasons.push({
      code: 'dependency_registry_failed',
      message: `${Number(depCoverage.failed)} dependency registry lookup(s) failed.`,
    });
  if (Number(depCoverage.skipped ?? 0) > 0)
    reasons.push({
      code: 'dependency_registry_skipped',
      message: `${Number(depCoverage.skipped)} dependency(ies) were not looked up because of the request budget.`,
    });
  if (BAD_STATES.includes(String(depRegistry.status)))
    reasons.push({
      code: 'dependency_registry_status',
      message: `Dependency registry intelligence ended as "${String(depRegistry.status)}".`,
    });
  const registry = o(r.registry_intel);
  if (BAD_STATES.includes(String(registry.status)))
    reasons.push({
      code: 'registry_status',
      message: `Registry intelligence ended as "${String(registry.status)}".`,
    });
  if (Array.isArray(registry.limits_hit) && registry.limits_hit.length > 0)
    reasons.push({ code: 'registry_limits', message: 'Registry lookup limits were reached.' });
  const vulnerability = o(o(r.dependency_intel).vulnerability_lookup);
  if (BAD_STATES.includes(String(vulnerability.state)))
    reasons.push({
      code: 'vulnerability_lookup',
      message: `The vulnerability database lookup ended as "${String(vulnerability.state)}".`,
    });
  const diagnostics = Array.isArray(r.diagnostics) ? (r.diagnostics as unknown[]).map(o) : [];
  for (const d of diagnostics) {
    const level = String(d.level ?? '');
    const code = String(d.code ?? '');
    if (level === 'warn' || level === 'error' || /rate_limited|scan_limit|budget/.test(code))
      reasons.push({
        code: `diagnostic:${code}`,
        message: `${String(d.source ?? 'analysis')}: ${String(d.message ?? code).slice(0, 200)}`,
      });
  }
  return reasons;
}
export function classifyReport(report: Report): 'completed' | 'partial' {
  return explainPartial(report).length > 0 ? 'partial' : 'completed';
}
