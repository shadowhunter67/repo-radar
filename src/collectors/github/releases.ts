import type { HttpClient } from '../../util/http.js';
import {
  classifyAsset,
  buildReleaseIntel,
  type RawRelease,
  type TagInfo,
} from '../../release/analyze.js';
import { parseDigestString } from '../../release/checksums.js';
import type { Provenance, ReleaseIntel } from '../../release/model.js';
import { verifyAssets, type AssetVerifyLimits } from '../../release/verify-assets.js';
import { loadSigstoreVerifier, verifyBundle, type BundleVerifier } from '../../trust/sigstore.js';
import type { Release } from '../../release/model.js';
import { provenanceFromAttestationResponse } from '../../release/provenance.js';

/**
 * Release metadata collection. Everything is bounded: how many releases get detail, how many requests, how large a checksum
 * file may be. Asset BINARIES are never downloaded; only small checksum files (and attestation JSON from the API). A failed
 * lookup is recorded as a limit/diagnostic and never turned into "no signature" or "no provenance".
 */
export const RELEASE_LIMITS = {
  /** Releases that get tag resolution. */
  tagReleases: 3,
  /** Releases (newest first) that also get checksum files and attestations. */
  detailReleases: 1,
  checksumFilesPerRelease: 3,
  checksumMaxBytes: 256 * 1024,
  attestationsPerRelease: 3,
  maxRequests: 24,
} as const;

/** Download URLs must point into this repository's own release assets on GitHub; nothing else is ever fetched. */
export function isSafeAssetUrl(url: unknown, owner: string, repo: string): url is string {
  if (typeof url !== 'string' || url.length > 600) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.host !== 'github.com' || u.username || u.password || u.port)
    return false;
  const prefix = `/${owner}/${repo}/releases/download/`.toLowerCase();
  if (!u.pathname.toLowerCase().startsWith(prefix)) return false;
  return !u.pathname.split('/').some((p) => p === '..' || p === '.');
}

interface RawAssetWithUrl {
  name?: unknown;
  browser_download_url?: unknown;
  digest?: unknown;
}

