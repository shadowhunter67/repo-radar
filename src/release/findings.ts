import type { Finding } from '../analysis/findings.js';
import type { Fact } from '../facts/index.js';
import type { Governance } from '../governance/temporal.js';
import type { ReleaseIntel } from './model.js';

/**
 * Findings and facts derived from release and governance metadata. Every statement says what was observed; "not observed"
 * facts are emitted only when the corresponding lookup actually worked, so a failed lookup never reads as "no signature".
 * Remediation is separate advisory text and never part of the evidence.
 */
export function buildReleaseFindings(intel: ReleaseIntel): Finding[] {
  const out: Finding[] = [];
  if (intel.status !== 'analyzed') return out;
  let n = 0;
  const id = (): string => `RR-REL-${String(++n).padStart(3, '0')}`;
  const latest = intel.releases.find((r) => !r.prerelease) ?? intel.releases[0];
  if (!latest) return out;
  const trace = (): string[] => [
    `release:${latest.tag.replace(/[^\x20-\x7e]/g, '?').slice(0, 60)}`,
  ];
  if (latest.correspondence === 'attestation_inconsistent')
    out.push({
      id: id(),
      title: 'Release attestation names a different source revision than the release tag',
      severity: 'medium',
      confidence: 0.8,
      dimension: 'supply-chain',
      category: 'release',
      evidence_ids: trace(),
      rule_ids: [],
      standards: ['slsa:provenance'],
      summary: `An attestation for an asset of ${latest.tag.replace(/[^\x20-\x7e]/g, '?')} names a source revision that is not the commit the tag points to. The attestation signature was not verified by repo-radar. This describes a mismatch in the metadata; the cause is undetermined.`,
      remediation:
        "Compare the attestation subject and source revision with the tag commit, and verify the attestation with the issuer's tooling before using the asset.",
      intent: 'undetermined',
    });
  const sigs = latest.signatures.filter((s) => s.subject === 'tag');
  const badSig = sigs.find((s) => s.state === 'invalid');
  if (badSig)
    out.push({
      id: id(),
      title: 'GitHub reports an invalid signature on the release tag',
      severity: 'medium',
      confidence: 0.85,
      dimension: 'supply-chain',
      category: 'release',
      evidence_ids: trace(),
      rule_ids: [],
      standards: [],
      summary: `GitHub's verification of the annotated tag ${latest.tag.replace(/[^\x20-\x7e]/g, '?')} failed (reason: ${badSig.reason.replace(/[^\x20-\x7e]/g, '?')}).`,
      remediation:
        'Do not rely on the tag signature; confirm the release with the maintainers through an independent channel.',
      intent: 'undetermined',
    });
  const weak = latest.checksum_files.filter((c) => c.weak_only);
  if (weak.length > 0)
    out.push({
      id: id(),
      title: 'Release checksums use only MD5 or SHA-1',
      severity: 'low',
      confidence: 0.9,
      dimension: 'supply-chain',
      category: 'release',
      evidence_ids: trace(),
      rule_ids: [],
      standards: [],
      summary:
        'Published checksum file(s) list only collision-prone algorithms; they are recorded but not counted as integrity evidence.',
      remediation: 'Publish SHA-256 (or stronger) checksums for each release asset.',
      intent: 'undetermined',
    });
  const odd = latest.assets.filter((a) => a.suspicious_name || a.duplicate);
  if (odd.length > 0)
    out.push({
      id: id(),
      title: 'Release assets with unusual or duplicate names',
      severity: 'low',
      confidence: 0.8,
      dimension: 'supply-chain',
      category: 'release',
      evidence_ids: trace(),
      rule_ids: [],
      standards: [],
      summary: `${odd.length} asset name(s) of the latest release contain non-ASCII or control characters, path separators or are duplicated (shown with escapes). Look-alike names can be used to pass off a different file.`,
      remediation:
        'Check each asset name character by character and prefer assets whose digest matches a published checksum.',
      intent: 'undetermined',
    });
  if (latest.correspondence === 'source_binding_conflict')
    out.push({
      id: id(),
      title: 'Verified attestation contradicts the release tag or repository',
      severity: 'medium',
      confidence: 0.85,
      dimension: 'supply-chain',
      category: 'release',
      evidence_ids: trace(),
      rule_ids: [],
      standards: ['slsa:provenance'],
      summary:
        'A cryptographically verified attestation for an asset names a signer repository or a source revision that is not the release tag commit of this repository. The signature is genuine; what it says does not match the tag. The cause is undetermined.',
      remediation:
        'Do not rely on this release until the attested source revision and the signer repository are explained by the project.',
      intent: 'undetermined',
    });
  const rejected = latest.provenance.filter((p) => p.verification === 'invalid');
  if (rejected.length > 0)
    out.push({
      id: id(),
      title: 'An attestation was rejected by the verifier',
      severity: 'medium',
      confidence: 0.85,
      dimension: 'supply-chain',
      category: 'release',
      evidence_ids: trace(),
      rule_ids: [],
      standards: ['slsa:provenance'],
      summary: `${rejected.length} attestation(s) for the latest release failed verification against ${rejected[0]?.verification_detail?.trust_root ?? 'the trust root'} (${(rejected[0]?.verification_detail?.detail ?? '').replace(/[^ -~]/g, '?').slice(0, 100)}).`,
      remediation:
        'Treat the attestation as untrustworthy and obtain the artifact from a source whose attestation verifies.',
      intent: 'undetermined',
    });
  const mismatched = latest.asset_checks.filter((c) => c.state === 'checksum_mismatch');
  if (mismatched.length > 0)
    out.push({
      id: id(),
      title: 'Downloaded asset does not match its published digest',
      severity: 'high',
      confidence: 0.9,
      dimension: 'supply-chain',
      category: 'release',
      evidence_ids: trace(),
      rule_ids: [],
      standards: [],
      summary: `${mismatched.length} downloaded asset(s) (first: ${mismatched[0]?.asset.replace(/[^ -~]/g, '?').slice(0, 60)}) hashed to a different value than the published digest. This can be a corrupted download, a replaced asset or a stale checksum file; the cause is undetermined.`,
      remediation:
        'Do not use the asset; re-download it and compare with the published digest through an independent channel.',
      intent: 'undetermined',
    });
  const conflicts = latest.checksum_files.filter((c) => c.conflicts > 0);
  if (conflicts.length > 0)
    out.push({
      id: id(),
      title: 'A checksum file lists the same asset with different digests',
      severity: 'medium',
      confidence: 0.85,
      dimension: 'supply-chain',
      category: 'release',
      evidence_ids: trace(),
      rule_ids: [],
      standards: [],
      summary:
        'A published checksum file contradicts itself for at least one asset; none of its digests for that asset were used.',
      remediation:
        'Obtain the digest from an independent source (for example the GitHub asset digest) before trusting the file.',
      intent: 'undetermined',
    });
  return out;
}

