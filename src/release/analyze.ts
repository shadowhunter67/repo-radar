import {
  looksLikeChecksumFile,
  nameProblems,
  parseChecksumFile,
  parseDigestString,
  isWeak,
  type ChecksumFile,
} from './checksums.js';
import type {
  ArtifactDigest,
  Provenance,
  Release,
  ReleaseAsset,
  ReleaseIntel,
  Signature,
} from './model.js';

/** Raw inputs gathered from the GitHub API (all untrusted). The analysis itself performs no I/O. */
export interface RawAsset {
  name?: unknown;
  size?: unknown;
  content_type?: unknown;
  digest?: unknown;
  download_count?: unknown;
}
export interface RawRelease {
  tag_name?: unknown;
  name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  published_at?: unknown;
  author?: { login?: unknown } | null;
  assets?: RawAsset[];
}
export interface TagInfo {
  kind: 'lightweight' | 'annotated' | 'unresolved';
  commit: string | null;
  /** GitHub's own verification of an annotated tag signature (`verification` object), when present. */
  verification?: { verified?: unknown; reason?: unknown } | null;
}
export interface ReleaseInputs {
  releases: RawRelease[];
  tags: Map<string, TagInfo>;
  /** Parsed checksum files by release tag then asset name. */
  checksumTexts: Map<string, Map<string, string>>;
  /** Provenance records by release tag. */
  provenance: Map<string, Provenance[]>;
  attestationsListed: Map<string, number>;
  requests: number;
  limits_hit: string[];
}

const str = (v: unknown, n = 300): string | null =>
  typeof v === 'string' && v.length > 0 ? v.slice(0, n) : null;
const int = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;

const SIG_EXT: [RegExp, Signature['kind']][] = [
  [/\.(?:asc|gpg|sig)$/i, 'gpg'],
  [/\.(?:sigstore|sigstore\.json)$/i, 'sigstore'],
  [/\.(?:bundle)$/i, 'sigstore'],
  [/\.(?:pem|crt|cert)$/i, 'x509'],
  [/\.minisig$/i, 'minisign'],
  [/\.cosign\.sig$/i, 'cosign'],
];

export function classifyAsset(name: string): ReleaseAsset['kind'] {
  if (looksLikeChecksumFile(name)) return 'checksum';
  if (/\.(?:intoto\.jsonl|att|attestation)$/i.test(name) || /provenance/i.test(name))
    return 'attestation';
  if (SIG_EXT.some(([re]) => re.test(name))) return 'signature';
  if (/(?:^|[._-])(?:sbom|bom)(?:[._-]|$)|\.(?:cdx|spdx)(?:\.json)?$/i.test(name)) return 'sbom';
  if (/\.(?:whl|nupkg|gem|crate|vsix|rpm|deb|apk|msi|pkg|dmg|jar)$/i.test(name)) return 'package';
  if (/\.(?:zip|tar|tgz|tar\.gz|tar\.xz|tar\.bz2|txz|gz|xz|bz2|7z)$/i.test(name)) return 'archive';
  if (/\.(?:exe|dll|so|dylib|bin|appimage|app)$/i.test(name) || !/\.[a-z0-9]{1,6}$/i.test(name))
    return 'binary';
  return 'other';
}

/** Which asset a signature file refers to: `foo.tar.gz.asc` -> `foo.tar.gz`. */
function signedAsset(sigName: string, names: Set<string>): string | null {
  for (const [re] of SIG_EXT) {
    const base = sigName.replace(re, '');
    if (base !== sigName && names.has(base)) return base;
  }
  return null;
}

function sigKind(name: string): Signature['kind'] {
  return SIG_EXT.find(([re]) => re.test(name))?.[1] ?? 'unknown';
}

