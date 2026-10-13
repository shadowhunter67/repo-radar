import type { HttpClient } from '../../util/http.js';
import { TooLargeError } from '../../util/http.js';
import {
  classifyAsset,
  buildReleaseIntel,
  type RawRelease,
  type TagInfo,
} from '../../release/analyze.js';
import { parseDigestString } from '../../release/checksums.js';
import type { Provenance, ReleaseIntel } from '../../release/model.js';
import { verifyAssets, type AssetVerifyLimits } from '../../release/verify-assets.js';
import { sigKind, signedAsset } from '../../release/analyze.js';
import { repositoryKeyFiles, verifySignatureAssets } from '../../release/verify-signatures.js';
import { EMPTY_TRUST, type TrustConfig } from '../../trust/config.js';
import { verifyGpgDetached } from '../../trust/gpg.js';
import type { Verification } from '../../trust/model.js';
import { loadSigstoreVerifier, verifyBundle, type BundleVerifier } from '../../trust/sigstore.js';
import { snappyDecompress } from '../../util/snappy.js';
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

/**
 * GitHub's attestation API returns small bundles inline and large ones as a short-lived signed `bundle_url` in its own
 * attestation blob store (Snappy-compressed JSON). That store is the ONLY other host fetched for this, from a dedicated client
 * without credentials; the URL is validated, size-capped both compressed and decompressed, and never recorded anywhere (its
 * query string is a signature).
 */
export const ATTESTATION_BLOB_HOSTS = ['tmaproduction.blob.core.windows.net'];
export const LARGE_BUNDLE_LIMITS = {
  maxFetches: 5,
  maxCompressedBytes: 512 * 1024,
  maxDecompressedBytes: 1024 * 1024,
} as const;

export function isSafeBundleUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 1500) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return (
    u.protocol === 'https:' &&
    ATTESTATION_BLOB_HOSTS.includes(u.hostname) &&
    !u.username &&
    !u.password &&
    !u.port &&
    u.pathname.startsWith('/attestations/') &&
    !u.pathname.split('/').some((p) => p === '..' || p === '.')
  );
}

/** A listed attestation whose bundle could not be read because of a resource limit: kept as an explicit record, never dropped. */
function skippedBundleRecord(reason: string): Provenance {
  const detail: Verification = {
    state: 'verification_skipped_resource_limit',
    trust_root: 'none',
    verified_by: 'none',
    engine: 'none',
    subject: null,
    detail: reason.slice(0, 240),
    identity: null,
  };
  return {
    subject: [],
    predicate_type: 'unknown (bundle not downloaded)',
    slsa: false,
    builder_id: null,
    build_type: null,
    source_repository: null,
    source_revision: null,
    invocation: null,
    verification: 'verification_skipped_resource_limit',
    verification_detail: detail,
    origin: 'github_attestation_api',
    problems: [reason.slice(0, 200)],
  };
}

/**
 * Replace `bundle_url` entries of an attestation response with the downloaded, decompressed bundle (mutating `body`).
 * Returns the stub records for bundles that were not downloaded because of a limit, and how many were fetched.
 */