export async function collectReleases(opts: {
  http: HttpClient;
  base: string;
  owner: string;
  repo: string;
  headers: Record<string, string>;
  releases: RawRelease[] | undefined;
  analyzedCommit: string | null;
  note: (code: string, message: string) => void;
  /** Cryptographically verify attestation bundles (opt-in; reaches the Sigstore TUF repository). */
  verifyCrypto?: boolean;
  /** Test seam / alternative trust material. Defaults to the Sigstore public-good verifier. */
  verifier?: BundleVerifier | undefined;
  /** Download a few small assets and compare their bytes with published digests (opt-in, bounded). */
  verifyAssets?: boolean;
  assetLimits?: Partial<AssetVerifyLimits>;
}): Promise<ReleaseIntel> {
  const { http, base, headers } = opts;
  if (!opts.releases)
    return {
      version: '1',
      status: 'unavailable',
      releases: [],
      releases_total: 0,
      requests: 0,
      limits_hit: ['release list unavailable'],
    };
  const limits: string[] = [];
  let requests = 0;
  const budgetOk = (): boolean => {
    if (requests >= RELEASE_LIMITS.maxRequests) {
      if (!limits.includes('release request budget reached'))
        limits.push('release request budget reached');
      return false;
    }
    requests++;
    return true;
  };
  const getJson = async (path: string): Promise<unknown | undefined> => {
    if (!budgetOk()) return undefined;
    try {
      const r = await http.request(`${base}${path}`, { headers, maxBytes: 1024 * 1024 });
      return r.status === 200 ? (JSON.parse(r.body) as unknown) : undefined;
    } catch (e) {
      opts.note(
        'release_lookup_failed',
        `${path.slice(0, 60)}: ${e instanceof Error ? e.message.slice(0, 100) : 'failed'}`,
      );
      return undefined;
    }
  };
  const published = opts.releases.filter((r) => r.draft !== true);
  const tags = new Map<string, TagInfo>();
  const checksumTexts = new Map<string, Map<string, string>>();
  const provenance = new Map<string, Provenance[]>();
  const attestationsListed = new Map<string, number>();
  const assetChecks = new Map<string, Release['asset_checks']>();
  let verifier: BundleVerifier | undefined = opts.verifier;
  let verifierLoaded = opts.verifier !== undefined;

  // Detail (checksums, attestations) goes to the newest STABLE release among those inspected; nightlies and pre-releases
  // would otherwise take the slot.
  const inspected = published.slice(0, RELEASE_LIMITS.tagReleases);
  const detailRelease = inspected.find((r) => r.prerelease !== true) ?? inspected[0];
  for (const rel of inspected) {
    const tag = typeof rel.tag_name === 'string' ? rel.tag_name.slice(0, 200) : '';
    if (!tag) continue;
    // 1) tag -> object
    const ref = (await getJson(`/git/ref/tags/${encodeURIComponent(tag)}`)) as
      { object?: { type?: string; sha?: string } } | undefined;
    const obj = ref?.object;
    if (!obj?.sha) {
      tags.set(tag, { kind: 'unresolved', commit: null });
    } else if (obj.type === 'commit') {
      tags.set(tag, { kind: 'lightweight', commit: obj.sha });
    } else if (obj.type === 'tag') {
      const t = (await getJson(`/git/tags/${obj.sha}`)) as
        | {
            object?: { type?: string; sha?: string };
            verification?: { verified?: unknown; reason?: unknown };
          }
        | undefined;
      tags.set(tag, {
        kind: 'annotated',
        commit: t?.object?.type === 'commit' ? (t.object.sha ?? null) : null,
        ...(t?.verification ? { verification: t.verification } : {}),
      });
    } else tags.set(tag, { kind: 'unresolved', commit: null });

    if (rel !== detailRelease) continue;
    const assets = (Array.isArray(rel.assets) ? rel.assets : []) as RawAssetWithUrl[];
    // 2) checksum files (small, same-repo release URLs only)
    const wanted = assets
      .filter((a) => typeof a.name === 'string' && classifyAsset(a.name) === 'checksum')
      .slice(0, RELEASE_LIMITS.checksumFilesPerRelease);
    for (const a of wanted) {
      if (!isSafeAssetUrl(a.browser_download_url, opts.owner, opts.repo)) {
        limits.push(
          `checksum asset ${String(a.name)
            .replace(/[^\x20-\x7e]/g, '?')
            .slice(0, 60)}: unsafe download URL, skipped`,
        );
        continue;
      }
      if (!budgetOk()) break;
      try {
        const r = await http.request(a.browser_download_url, {
          maxBytes: RELEASE_LIMITS.checksumMaxBytes,
        });
        if (r.status === 200) {
          const m = checksumTexts.get(tag) ?? new Map<string, string>();
          m.set(String(a.name), r.body);
          checksumTexts.set(tag, m);
        }
      } catch (e) {
        limits.push(
          `checksum file ${String(a.name)
            .replace(/[^\x20-\x7e]/g, '?')
            .slice(0, 60)} not read (${e instanceof Error ? e.message.slice(0, 60) : 'failed'})`,
        );
      }
    }
    // 3) GitHub artifact attestations for assets with a sha256 digest
    const withDigest = assets
      .map((a) => ({ a, d: parseDigestString(a.digest) }))
      .filter((x) => x.d?.algorithm === 'sha256')
      .slice(0, RELEASE_LIMITS.attestationsPerRelease);
    const recs: Provenance[] = [];
    const recBundles: unknown[] = [];
    let unreadable = 0;
    let listed = 0;
    let notInlined = 0;
    for (const { d } of withDigest) {
      const body = await getJson(`/attestations/sha256:${d?.value}`);
      if (body === undefined) continue;
      const p = provenanceFromAttestationResponse(body);
      recs.push(...p.records);
      recBundles.push(...p.bundles);
      unreadable += p.unreadable;
      listed += p.listed;
      notInlined += p.not_inlined;
    }
    if (listed > 0) attestationsListed.set(tag, listed);
    if (notInlined > 0)
      limits.push(
        `${notInlined} attestation bundle(s) not inlined by the API (large bundle URL on another host, not fetched)`,
      );
    if (unreadable > 0) limits.push(`${unreadable} attestation bundle(s) could not be parsed`);
    if (opts.verifyCrypto && recs.length > 0) {
      if (!verifierLoaded) {
        verifier = await loadSigstoreVerifier();
        verifierLoaded = true;
        if (!verifier) limits.push('sigstore verifier unavailable: attestations were not verified');
      }
      for (const [i, rec] of recs.entries()) {
        const v = await verifyBundle(verifier, recBundles[i]);
        rec.verification = v.state;
        rec.verification_detail = v;
      }
    }
    if (recs.length > 0) provenance.set(tag, recs);
    if (opts.verifyAssets) {
      const checks = await verifyAssets({
        http,
        assets: assets.map((a) => ({
          name: typeof a.name === 'string' ? a.name : '',
          size:
            typeof (a as { size?: unknown }).size === 'number'
              ? (a as { size: number }).size
              : null,
          url: typeof a.browser_download_url === 'string' ? a.browser_download_url : null,
          apiDigest: parseDigestString(a.digest) ?? null,
          kind: typeof a.name === 'string' ? classifyAsset(a.name) : 'other',
        })),
        checksumTexts: checksumTexts.get(tag) ?? new Map<string, string>(),
        ...(opts.assetLimits ? { limits: opts.assetLimits } : {}),
        isSafeUrl: (u) => isSafeAssetUrl(u, opts.owner, opts.repo),
        budgetOk,
      });
      if (checks.length > 0) assetChecks.set(tag, checks.slice(0, 10));
    }
  }
  if (published.length > RELEASE_LIMITS.tagReleases)
    limits.push(`tags resolved for ${RELEASE_LIMITS.tagReleases} of ${published.length} releases`);

  return buildReleaseIntel(
    {
      releases: opts.releases,
      tags,
      checksumTexts,
      provenance,
      attestationsListed,
      assetChecks,
      repository: `${opts.owner}/${opts.repo}`,
      requests,
      limits_hit: limits,
    },
    opts.analyzedCommit,
  );
}