function releaseOf(
  raw: RawRelease,
  inputs: ReleaseInputs,
  analyzedCommit: string | null,
): Release | undefined {
  const tag = str(raw.tag_name, 200);
  if (!tag) return undefined;
  const rawAssets = (Array.isArray(raw.assets) ? raw.assets : []).slice(0, 200);
  const nameCount = new Map<string, number>();
  for (const a of rawAssets) {
    const n = str(a.name) ?? '';
    nameCount.set(n, (nameCount.get(n) ?? 0) + 1);
  }
  const checksumFiles: Release['checksum_files'] = [];
  const fromChecksum = new Map<string, ArtifactDigest>();
  const texts = inputs.checksumTexts.get(tag) ?? new Map<string, string>();
  const parsed = new Map<string, ChecksumFile>();
  for (const [asset, text] of texts)
    parsed.set(
      asset,
      parseChecksumFile(text, asset.replace(/.(?:sha(?:1|256|384|512)|md5)(?:sum)?$/i, '')),
    );
  const assets: ReleaseAsset[] = rawAssets.map((a) => {
    const name = (str(a.name) ?? '').replace(/[^\x20-\x7e]/g, '?');
    const original = str(a.name) ?? '';
    const apiDigest = parseDigestString(a.digest);
    const digest: ArtifactDigest | null = apiDigest
      ? {
          algorithm: apiDigest.algorithm,
          value: apiDigest.value,
          asset: name,
          source: 'github_api',
          evidence: 'digest reported by the GitHub API for the stored asset',
          weak: isWeak(apiDigest.algorithm),
        }
      : null;
    return {
      name,
      size: int(a.size),
      content_type: str(a.content_type, 100),
      kind: classifyAsset(original),
      digest,
      suspicious_name: nameProblems(original) || [...original].some((c) => c.charCodeAt(0) > 127),
      duplicate: (nameCount.get(original) ?? 0) > 1,
      downloads: int(a.download_count),
    };
  });
  const names = new Set(assets.map((a) => a.name));
  // checksum files: record what they list and which assets they cover
  for (const [asset, cf] of parsed) {
    let covers = 0;
    for (const e of cf.entries) {
      if (!names.has(e.name)) continue;
      covers++;
      const d: ArtifactDigest = {
        algorithm: e.algorithm,
        value: e.value,
        asset: e.name,
        source: 'checksum_file',
        evidence: `listed in ${asset}`,
        weak: isWeak(e.algorithm),
      };
      const prev = fromChecksum.get(e.name);
      if (!prev || (prev.weak && !d.weak)) fromChecksum.set(e.name, d);
    }
    checksumFiles.push({
      asset: asset.slice(0, 300),
      entries: cf.entries.length,
      malformed_lines: cf.malformed,
      weak_only: cf.entries.length > 0 && cf.entries.every((e) => isWeak(e.algorithm)),
      conflicts: cf.conflicts.length,
      covers_assets: covers,
    });
  }
  // Prefer the strongest digest; keep the GitHub one when the checksum file only has a weak digest.
  for (const a of assets) {
    const c = fromChecksum.get(a.name);
    if (c && (!a.digest || (a.digest.weak && !c.weak))) a.digest = c;
  }

  const signatures: Signature[] = [];
  const tagInfo = inputs.tags.get(tag);
  if (tagInfo?.kind === 'annotated') {
    const v = tagInfo.verification;
    if (v && typeof v === 'object') {
      const reason = str(v.reason, 60) ?? 'unknown';
      const state: Signature['state'] =
        v.verified === true
          ? 'signature_verified'
          : reason === 'unsigned'
            ? 'signature_present' // placeholder replaced below
            : [
                  'invalid',
                  'malformed_signature',
                  'bad_email',
                  'expired_key',
                  'not_signing_key',
                  'unverified_email',
                ].includes(reason)
              ? 'signature_invalid'
              : 'verification_unavailable';
      if (reason !== 'unsigned')
        signatures.push({ subject: 'tag', kind: 'gpg', state, verified_by: 'github', reason });
    }
  }
  for (const a of assets) {
    if (a.kind !== 'signature') continue;
    const target = signedAsset(a.name, names);
    signatures.push({
      subject: target ?? a.name,
      kind: sigKind(a.name),
      // The signature file exists; repo-radar does not verify it.
      state: 'signature_present',
      verified_by: 'none',
      reason: target
        ? 'signature asset next to its target'
        : 'signature asset without a matching target',
    });
  }

  const provenance = inputs.provenance.get(tag) ?? [];
  const tagCommit =
    tagInfo?.commit && /^[0-9a-f]{40}$/.test(tagInfo.commit) ? tagInfo.commit : null;
  const reasons: string[] = [];
  let correspondence: Release['correspondence'] = 'unlinked';
  const digests = new Set(
    assets
      .filter((a) => a.digest && !a.digest.weak)
      .map((a) => `${a.digest?.algorithm}:${a.digest?.value}`),
  );
  const matching = provenance.filter((p) =>
    p.subject.some((s) => digests.has(`${s.algorithm}:${s.digest}`)),
  );
  if (matching.length > 0) {
    const withRev = matching.filter((p) => p.source_revision);
    if (tagCommit && withRev.some((p) => p.source_revision === tagCommit)) {
      correspondence = 'attested_to_tag_commit';
      reasons.push(
        'an attestation for an asset digest names the tag commit as its source revision',
      );
      reasons.push('the attestation signature was not verified by repo-radar');
    } else if (tagCommit && withRev.length > 0) {
      correspondence = 'attestation_inconsistent';
      reasons.push(
        'an attestation exists for an asset but its source revision differs from the tag commit',
      );
    } else {
      correspondence = tagCommit ? 'tag_only' : 'unlinked';
      reasons.push('an attestation exists but does not name a source revision');
    }
    if ((inputs.attestationsListed.get(tag) ?? 0) > provenance.length)
      reasons.push('more attestations are listed than could be read here');
  } else if (fromChecksum.size > 0) {
    correspondence = 'checksum_listed';
    reasons.push(
      'assets are listed in a published checksum file; this proves integrity of the download, not origin',
    );
  } else if (tagCommit) {
    correspondence = 'tag_only';
    reasons.push('only the release tag and its commit are known');
  } else reasons.push('the tag could not be resolved to a commit');
  if (tagCommit && analyzedCommit && tagCommit !== analyzedCommit)
    reasons.push('the tag commit is not the analyzed commit');
  if (tagCommit && analyzedCommit && tagCommit === analyzedCommit)
    reasons.push('the tag commit is the analyzed commit');

  return {
    tag,
    name: str(raw.name, 200),
    published_at: str(raw.published_at, 40),
    prerelease: raw.prerelease === true,
    published_by: str(raw.author?.login, 100),
    tag_commit: tagCommit,
    tag_kind: tagInfo?.kind ?? 'unresolved',
    assets,
    assets_total: Array.isArray(raw.assets) ? raw.assets.length : 0,
    signatures,
    provenance,
    attestations_listed: inputs.attestationsListed.get(tag) ?? provenance.length,
    correspondence,
    correspondence_reasons: reasons,
    checksum_files: checksumFiles,
  };
}

export function buildReleaseIntel(
  inputs: ReleaseInputs,
  analyzedCommit: string | null,
): ReleaseIntel {
  const published = inputs.releases.filter((r) => r.draft !== true);
  const releases = published.slice(0, 10).flatMap((r) => {
    const x = releaseOf(r, inputs, analyzedCommit);
    return x ? [x] : [];
  });
  return {
    version: '1',
    status: published.length === 0 ? 'no_releases' : 'analyzed',
    releases,
    releases_total: published.length,
    requests: inputs.requests,
    limits_hit: inputs.limits_hit.slice(0, 10),
  };
}
