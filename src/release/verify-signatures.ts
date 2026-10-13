import type { HttpClient } from '../util/http.js';
import type { TrustConfig } from '../trust/config.js';
import { verifyGpgDetached } from '../trust/gpg.js';
import { verifyMinisign } from '../trust/minisign.js';
import type { Verification } from '../trust/model.js';
import { verifyBundle, type BundleVerifier } from '../trust/sigstore.js';
import type { Signature } from './model.js';

/**
 * Verification of DETACHED signature assets (`foo.tar.gz` + `foo.tar.gz.sigstore.json` / `.asc` / `.minisig`). Sigstore blob
 * bundles, OpenPGP and minisign are checked against trust the USER configured; nothing here trusts a key or identity found in
 * the repository.
 *
 * Bounded like everything that downloads: the signature file is small, the signed artifact is capped per asset and in total
 * (shared with the asset-digest check, whose bytes are reused when it already fetched the same asset), and a cap that stops
 * a check is reported as `verification_skipped_resource_limit`, never as verified.
 */
export interface SignatureVerifyLimits {
  maxSignatures: number;
  maxSignatureFileBytes: number;
  maxArtifactBytes: number;
  maxTotalBytes: number;
}
export const SIGNATURE_VERIFY_LIMITS: SignatureVerifyLimits = {
  maxSignatures: 6,
  maxSignatureFileBytes: 256 * 1024,
  maxArtifactBytes: 8 * 1024 * 1024,
  maxTotalBytes: 24 * 1024 * 1024,
};

export interface SignatureAsset {
  /** Name of the signature file. */
  name: string;
  url: string | null;
  kind: Signature['kind'];
  /** The asset it signs, when one sits next to it. */
  target: { name: string; size: number | null; url: string | null } | null;
}

const safe = (s: string, n = 160): string => s.replace(/[^\x20-\x7e]/g, '?').slice(0, n);

export async function verifySignatureAssets(opts: {
  http: HttpClient;
  signatures: SignatureAsset[];
  trust: TrustConfig;
  /** Lazily loaded Sigstore verifier (only when a Sigstore bundle is met). */
  sigstore: () => Promise<BundleVerifier | undefined>;
  isSafeUrl: (u: unknown) => boolean;
  budgetOk: () => boolean;
  /** Bytes of assets already downloaded in this run, by name. Reused, not fetched again. */
  known: Map<string, Buffer>;
  /** Bytes downloaded so far in this run (asset-digest check included); the total cap counts them. */
  alreadyDownloaded?: number;
  limits?: Partial<SignatureVerifyLimits>;
}): Promise<Map<string, Verification>> {
  const lim = { ...SIGNATURE_VERIFY_LIMITS, ...opts.limits };
  const out = new Map<string, Verification>();
  let total = opts.alreadyDownloaded ?? 0;
  const note = (
    name: string,
    state: Verification['state'],
    detail: string,
    engine: Verification['engine'] = 'none',
  ): void => {
    out.set(name, {
      state,
      trust_root: 'none',
      verified_by: 'none',
      engine,
      subject: safe(name, 300),
      detail: detail.slice(0, 240),
      identity: null,
    });
  };
  const fetchBytes = async (url: string, max: number): Promise<Buffer | 'failed'> => {
    if (!opts.budgetOk()) return 'failed';
    try {
      const r = await opts.http.request(url, { maxBytes: max, binary: true });
      return r.status === 200 ? Buffer.from(r.body, 'latin1') : 'failed';
    } catch {
      return 'failed';
    }
  };
  let done = 0;
  for (const s of opts.signatures) {
    if (done >= lim.maxSignatures) {
      note(s.name, 'verification_skipped_resource_limit', 'signature count limit reached');
      continue;
    }
    if (s.kind === 'x509' || s.kind === 'cosign' || s.kind === 'ssh' || s.kind === 'unknown') {
      note(
        s.name,
        'verification_unavailable',
        `${s.kind} signature files are not verified by this version`,
      );
      continue;
    }
    if (!s.target) {
      note(s.name, 'verification_unavailable', 'no matching asset to verify the signature against');
      continue;
    }
    if (!opts.isSafeUrl(s.url) || !opts.isSafeUrl(s.target.url)) {
      note(
        s.name,
        'verification_unavailable',
        'download URL is not a release asset of this repository',
      );
      continue;
    }
    const size = s.target.size;
    if (!opts.known.has(s.target.name) && (size === null || size > lim.maxArtifactBytes)) {
      note(
        s.name,
        'verification_skipped_resource_limit',
        `the signed asset ${size === null ? 'has an unknown size' : `is ${size} bytes`} (limit ${lim.maxArtifactBytes}); not downloaded`,
      );
      continue;
    }
    if (!opts.known.has(s.target.name) && total + (size ?? 0) > lim.maxTotalBytes) {
      note(s.name, 'verification_skipped_resource_limit', 'total download limit reached');
      continue;
    }
    done++;
    const sigBytes = await fetchBytes(s.url as string, lim.maxSignatureFileBytes);
    if (sigBytes === 'failed') {
      note(s.name, 'verification_failed', 'the signature file could not be downloaded');
      continue;
    }
    let data = opts.known.get(s.target.name);
    if (!data) {
      const got = await fetchBytes(s.target.url as string, lim.maxArtifactBytes);
      if (got === 'failed') {
        note(s.name, 'verification_failed', 'the signed asset could not be downloaded');
        continue;
      }
      data = got;
      total += got.length;
      opts.known.set(s.target.name, got);
    }
    const subject = s.target.name;
    let v: Verification;
    if (s.kind === 'sigstore') {
      let bundle: unknown;
      try {
        bundle = JSON.parse(sigBytes.toString('utf8'));
      } catch {
        note(s.name, 'verification_failed', 'the Sigstore bundle is not valid JSON', 'sigstore');
        continue;
      }
      v = await verifyBundle(await opts.sigstore(), bundle, {
        data,
        subject,
        ...(opts.trust.expectedIdentity ? { expectedIdentity: opts.trust.expectedIdentity } : {}),
      });
    } else if (s.kind === 'minisign') {
      v = verifyMinisign({
        signatureText: sigBytes.toString('utf8'),
        data,
        keys: opts.trust.keys,
        subject,
      });
    } else {
      v = await verifyGpgDetached({ signature: sigBytes, data, keys: opts.trust.keys, subject });
    }
    out.set(s.name, v);
  }
  return out;
}

/** Public keys committed in a repository. Evidence only; see `key_present_in_repository`. */
export function repositoryKeyFiles(paths: string[]): {
  path: string;
  kind: 'gpg' | 'minisign' | 'unknown';
  state: 'key_present_in_repository';
  trusted: false;
}[] {
  const out: ReturnType<typeof repositoryKeyFiles> = [];
  for (const p of paths) {
    const base = (p.split('/').pop() ?? '').toLowerCase();
    let kind: 'gpg' | 'minisign' | 'unknown' | undefined;
    if (
      /^(?:keys|authors?\.asc|.*\.asc|.*pubkey.*|.*public[-_.]?key.*|.*release[-_.]?key.*)$/.test(
        base,
      ) &&
      !/\.(?:md|txt|json)$/.test(base)
    )
      kind = /\.asc$|^keys$/.test(base) ? 'gpg' : 'unknown';
    if (/minisign.*\.pub$|^.*\.minisign\.pub$|^minisign\.pub$/.test(base)) kind = 'minisign';
    if (kind && p.length <= 300)
      out.push({ path: safe(p, 300), kind, state: 'key_present_in_repository', trusted: false });
    if (out.length >= 10) break;
  }
  return out;
}
