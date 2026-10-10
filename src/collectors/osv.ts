import { EvidenceBuilder, type Clock } from '../evidence/builder.js';
import type { CollectorResult } from '../evidence/types.js';
import type { HttpClient } from '../util/http.js';
import { round } from '../util/text.js';
import type { LockedPackage } from './manifests/parse.js';

export const OSV_HOSTS = ['api.osv.dev'];
const MAX_QUERIES = 1000;

interface OsvBatchResponse {
  results?: { vulns?: { id?: string }[] }[];
}

/**
 * Known-vulnerability lookup via OSV (https://osv.dev, data under CC-BY-4.0/per-source licenses).
 * Only exact versions are queried; ranges are never guessed.
 * OSV batch results carry ids only, so severity is deliberately not scored.
 */
export async function collectOsv(
  locked: LockedPackage[],
  directDependencyCount: number,
  http: HttpClient,
  clock: Clock,
): Promise<CollectorResult> {
  const b = new EvidenceBuilder('osv', clock);
  const seen = new Set<string>();
  const queries: LockedPackage[] = [];
  for (const p of locked) {
    const k = `${p.ecosystem}\0${p.name}\0${p.version}`;
    if (!seen.has(k) && queries.length < MAX_QUERIES) {
      seen.add(k);
      queries.push(p);
    }
  }
  if (queries.length === 0) {
    b.diag(
      'info',
      'osv_no_exact_versions',
      'no exact dependency versions found (lockfile/pins); vulnerability check skipped',
    );
    return { evidence: b.evidence, diagnostics: b.diagnostics };
  }
  const url = 'https://api.osv.dev/v1/querybatch';
  try {
    const r = await http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        queries: queries.map((p) => ({
          package: { name: p.name, ecosystem: p.ecosystem },
          version: p.version,
        })),
      }),
      maxBytes: 4_000_000,
    });
    if (r.status !== 200) {
      b.diag('warn', 'osv_failed', `OSV API returned HTTP ${r.status}`, ['osv.']);
      return { evidence: b.evidence, diagnostics: b.diagnostics };
    }
    const results = (JSON.parse(r.body) as OsvBatchResponse).results ?? [];
    if (results.length !== queries.length) {
      b.diag('warn', 'osv_mismatch', 'OSV returned an unexpected number of results; ignored', [
        'osv.',
      ]);
      return { evidence: b.evidence, diagnostics: b.diagnostics };
    }
    const vulnerable = results.filter((x) => (x?.vulns?.length ?? 0) > 0).length;
    const ids = [
      ...new Set(results.flatMap((x) => (x?.vulns ?? []).map((v) => v?.id ?? '')).filter(Boolean)),
    ].sort();
    // Lockfile coverage covers transitive deps too; without any lockfile only direct pins are seen.
    const coverage =
      directDependencyCount > 0 ? Math.min(1, queries.length / directDependencyCount) : 1;
    const opt = {
      url,
      http_status: 200,
      confidence: round(0.5 + 0.5 * coverage, 2),
      metadata: {
        truncated_at: queries.length >= MAX_QUERIES ? MAX_QUERIES : null,
        ecosystems: [...new Set(queries.map((q) => q.ecosystem))],
      },
    };
    b.add('osv.checked_packages', queries.length, opt);
    b.add('osv.vulnerable_packages', vulnerable, opt);
    b.add('osv.vulnerable_ratio', round(vulnerable / queries.length, 4), opt);
    b.add('osv.vulnerability_ids', ids.slice(0, 25), opt);
    b.add('osv.coverage_ratio', round(coverage, 3), opt);
  } catch (e) {
    b.diag(
      'warn',
      'osv_failed',
      `OSV lookup failed: ${e instanceof Error ? e.message : String(e)}`,
      ['osv.'],
    );
  }
  return { evidence: b.evidence, diagnostics: b.diagnostics };
}
