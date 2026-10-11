import type { Finding } from '../analysis/findings.js';
import type { Fact } from '../facts/index.js';
import type { RegistryIntel, RegistryPackage, RepoMatch } from './model.js';

/**
 * Findings and facts from registry intelligence. Most are SIGNALS: they describe observable registry state or publish history
 * and are never vulnerabilities. Facts are emitted only when the lookups behind them worked, so an unavailable registry stays
 * "unknown" and can never read as a clean result.
 */
const safe = (s: string): string => s.replace(/[^\x20-\x7e]/g, '?').slice(0, 80);

export function buildRegistryFindings(intel: RegistryIntel): Finding[] {
  if (intel.status !== 'analyzed') return [];
  const out: Finding[] = [];
  let n = 0;
  const id = (): string => `RR-REG-${String(++n).padStart(3, '0')}`;
  for (const sig of intel.signals) {
    const base = {
      id: id(),
      dimension: 'supply-chain' as const,
      category: 'registry' as const,
      evidence_ids: [sig.id],
      rule_ids: [] as string[],
      standards: [] as string[],
      intent: 'undetermined' as const,
    };
    const who = `${sig.registry}:${safe(sig.package)}`;
    switch (sig.kind) {
      case 'repository_mismatch':
        out.push({
          ...base,
          title: 'Registry package points to a different source repository',
          severity: 'medium',
          confidence: sig.confidence,
          summary: `${who}: ${safe(sig.detail)}. The same name does not prove the same project.`,
          remediation:
            'Compare the package name, publisher and source URL with the repository before installing; prefer a package whose registry metadata points back to this repository.',
        });
        break;
      case 'new_publisher':
        out.push({
          ...base,
          title: 'Recent versions were published by a new account',
          severity: 'low',
          confidence: sig.confidence,
          summary: `${who}: ${safe(sig.detail)}. A legitimate maintainer hand-over looks the same; intent is undetermined.`,
          remediation:
            'Confirm the change of publisher with the project through an independent channel and review the diff between the last two versions.',
        });
        break;
      case 'dormancy_then_publish':
        out.push({
          ...base,
          title: 'A version was published after a long gap',
          severity: 'info',
          confidence: sig.confidence,
          summary: `${who}: ${safe(sig.detail)}.`,
          remediation: 'Review what changed in the version that ended the gap.',
        });
        break;
      case 'suspicious_publisher_name':
        out.push({
          ...base,
          title: 'Publisher or maintainer name with unusual characters',
          severity: 'low',
          confidence: sig.confidence,
          summary: `${who}: ${safe(sig.detail)}. Look-alike account names are used to impersonate maintainers.`,
          remediation:
            "Check the account name character by character against the project's documented maintainers.",
        });
        break;
      case 'provenance_missing':
        out.push({
          ...base,
          title: 'Registry reports no provenance attestation for the latest version',
          severity: 'info',
          confidence: sig.confidence,
          summary: `${who}: ${safe(sig.detail)}.`,
          remediation:
            'Publish with registry-supported provenance (for example npm publish --provenance from CI) so consumers can check the build origin.',
        });
        break;
      default:
        break; // informational state signals (provenance_present, cadence_change, ...) stay in registry_intel
    }
  }
  return out;
}

const RANK: Record<RepoMatch, number> = {
  conflicting: 4,
  unknown: 3,
  missing: 2,
  likely: 1,
  confirmed: 0,
};

export function deriveRegistryFacts(intel: RegistryIntel): Fact[] {
  if (intel.status !== 'analyzed') return [];
  const facts: Fact[] = [];
  const f = (idv: string, value: number | boolean | string, from: string[], conf = 0.8): void => {
    facts.push({
      id: idv,
      value,
      confidence: conf,
      scope: 'registry',
      derived_from: from,
      derived_by: 'registry-intel@0.1',
    });
  };
  const pk: RegistryPackage[] = intel.packages;
  const from = pk.map((p) => `registry:${p.registry}:${safe(p.name)}`).slice(0, 10);
  const ok = pk.filter((p) => p.status === 'ok' || p.status === 'partial');
  f('registry.packages.count', pk.length, from);
  f('registry.lookup_complete', ok.length === pk.length, from, 0.9);
  // worst correspondence over ALL packages; a failed lookup is `unknown`, not `confirmed`
  const worst = pk.reduce<RepoMatch>(
    (w, p) => (RANK[p.repository.match] > RANK[w] ? p.repository.match : w),
    'confirmed',
  );
  f('registry.repository_match', worst, from, ok.length === pk.length ? 0.85 : 0.5);
  if (ok.length === pk.length) {
    const npm = ok.filter((p) => p.registry === 'npm');
    if (npm.length > 0)
      f(
        'registry.provenance_reported',
        npm.every((p) => p.provenance.reported === 'yes' && p.versions[0]?.has_provenance === true),
        from,
        0.7,
      );
    const kinds = new Set(intel.signals.map((s) => s.kind));
    f('registry.publisher_stable', !kinds.has('new_publisher'), from, 0.5);
    f('registry.dormancy_then_publish', kinds.has('dormancy_then_publish'), from, 0.5);
  }
  return facts;
}
