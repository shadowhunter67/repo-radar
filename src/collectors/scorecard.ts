import { EvidenceBuilder, type Clock } from '../evidence/builder.js';
import type { CollectorResult } from '../evidence/types.js';
import type { HttpClient } from '../util/http.js';
import { daysBetween } from '../util/text.js';
import type { RepoRef } from '../util/repo-ref.js';

export const SCORECARD_HOSTS = ['api.securityscorecards.dev'];

interface ScorecardResponse {
  date?: string;
  score?: number;
  scorecard?: { version?: string };
  checks?: { name?: string; score?: number }[];
}

/**
 * OpenSSF Scorecard (Apache-2.0 project; we only read its public API results).
 * Scores of -1 mean "inconclusive" and are treated as *not observed*.
 */
export async function collectScorecard(
  ref: RepoRef,
  http: HttpClient,
  clock: Clock,
): Promise<CollectorResult> {
  const b = new EvidenceBuilder('scorecard', clock);
  const url = `https://api.securityscorecards.dev/projects/github.com/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
  try {
    const r = await http.request(url, {
      headers: { Accept: 'application/json' },
      maxBytes: 1_000_000,
    });
    if (r.status === 404) {
      b.diag(
        'info',
        'scorecard_unavailable',
        'no OpenSSF Scorecard result published for this repository',
      );
      return { evidence: b.evidence, diagnostics: b.diagnostics };
    }
    if (r.status !== 200) {
      b.diag('warn', 'scorecard_failed', `Scorecard API returned HTTP ${r.status}`, ['scorecard.']);
      return { evidence: b.evidence, diagnostics: b.diagnostics };
    }
    const j = JSON.parse(r.body) as ScorecardResponse;
    const ageDays = j.date ? daysBetween(clock.now(), new Date(j.date)) : undefined;
    // Unknown, unparsable or future-dated timestamps get a neutral confidence instead of "fresh".
    const fresh =
      ageDays === undefined || !Number.isFinite(ageDays) || ageDays < -2
        ? 0.8
        : ageDays <= 90
          ? 1
          : ageDays <= 365
            ? 0.7
            : 0.4;
    const meta = {
      scorecard_date: j.date ?? 'unknown',
      scorecard_version: j.scorecard?.version ?? 'unknown',
    };
    const opt = { url, http_status: 200, confidence: fresh, metadata: meta };
    if (typeof j.score === 'number' && j.score >= 0) b.add('scorecard.score', j.score, opt);
    for (const c of (j.checks ?? []).slice(0, 50)) {
      if (typeof c.name !== 'string' || typeof c.score !== 'number' || c.score < 0) continue;
      const slug = c.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '');
      if (slug) b.add(`scorecard.check.${slug}`, c.score, opt);
    }
  } catch (e) {
    b.diag(
      'warn',
      'scorecard_failed',
      `Scorecard lookup failed: ${e instanceof Error ? e.message : String(e)}`,
      ['scorecard.'],
    );
  }
  return { evidence: b.evidence, diagnostics: b.diagnostics };
}
