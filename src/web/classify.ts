import type { Report } from '../report/schema.js';
const BAD_STATES = ['unavailable', 'failed', 'rate_limited', 'partial', 'error', 'timeout'];
/**
 * A partial reason is a stable CODE plus the numbers behind it. The page maps the code to a localized sentence; `message` is a
 * plain-English fallback for clients that do not know the code. Nothing here is copied from upstream payloads.
 */
export type PartialReason = {
  code: string;
  /** How many items the reason covers (files, lookups, ...), when the report carries that number. */
  count?: number;
  /** A short machine token (a status such as "failed"), never prose. */
  detail?: string;
  message: string;
};
const o = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
/** Diagnostic codes that carry their own reason (the others become SOURCE_DIAGNOSTIC with the code as detail). */
function diagnosticReason(code: string): { code: string; message: string } | undefined {
  if (/rate_limited/.test(code))
    return { code: 'RATE_LIMITED', message: 'An upstream rate limit was reached.' };
  if (/timeout/.test(code)) return { code: 'TIMEOUT', message: 'An upstream request timed out.' };
  if (/too_large/.test(code))
    return {
      code: 'UPSTREAM_RESPONSE_TOO_LARGE',
      message: 'An upstream response was too large and was skipped.',
    };
  return undefined;
}
/**
 * Why a report is partial, derived only from report-owned completeness signals: retrieval flags, warning/error diagnostics,
 * explicit rate/budget codes, scan limits, and failed/rate-limited dependency sections. Informational absence diagnostics
 * such as scorecard_unavailable and osv_no_exact_versions do not make a report partial. Structured checks only: a text
 * search for "failed" would match the key `failed: 0` that every healthy report carries. Reasons with the same code are merged.
 */
export function explainPartial(report: Report): PartialReason[] {
  const r = report as unknown as Record<string, unknown>;
  const merged = new Map<string, PartialReason>();
  const add = (reason: PartialReason): void => {
    const prev = merged.get(reason.code);
    if (!prev) merged.set(reason.code, { ...reason });
    else if (reason.count !== undefined) prev.count = (prev.count ?? 0) + reason.count;
  };
  const retrieval = o(r.retrieval);
  if (retrieval.complete === false || retrieval.github_truncated === true)
    add({
      code: 'TREE_INCOMPLETE',
      message: 'The repository file tree could not be read completely.',
    });
  if (retrieval.stopped_by !== undefined && retrieval.stopped_by !== 'complete')
    add({
      code: 'RETRIEVAL_STOPPED',
      detail: String(retrieval.stopped_by).slice(0, 40),
      message: 'File retrieval stopped early.',
    });
  if (n(retrieval.failed_requests) > 0)
    add({
      code: 'UPSTREAM_REQUESTS_FAILED',
      count: n(retrieval.failed_requests),
      message: 'Some repository requests failed.',
    });
  const scan = o(o(r.code_analysis).scan);
  const limits = Array.isArray(scan.limits_hit) ? scan.limits_hit.length : 0;
  const overBudget = n(scan.skipped_over_budget);
  const tooLarge = n(scan.skipped_too_large);
  if (overBudget > 0)
    add({
      code: 'SOURCE_SCAN_BUDGET_EXHAUSTED',
      count: overBudget,
      message: 'Some candidate files were not fetched because the source scan budget was reached.',
    });
  if (tooLarge > 0)
    add({
      code: 'FILE_TOO_LARGE',
      count: tooLarge,
      message: 'Some files were skipped because they exceed the per-file size limit.',
    });
  const otherLimits = limits - (overBudget > 0 ? 1 : 0) - (tooLarge > 0 ? 1 : 0);
  if (otherLimits > 0)
    add({
      code: 'SCAN_LIMIT_REACHED',
      count: otherLimits,
      message: 'Another source scan limit was reached.',
    });
  const depRegistry = o(r.dependency_registry_intel);
  const depCoverage = o(depRegistry.coverage);
  if (n(depCoverage.failed) > 0)
    add({
      code: 'REGISTRY_LOOKUP_FAILED',
      count: n(depCoverage.failed),
      message: 'Some registry lookups failed.',
    });
  if (n(depCoverage.skipped) > 0)
    add({
      code: 'DEPENDENCY_LOOKUP_BUDGET_EXHAUSTED',
      count: n(depCoverage.skipped),
      message: 'Some dependencies were not looked up because the request budget was reached.',
    });
  if (BAD_STATES.includes(String(depRegistry.status)))
    add({
      code: 'DEPENDENCY_REGISTRY_UNAVAILABLE',
      detail: String(depRegistry.status),
      message: 'Dependency registry intelligence did not complete.',
    });
  const registry = o(r.registry_intel);
  if (BAD_STATES.includes(String(registry.status)))
    add({
      code: 'REGISTRY_UNAVAILABLE',
      detail: String(registry.status),
      message: 'Registry intelligence did not complete.',
    });
  if (Array.isArray(registry.limits_hit) && registry.limits_hit.length > 0)
    add({ code: 'REGISTRY_LIMIT_REACHED', message: 'Registry lookup limits were reached.' });
  const vulnerability = o(o(r.dependency_intel).vulnerability_lookup);
  if (BAD_STATES.includes(String(vulnerability.state)))
    add({
      code: 'VULNERABILITY_LOOKUP_UNAVAILABLE',
      detail: String(vulnerability.state),
      message: 'The vulnerability database lookup did not complete.',
    });
  const diagnostics = Array.isArray(r.diagnostics) ? (r.diagnostics as unknown[]).map(o) : [];
  for (const d of diagnostics) {
    const level = String(d.level ?? '');
    const code = String(d.code ?? '');
    const known = diagnosticReason(code);
    const flagged =
      level === 'warn' || level === 'error' || /rate_limited|scan_limit|budget/.test(code);
    if (!flagged) continue;
    // lookups already counted from the structured coverage numbers above
    if (code === 'dependency_registry_lookup_failed') continue;
    if (code === 'registry_lookup_failed')
      add({ code: 'REGISTRY_LOOKUP_FAILED', count: 1, message: 'Some registry lookups failed.' });
    else if (code === 'scan_limit') {
      // the scan counters above already describe it; without them the diagnostic alone still marks the report partial
      if (limits === 0 && overBudget === 0 && tooLarge === 0)
        add({ code: 'SCAN_LIMIT_REACHED', count: 1, message: 'A source scan limit was reached.' });
    } else if (known) add({ ...known, count: 1 });
    else
      add({
        code: 'SOURCE_DIAGNOSTIC',
        detail: code.slice(0, 60),
        message: 'A data source reported a problem.',
      });
  }
  return [...merged.values()];
}
export function classifyReport(report: Report): 'completed' | 'partial' {
  return explainPartial(report).length > 0 ? 'partial' : 'completed';
}