async function inlineLargeBundles(
  body: unknown,
  blob: HttpClient | undefined,
  budgetOk: () => boolean,
  fetchedSoFar: { n: number },
): Promise<{ skipped: Provenance[]; fetched: number; failed: number }> {
  const out = { skipped: [] as Provenance[], fetched: 0, failed: 0 };
  const list = (body as { attestations?: unknown } | null)?.attestations;
  if (!blob || !Array.isArray(list)) return out;
  for (const a of list.slice(0, 10) as Record<string, unknown>[]) {
    if (a['bundle'] != null || typeof a['bundle_url'] !== 'string') continue;
    const url = a['bundle_url'];
    if (!isSafeBundleUrl(url)) continue; // left as "not inlined": a URL on another host is never fetched
    if (fetchedSoFar.n >= LARGE_BUNDLE_LIMITS.maxFetches) {
      out.skipped.push(
        skippedBundleRecord(
          `more than ${LARGE_BUNDLE_LIMITS.maxFetches} large bundles; this one was not downloaded`,
        ),
      );
      continue;
    }
    if (!budgetOk()) continue;
    fetchedSoFar.n++;
    try {
      const r = await blob.request(url, {
        maxBytes: LARGE_BUNDLE_LIMITS.maxCompressedBytes,
        binary: true,
      });
      if (r.status !== 200) {
        out.failed++;
        continue;
      }
      const raw = Buffer.from(r.body, 'latin1');
      const text = (
        raw[0] === 0x7b // already JSON
          ? raw
          : snappyDecompress(raw, LARGE_BUNDLE_LIMITS.maxDecompressedBytes)
      )?.toString('utf8');
      if (text === undefined) {
        out.skipped.push(
          skippedBundleRecord('the bundle is larger than the decompression limit or malformed'),
        );
        continue;
      }
      a['bundle'] = JSON.parse(text) as unknown;
      out.fetched++;
    } catch (e) {
      // never print the error text: it can contain the signed URL
      if (e instanceof TooLargeError)
        out.skipped.push(
          skippedBundleRecord(
            `the bundle is larger than ${LARGE_BUNDLE_LIMITS.maxCompressedBytes} bytes`,
          ),
        );
      else out.failed++;
    }
  }
  return out;
}

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

/**
 * Local check of an annotated tag signature against the USER's trusted GPG keys. GitHub's `verification` object carries the
 * armored signature and the exact signed payload, so the check needs no clone and no host keyring. Without a trusted key,
 * or for a signature format this version cannot check (SSH, S/MIME), the local state is `verification_unavailable`, and
 * GitHub's assertion stays what it is: GitHub's word.
 */
