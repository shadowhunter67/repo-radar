import { EvidenceBuilder, type Clock } from '../evidence/builder.js';
import type { CollectorResult } from '../evidence/types.js';
import { type HttpClient, RateLimitError } from '../util/http.js';
import { round, sanitizeForTerminal } from '../util/text.js';
import type { Advisory, Dependency, DepEcosystem, VulnState } from './model.js';
import { normalizeName } from './model.js';

/**
 * Known-vulnerability lookup via OSV (https://osv.dev; advisory data under the licenses of each source database).
 *
 * Only EXACT versions that the repository itself evidences (lockfile, SBOM, manifest pin) are queried. A range is
 * never turned into "some current version" to ask OSV about, because "OSV says clean" for a version nobody installed
 * says nothing. Every dependency ends in an explicit vulnerability state; "checked" requires a successful response.
 */
export const OSV_HOSTS = ['api.osv.dev'];
export const OSV_LIMITS = { maxQueries: 1000 } as const;
/** Below this share of direct registry dependencies checked, "0 vulnerable" is withheld as a score input. */
export const MIN_VULN_COVERAGE = 0.5;

const OSV_ECOSYSTEM: Partial<Record<DepEcosystem, string>> = {
  npm: 'npm',
  PyPI: 'PyPI',
  'crates.io': 'crates.io',
  Go: 'Go',
  Maven: 'Maven',
};

interface OsvBatchResponse {
  results?: { vulns?: { id?: string }[]; next_page_token?: string }[];
}

export interface VulnResult extends CollectorResult {
  performed: boolean;
  state: VulnState;
  detail?: string;
  advisories: Advisory[];
  /** True when 0 vulnerabilities were found but too few direct dependencies were checked for that to mean anything. */
  ratioWithheld: boolean;
  directChecked: number;
  directTotal: number;
}

const osvVersion = (d: Dependency): string => {
  const v = d.resolved?.version ?? '';
  return d.package.ecosystem === 'Go' ? v.replace(/^v(?=\d)/, '') : v;
};

