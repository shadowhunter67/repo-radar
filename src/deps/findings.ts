import type { Finding } from '../analysis/findings.js';
import type { Fact } from '../facts/index.js';
import { round } from '../util/text.js';
import { sanitizeForTerminal } from '../util/text.js';
import type { DependencyIntel } from './model.js';

/**
 * Dependency and SBOM findings. Severity (how bad if true) and confidence (how sure we are it is true) are separate:
 * an unpinned git branch is a supply-chain RISK SIGNAL with high confidence, not a vulnerability; a possible SBOM
 * mismatch is low-severity with the confidence of the comparison.
 */
export function buildDependencyFindings(intel: DependencyIntel): Finding[] {
  const out: Finding[] = [];
  let n = 0;
  const id = (): string => `RR-DEP-${String(++n).padStart(3, '0')}`;
  const base = { standards: [] as string[], intent: 'undetermined' as const };
  const name = (s: string): string => sanitizeForTerminal(s, 80);
  const deps = intel.dependencies;

  // Known-vulnerable exact dependencies (one finding each, bounded).
  for (const d of deps.filter((x) => x.vulnerability.advisory_ids.length > 0).slice(0, 15)) {
    const src = d.resolved?.source;
    out.push({
      id: id(),
      title: `Known advisories for ${name(d.package.name)}@${name(d.resolved?.version ?? '?')} (${d.vulnerability.advisory_ids.length})`,
      // OSV batch results carry ids only, so the real severity is not known here: do not invent one.
      severity: 'medium',
      confidence: src === 'lockfile' ? 0.9 : src === 'manifest_pin' ? 0.8 : 0.65,
      dimension: 'security',
      category: 'dependency',
      evidence_ids: [d.id],
      rule_ids: d.direct === true ? ['security.known-vulnerabilities'] : [],
      ...base,
      summary: `${d.direct === true ? 'Direct' : 'Transitive'} ${d.package.ecosystem} dependency at the exact version ${name(d.resolved?.version ?? '?')} (from ${src}) is listed in: ${d.vulnerability.advisory_ids.slice(0, 5).map(name).join(', ')}. Severity is not determined (the lookup returns identifiers only); an advisory does not mean the vulnerable code path is reachable.`,
      remediation:
        'Open the advisory ids, check affected and fixed versions, and update or document why the path is not reachable.',
    });
  }

  // Unresolved direct registry dependencies (aggregate).
  const s = intel.summary;
  const unresolved = deps.filter(
    (d) =>
      d.direct === true &&
      d.context === 'primary' &&
      d.resolution !== 'resolved' &&
      d.resolution !== 'not_registry',
  );
  if (unresolved.length > 0 || s.direct_unresolved + s.direct_ambiguous > 0) {
    const total = s.direct_unresolved + s.direct_ambiguous;
    out.push({
      id: id(),
      title: `${total} direct dependenc${total === 1 ? 'y has' : 'ies have'} no exact version in this revision`,
      severity: 'info',
      confidence: 0.9,
      dimension: 'supply-chain',
      category: 'dependency',
      evidence_ids: unresolved.slice(0, 10).map((d) => d.id),
      rule_ids: ['supply-chain.dependency-resolution'],
      ...base,
      summary: `Only a range, tag or ambiguous request was found for ${total} of ${s.direct_registry} direct registry dependencies (e.g. ${unresolved
        .slice(0, 3)
        .map((d) => `${name(d.package.name)} ${name(d.requested?.spec ?? '')}`)
        .join(
          '; ',
        )}). No vulnerability conclusion exists for them and dependency coverage is reduced. This is a coverage limit, not a defect score.`,
      remediation:
        'Commit a lockfile (applications) or document the supported ranges (libraries); analysis cannot know what a range resolved to at this revision.',
    });
  }

  // Mutable references.
  const branch = deps.filter((d) => d.requested?.kind === 'branch');
  if (branch.length > 0)
    out.push({
      id: id(),
      title: `${branch.length} dependenc${branch.length === 1 ? 'y follows' : 'ies follow'} a mutable git branch`,
      severity: 'medium',
      confidence: 0.9,
      dimension: 'supply-chain',
      category: 'dependency',
      evidence_ids: branch.slice(0, 10).map((d) => d.id),
      rule_ids: [],
      ...base,
      summary: `A branch (or the default branch) can change under the same specification: ${branch
        .slice(0, 3)
        .map((d) => `${name(d.package.name)} ${name(d.requested?.spec ?? '')}`)
        .join('; ')}. This is a supply-chain risk signal, not a vulnerability.`,
      remediation: 'Pin git dependencies to a full commit SHA.',
    });
  const tags = deps.filter((d) => d.requested?.kind === 'tag');
  if (tags.length > 0)
    out.push({
      id: id(),
      title: `${tags.length} dependenc${tags.length === 1 ? 'y uses' : 'ies use'} a mutable dist-tag`,
      severity: 'low',
      confidence: 0.85,
      dimension: 'supply-chain',
      category: 'dependency',
      evidence_ids: tags.slice(0, 10).map((d) => d.id),
      rule_ids: [],
      ...base,
      summary: `Tags such as \`latest\` move over time: ${tags
        .slice(0, 3)
        .map((d) => `${name(d.package.name)} ${name(d.requested?.spec ?? '')}`)
        .join('; ')}.`,
      remediation: 'Request a version or range instead of a tag.',
    });

  // Manifest/lockfile and lockfile/SBOM disagreements.
  for (const c of intel.conflicts.filter((x) => x.kind !== 'multiple_locked_versions').slice(0, 10))
    out.push({
      id: id(),
      title: `${c.kind === 'manifest_vs_lockfile' ? 'Manifest and lockfile disagree' : 'Lockfile and SBOM disagree'} for ${name(c.package)}`,
      severity: 'low',
      confidence: 0.75,
      dimension: 'supply-chain',
      category: c.kind === 'lockfile_vs_sbom' ? 'sbom' : 'dependency',
      evidence_ids: [],
      rule_ids: [],
      ...base,
      summary: `${name(c.detail)}. The lockfile value was used (lockfile > SBOM > manifest pin); the other value is kept in the dependency record.`,
      remediation: 'Regenerate the lockfile or SBOM so they describe the same dependency set.',
    });

  // SBOM comparison and validity.
  for (const c of intel.sbom_comparisons) {
    if (c.state === 'mismatch' || c.state === 'partial') {
      out.push({
        id: id(),
        title: `SBOM ${name(c.sbom_path)} is ${c.state} with the repository's dependencies`,
        severity: c.state === 'mismatch' ? 'medium' : 'low',
        confidence: round(c.confidence * 0.9, 2),
        dimension: 'supply-chain',
        category: 'sbom',
        evidence_ids: [],
        rule_ids: [],
        ...base,
        summary: `${c.matched} of ${c.direct_runtime_dependencies} direct runtime dependencies were found; ${c.missing_from_sbom.length} missing (${c.missing_from_sbom.slice(0, 3).map(name).join(', ') || 'none'}), ${c.version_mismatches.length} version mismatch(es)${c.version_mismatches[0] ? ` (e.g. ${name(c.version_mismatches[0].package)}: SBOM ${name(c.version_mismatches[0].sbom_version)} vs ${name(c.version_mismatches[0].expected)}, ${name(c.version_mismatches[0].basis)})` : ''}. ${c.additional_sbom_components} additional SBOM components are normal (transitive, tooling) and are not counted as errors. Comparison confidence ${Math.round(c.confidence * 100)}%: ${c.confidence_reasons.join('; ')}.`,
        remediation:
          'Regenerate the SBOM from the same revision and lockfile, or document which components are intentionally excluded.',
      });
    }
    if (c.duplicate_components.length > 0 || c.invalid_versions.length > 0)
      out.push({
        id: id(),
        title: `SBOM ${name(c.sbom_path)} has duplicate or invalid component entries`,
        severity: 'low',
        confidence: 0.85,
        dimension: 'supply-chain',
        category: 'sbom',
        evidence_ids: [],
        rule_ids: [],
        ...base,
        summary: `${c.duplicate_components.length} duplicate identities, ${c.invalid_versions.length} components with a missing or malformed version, ${c.library_components_without_purl} library components without a purl.`,
        remediation:
          'Fix the SBOM generator configuration so every component has a unique purl and an exact version.',
      });
  }
  for (const d of intel.sboms.filter((x) => x.status === 'malformed' || x.status === 'unsupported'))
    out.push({
      id: id(),
      title: `SBOM ${name(d.path)} could not be ingested (${d.status})`,
      severity: d.status === 'malformed' ? 'low' : 'info',
      confidence: 0.95,
      dimension: 'supply-chain',
      category: 'sbom',
      evidence_ids: [],
      rule_ids: [],
      ...base,
      summary: `${name(d.detail ?? d.status)}. It was ignored; no SBOM-based statement is made about this repository.`,
      remediation: 'Publish a valid CycloneDX (1.2-1.7) or SPDX (2.2/2.3) JSON document.',
    });

  // Lookup that could not be done.
  const v = intel.vulnerability_lookup;
  if (v.performed && v.state === 'lookup_failed')
    out.push({
      id: id(),
      title: 'Vulnerability lookup failed',
      severity: 'info',
      confidence: 0.95,
      dimension: 'security',
      category: 'dependency',
      evidence_ids: [],
      rule_ids: ['security.known-vulnerabilities'],
      ...base,
      summary: `${name(v.detail ?? 'the OSV request failed')}. No dependency was treated as safe because of this; the vulnerability rule is unobserved.`,
      remediation: 'Re-run the analysis when the OSV service is reachable.',
    });
  return out;
}