export function buildGovernanceFindings(g: Governance): Finding[] {
  if (g.status !== 'analyzed' || !g.takeover_indicators?.observed) return [];
  return [
    {
      id: 'RR-GOV-001',
      title: 'Supply-chain takeover risk indicators in recent history',
      severity: 'medium',
      confidence: 0.4,
      dimension: 'supply-chain',
      category: 'governance',
      evidence_ids: g.takeover_indicators.signal_ids,
      rule_ids: [],
      standards: [],
      summary: g.takeover_indicators.statement,
      remediation:
        'Review who published the latest releases and compare the changes since the dormancy with the previous releases before upgrading; confirm any hand-over with the project through an independent channel.',
      intent: 'undetermined',
    },
  ];
}

export function deriveReleaseFacts(intel: ReleaseIntel, g: Governance): Fact[] {
  const facts: Fact[] = [];
  const f = (
    id: string,
    value: number | boolean | string,
    derivedFrom: string[],
    scope: 'release' | 'governance',
    confidence = 0.9,
  ): void => {
    facts.push({
      id,
      value,
      confidence,
      scope,
      derived_from: derivedFrom,
      derived_by: 'release-intel@0.1',
    });
  };
  const latest = intel.releases.find((r) => !r.prerelease) ?? intel.releases[0];
  if (intel.status === 'analyzed' && latest) {
    const from = [`release:${latest.tag.replace(/[^\x20-\x7e]/g, '?').slice(0, 60)}`];
    f('release.count', intel.releases_total, from, 'release');
    f('release.assets.count', latest.assets_total, from, 'release');
    // signature facts need the tag lookup to have worked; otherwise they stay unobserved
    if (latest.tag_kind !== 'unresolved') {
      const tagSig = latest.signatures.find((s) => s.subject === 'tag');
      f(
        'release.tag.signature_verified',
        tagSig?.state === 'verified',
        from,
        'release',
        tagSig ? 0.9 : 0.7,
      );
      f(
        'release.signature_assets.present',
        latest.signatures.some((s) => s.verified_by !== 'github'),
        from,
        'release',
      );
    }
    f(
      'release.checksums.published',
      latest.checksum_files.some((c) => c.covers_assets > 0 && !c.weak_only),
      from,
      'release',
      0.85,
    );
    f(
      'release.provenance.present',
      latest.provenance.length > 0 || latest.attestations_listed > 0,
      from,
      'release',
      0.8,
    );
    f(
      'release.provenance.consistent_with_tag',
      latest.correspondence === 'attested_to_tag_commit',
      from,
      'release',
      0.8,
    );
    f('release.correspondence', latest.correspondence, from, 'release', 0.8);
    if (intel.verification_run.attestations) {
      f('release.provenance.verified', latest.slsa.provenance_verified, from, 'release', 0.9);
      f(
        'release.source_binding_verified',
        latest.correspondence === 'verified_source_binding',
        from,
        'release',
        0.9,
      );
    }
    if (intel.verification_run.signatures === true) {
      // Local cryptographic checks against keys the USER configured. Not run = unknown, so no fact is emitted otherwise.
      const sigs = latest.signatures;
      f(
        'release.signatures.locally_verified',
        sigs.some((s) => s.local_state === 'verified'),
        from,
        'release',
        0.9,
      );
      f(
        'release.signatures.invalid',
        sigs.some(
          (s) =>
            s.local_state === 'invalid' || (s.verified_by !== 'github' && s.state === 'invalid'),
        ),
        from,
        'release',
        0.9,
      );
      const tagSig = sigs.find((s) => s.subject === 'tag');
      if (tagSig && (intel.verification_run.trusted_keys ?? 0) > 0)
        f(
          'release.tag.signature_locally_verified',
          tagSig.local_state === 'verified',
          from,
          'release',
          0.9,
        );
    }
    if (intel.verification_run.assets && latest.asset_checks.length > 0)
      f(
        'release.assets.checksum_verified',
        latest.asset_checks.some((c) => c.state === 'checksum_verified') &&
          !latest.asset_checks.some((c) => c.state === 'checksum_mismatch'),
        from,
        'release',
        0.9,
      );
  }
  if (g.status === 'analyzed') {
    f(
      'governance.takeover_indicators',
      g.takeover_indicators?.observed === true,
      g.takeover_indicators?.signal_ids ?? [],
      'governance',
      0.4,
    );
    f(
      'governance.signals.count',
      g.signals.length,
      g.signals.map((s) => s.id),
      'governance',
      0.6,
    );
  }
  return facts;
}