async function localTagVerification(
  t: { verification?: { signature?: unknown; payload?: unknown } } | undefined,
  tag: string,
  trust: TrustConfig,
): Promise<{ local?: Verification }> {
  const v = t?.verification;
  const sig = typeof v?.signature === 'string' ? v.signature : '';
  const payload = typeof v?.payload === 'string' ? v.payload : '';
  if (!sig || !payload) return {};
  const subject = `tag ${tag}`.slice(0, 300);
  const unavailable = (detail: string): { local: Verification } => ({
    local: {
      state: 'verification_unavailable',
      trust_root: 'none',
      verified_by: 'none',
      engine: 'none',
      subject,
      detail,
      identity: null,
    },
  });
  if (!/^-----BEGIN PGP SIGNATURE-----/.test(sig.trimStart()))
    return unavailable(
      'the tag signature is not an OpenPGP signature; other formats are not verified',
    );
  if (!trust.keys.some((k) => k.kind === 'gpg'))
    return unavailable('a signed tag is present but no trusted GPG key was supplied');
  return {
    local: await verifyGpgDetached({
      signature: sig,
      data: Buffer.from(payload, 'utf8'),
      keys: trust.keys,
      subject,
    }),
  };
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
  /** Keys and identity the USER trusts (never read from the repository). Enables OpenPGP / minisign checks. */
  trust?: TrustConfig;
  /** Repository tree paths, to report committed public keys as evidence (`key_present_in_repository`). */
  treePaths?: string[];
  /** Credential-free client for GitHub's attestation blob store (large Sigstore bundles). Absent: they are counted, not fetched. */
  blobHttp?: HttpClient;
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
      verification_run: { attestations: false, assets: false },
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
  const trust = opts.trust ?? EMPTY_TRUST;
  const signatureChecks = new Map<string, Map<string, Verification>>();
  const downloaded = new Map<string, Buffer>();
  let signaturesRan = false;
  const sigstoreVerifier = async (): Promise<BundleVerifier | undefined> => {
    if (!verifierLoaded) {
      verifier = await loadSigstoreVerifier();
      verifierLoaded = true;
      if (!verifier) limits.push('sigstore verifier unavailable: attestations were not verified');
    }
    return verifier;
  };

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
            verification?: {
              verified?: unknown;
              reason?: unknown;
              signature?: unknown;
              payload?: unknown;
            };
          }
        | undefined;
      tags.set(tag, {
        kind: 'annotated',
        commit: t?.object?.type === 'commit' ? (t.object.sha ?? null) : null,
        ...(t?.verification ? { verification: t.verification } : {}),
        ...(await localTagVerification(t, tag, trust)),
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
    const largeFetches = { n: 0 };
    let largeFetched = 0;
    let largeFailed = 0;
    for (const { d } of withDigest) {
      const body = await getJson(`/attestations/sha256:${d?.value}`);
      if (body === undefined) continue;
      const big = await inlineLargeBundles(body, opts.blobHttp, budgetOk, largeFetches);
      largeFetched += big.fetched;
      largeFailed += big.failed;
      const p = provenanceFromAttestationResponse(body);
      recs.push(...p.records);
      recBundles.push(...p.bundles);
      for (const sk of big.skipped) {
        recs.push(sk);
        recBundles.push(null);
      }
      unreadable += p.unreadable;
      listed += p.listed;
      notInlined += p.not_inlined;
    }
    if (listed > 0) attestationsListed.set(tag, listed);
    if (largeFetched > 0)
      limits.push(
        `${largeFetched} large attestation bundle(s) were downloaded from GitHub's attestation store (Snappy, bounded)`,
      );
    if (largeFailed > 0)
      limits.push(`${largeFailed} large attestation bundle(s) could not be downloaded`);
    if (notInlined > 0)
      limits.push(
        `${notInlined} attestation bundle(s) not inlined by the API (large bundle URL on another host, not fetched)`,
      );
    if (unreadable > 0) limits.push(`${unreadable} attestation bundle(s) could not be parsed`);
    if (opts.verifyCrypto && recs.length > 0) {
      await sigstoreVerifier();
      for (const [i, rec] of recs.entries()) {
        if (rec.verification === 'verification_skipped_resource_limit') continue; // nothing to verify: it was not downloaded
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
        onBytes: (name, bytes) => downloaded.set(name, bytes),
      });
      if (checks.length > 0) assetChecks.set(tag, checks.slice(0, 10));
    }
    // 4) detached signatures (Sigstore blob bundles, OpenPGP, minisign) against the user's trust roots
    {
      const hasGpg = trust.keys.some((k) => k.kind === 'gpg');
      const hasMini = trust.keys.some((k) => k.kind === 'minisign');
      const byName = new Map(assets.map((a) => [typeof a.name === 'string' ? a.name : '', a]));
      const names = new Set(byName.keys());
      const wantedSigs = assets.flatMap((a) => {
        const name = typeof a.name === 'string' ? a.name : '';
        if (!name || classifyAsset(name) !== 'signature') return [];
        const kind = sigKind(name);
        const usable =
          (kind === 'sigstore' && opts.verifyCrypto === true) ||
          (kind === 'gpg' && hasGpg) ||
          (kind === 'minisign' && hasMini);
        if (!usable) return [];
        const targetName = signedAsset(name, names);
        const target = targetName ? byName.get(targetName) : undefined;
        return [
          {
            name,
            url: typeof a.browser_download_url === 'string' ? a.browser_download_url : null,
            kind,
            target: target
              ? {
                  name: targetName as string,
                  size:
                    typeof (target as { size?: unknown }).size === 'number'
                      ? (target as { size: number }).size
                      : null,
                  url:
                    typeof target.browser_download_url === 'string'
                      ? target.browser_download_url
                      : null,
                }
              : null,
          },
        ];
      });
      if (wantedSigs.length > 0) {
        signaturesRan = true;
        const checks = await verifySignatureAssets({
          http,
          signatures: wantedSigs,
          trust,
          sigstore: sigstoreVerifier,
          isSafeUrl: (u) => isSafeAssetUrl(u, opts.owner, opts.repo),
          budgetOk,
          known: downloaded,
          alreadyDownloaded: [...downloaded.values()].reduce((n, b) => n + b.length, 0),
        });
        signatureChecks.set(tag, checks);
      }
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
      verificationRun: {
        attestations: opts.verifyCrypto === true,
        assets: opts.verifyAssets === true,
        signatures: signaturesRan || trust.keys.length > 0,
        trusted_keys: trust.keys.length,
      },
      signatureChecks,
      repositoryKeys: repositoryKeyFiles(opts.treePaths ?? []),
      requests,
      limits_hit: limits,
    },
    opts.analyzedCommit,
  );
}