/** Dependency facts consumed by informational rules. All state "what was observed", never "what is safe". */
export function deriveDependencyFacts(intel: DependencyIntel, sbomEnabled: boolean): Fact[] {
  const s = intel.summary;
  const facts: Fact[] = [];
  const f = (
    id: string,
    value: number | boolean | string,
    derivedFrom: string[],
    confidence = 0.9,
  ): void => {
    facts.push({
      id,
      value,
      confidence,
      scope: 'dependency',
      derived_from: derivedFrom,
      derived_by: 'dependency-intel@0.1',
    });
  };
  const files = intel.lockfiles.map((l) => l.path);
  f('deps.discovered', s.discovered, files);
  f(
    'deps.direct_count',
    s.direct,
    intel.dependencies
      .filter((d) => d.direct === true)
      .slice(0, 10)
      .map((d) => d.id),
  );
  if (s.direct_registry > 0) {
    f('deps.resolution.exact_ratio', round(s.direct_resolved_exact / s.direct_registry, 3), files);
    f(
      'deps.vulnerability.checked_ratio',
      round(s.direct_vulnerability_checked / s.direct_registry, 3),
      [],
    );
  }
  f('deps.unresolved_count', s.direct_unresolved + s.direct_ambiguous, []);
  f('deps.conflicts.count', intel.conflicts.length, []);
  if (sbomEnabled) {
    const parsed = intel.sboms.filter((d) => d.status === 'parsed');
    f(
      'deps.sbom.present',
      parsed.length > 0,
      parsed.map((d) => d.path),
      parsed.length > 0 ? 0.95 : 0.7,
    );
    const best = intel.sbom_comparisons[0];
    if (best) f('deps.sbom.comparison', best.state, [best.sbom_path], best.confidence);
  }
  return facts;
}