export async function collectVulnerabilities(
  deps: Dependency[],
  http: HttpClient | undefined,
  clock: Clock,
): Promise<VulnResult> {
  const b = new EvidenceBuilder('osv', clock);
  const out: VulnResult = {
    evidence: b.evidence,
    diagnostics: b.diagnostics,
    performed: false,
    state: 'not_checked',
    advisories: [],
    ratioWithheld: false,
    directChecked: 0,
    directTotal: 0,
  };

  if (!http) {
    for (const d of deps)
      d.vulnerability = {
        state: 'not_checked',
        reason: 'vulnerability lookup disabled (--no-osv)',
        advisory_ids: [],
      };
    out.detail = 'disabled';
    return out;
  }

  // 1. Decide, per dependency, whether a lookup is even possible.
  const queryable: Dependency[] = [];
  const reasons = { unresolved: [] as string[], unsupported: 0, nonRegistry: 0 };
  for (const d of deps) {
    if (d.resolution === 'not_registry') {
      d.vulnerability = {
        state: 'not_checked',
        reason: 'workspace, path, git or URL dependency: there is no registry version to look up',
        advisory_ids: [],
      };
      reasons.nonRegistry++;
    } else if (d.resolution !== 'resolved' || !d.resolved) {
      d.vulnerability = {
        state: 'unresolved_version',
        reason:
          d.resolution === 'ambiguous'
            ? 'several versions are recorded and the request does not single one out'
            : `requested ${d.requested?.spec ? `\`${d.requested.spec}\`` : 'specification'} could not be resolved to an exact version of this revision`,
        advisory_ids: [],
      };
      if (d.direct === true) reasons.unresolved.push(d.package.name);
    } else if (!OSV_ECOSYSTEM[d.package.ecosystem]) {
      d.vulnerability = {
        state: 'unsupported_ecosystem',
        reason: `no OSV ecosystem mapping for ${d.package.ecosystem}`,
        advisory_ids: [],
      };
      reasons.unsupported++;
    } else queryable.push(d);
  }

  const directRegistry = deps.filter((d) => d.direct === true && d.resolution !== 'not_registry');
  out.directTotal = directRegistry.length;

  if (reasons.unresolved.length > 0) {
    const sample = reasons.unresolved
      .slice(0, 5)
      .map((n) => sanitizeForTerminal(n, 60))
      .join(', ');
    out.diagnostics.push({
      source: 'osv',
      level: 'info',
      code: 'dep_versions_unresolved',
      message: `${reasons.unresolved.length} direct dependenc${reasons.unresolved.length === 1 ? 'y' : 'ies'} could not be resolved to an exact version of this revision (${sample}${reasons.unresolved.length > 5 ? ', ...' : ''}). Effect: no vulnerability conclusion was made for them (not "clean"), and dependency coverage is reduced. A lockfile or an exact pin would resolve this.`,
    });
  }

  // 2. Unique, prioritized queries (direct before transitive).
  const ordered = [...queryable].sort(
    (a, c) => Number(c.direct === true) - Number(a.direct === true),
  );
  const keyOf = (d: Dependency): string =>
    `${d.package.ecosystem}\0${normalizeName(d.package.ecosystem, d.package.name)}\0${osvVersion(d)}`;
  const unique = new Map<string, Dependency[]>();
  let overBudget = 0;
  for (const d of ordered) {
    const k = keyOf(d);
    const group = unique.get(k);
    if (group) group.push(d);
    else if (unique.size < OSV_LIMITS.maxQueries) unique.set(k, [d]);
    else {
      overBudget++;
      d.vulnerability = {
        state: 'not_checked',
        reason: `query budget of ${OSV_LIMITS.maxQueries} packages exhausted`,
        advisory_ids: [],
      };
    }
  }
  if (overBudget > 0)
    out.diagnostics.push({
      source: 'osv',
      level: 'info',
      code: 'osv_query_budget',
      message: `${overBudget} locked package(s) were not checked: the OSV query budget (${OSV_LIMITS.maxQueries} unique packages per run) was exhausted. Direct dependencies are queried first.`,
    });

  if (unique.size === 0) {
    out.state = reasons.unresolved.length > 0 ? 'unresolved_version' : 'not_checked';
    out.detail = 'no dependency with an exact version of this revision to look up';
    b.diag(
      'info',
      'osv_no_exact_versions',
      'no exact dependency versions found (lockfile, SBOM or exact pins); vulnerability check skipped. Effect: no vulnerability conclusion exists for this repository, which is not the same as "no vulnerabilities".',
    );
    return out;
  }
  // 3. One batched request.
  const groups = [...unique.values()];
  const url = 'https://api.osv.dev/v1/querybatch';
  const fail = (state: VulnState, reason: string, code = 'osv_failed'): VulnResult => {
    for (const g of groups)
      for (const d of g) d.vulnerability = { state, reason, advisory_ids: [] };
    out.state = state;
    out.detail = reason;
    out.performed = true;
    b.diag(
      'warn',
      code,
      `OSV lookup failed: ${reason}. Effect: none of the ${groups.length} package(s) have a vulnerability result; absence of results is not evidence of safety.`,
      ['osv.'],
    );
    return out;
  };
  try {
    const r = await http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        queries: groups.map((g) => {
          const d = g[0] as Dependency;
          return {
            package: { name: d.package.name, ecosystem: OSV_ECOSYSTEM[d.package.ecosystem] },
            version: osvVersion(d),
          };
        }),
      }),
      maxBytes: 8_000_000,
    });
    if (r.status !== 200) return fail('lookup_failed', `OSV API returned HTTP ${r.status}`);
    let parsed: OsvBatchResponse;
    try {
      parsed = JSON.parse(r.body) as OsvBatchResponse;
    } catch {
      return fail('lookup_failed', 'OSV returned a malformed body');
    }
    const results = parsed.results ?? [];
    if (!Array.isArray(results) || results.length !== groups.length)
      return fail(
        'lookup_failed',
        'OSV returned an unexpected number of results; ignored',
        'osv_mismatch',
      );

    out.performed = true;
    const now = clock.now().toISOString();
    let vulnerable = 0;
    const allIds = new Set<string>();
    groups.forEach((g, i) => {
      const res = results[i];
      const ids = [
        ...new Set(
          (res?.vulns ?? [])
            .map((v) => (typeof v?.id === 'string' ? sanitizeForTerminal(v.id, 100) : ''))
            .filter(Boolean),
        ),
      ].slice(0, 25);
      const partial = typeof res?.next_page_token === 'string' && res.next_page_token !== '';
      if (ids.length > 0) vulnerable++;
      for (const id of ids) allIds.add(id);
      for (const d of g) {
        d.vulnerability = {
          state: partial ? 'partial' : 'checked',
          ...(partial
            ? { reason: 'OSV paginated the advisory list; only the first page was read' }
            : {}),
          advisory_ids: ids,
        };
        d.derived_from.push('advisory-db:osv');
        for (const id of ids)
          out.advisories.push({
            id,
            source: 'osv',
            package: d.package.name,
            version: d.resolved?.version ?? '',
            lookup_url: url,
            looked_up_at: now,
          });
      }
    });
    out.state = groups.some((g) => g[0]?.vulnerability.state === 'partial') ? 'partial' : 'checked';

    out.directChecked = directRegistry.filter(
      (d) => d.vulnerability.state === 'checked' || d.vulnerability.state === 'partial',
    ).length;
    const coverage = out.directTotal > 0 ? out.directChecked / out.directTotal : 1;
    const opt = {
      url,
      http_status: 200,
      confidence: round(0.5 + 0.5 * coverage, 2),
      metadata: {
        truncated_at: overBudget > 0 ? OSV_LIMITS.maxQueries : null,
        ecosystems: [...new Set(groups.map((g) => (g[0] as Dependency).package.ecosystem))],
        direct_checked: out.directChecked,
        direct_total: out.directTotal,
      },
    };
    b.add('osv.checked_packages', groups.length, opt);
    b.add('osv.vulnerable_packages', vulnerable, opt);
    b.add('osv.vulnerability_ids', [...allIds].sort().slice(0, 25), opt);
    b.add('osv.coverage_ratio', round(coverage, 3), opt);
    if (vulnerable > 0 || coverage >= MIN_VULN_COVERAGE) {
      b.add('osv.vulnerable_ratio', round(vulnerable / groups.length, 4), opt);
    } else {
      out.ratioWithheld = true;
      out.diagnostics.push({
        source: 'osv',
        level: 'info',
        code: 'osv_coverage_insufficient',
        message: `only ${out.directChecked} of ${out.directTotal} direct dependencies could be vulnerability-checked (${Math.round(coverage * 100)}%). No vulnerabilities were found among the checked ones, which says nothing about the rest, so the vulnerability rule is left unobserved instead of scoring 10/10.`,
      });
    }
  } catch (e) {
    if (e instanceof RateLimitError) return fail('lookup_failed', 'OSV rate limit reached');
    return fail('lookup_failed', e instanceof Error ? e.message : String(e));
  }
  return out;
}
