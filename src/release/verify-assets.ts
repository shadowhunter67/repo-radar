import { createHash } from 'node:crypto';
import type { HttpClient } from '../util/http.js';
import { TooLargeError } from '../util/http.js';
import { inspectArchive } from './archive.js';
import { binaryMeta } from './binmeta.js';
import { parseChecksumFile } from './checksums.js';
import type { Release } from './model.js';

/**
 * Bounded verification of asset bytes against published digests. Hashing uses the platform's crypto library (no custom
 * cryptography). Large assets are NEVER downloaded to "verify everything": each asset, the number of assets and the total
 * bytes are capped, and a skipped asset is reported as `verification_skipped_resource_limit`, not as verified. Weak
 * algorithms (MD5, SHA-1) are never used as the expected value.
 */
export interface AssetVerifyLimits {
  maxAssets: number;
  maxAssetBytes: number;
  maxTotalBytes: number;
}
export const ASSET_VERIFY_LIMITS: AssetVerifyLimits = {
  maxAssets: 3,
  maxAssetBytes: 8 * 1024 * 1024,
  maxTotalBytes: 24 * 1024 * 1024,
};

type Check = Release['asset_checks'][number];
const STRONG = new Set(['sha256', 'sha384', 'sha512']);

export interface AssetToVerify {
  name: string;
  size: number | null;
  url: string | null;
  /** Digest GitHub reports for the stored asset, if any. */
  apiDigest: { algorithm: string; value: string } | null;
  kind: string;
}

export async function verifyAssets(opts: {
  http: HttpClient;
  assets: AssetToVerify[];
  /** Checksum-file texts of the release (asset name of the file -> text). */
  checksumTexts: Map<string, string>;
  limits?: Partial<AssetVerifyLimits>;
  isSafeUrl: (u: unknown) => boolean;
  budgetOk: () => boolean;
}): Promise<Check[]> {
  const lim = { ...ASSET_VERIFY_LIMITS, ...opts.limits };
  const fromFile = new Map<string, { algorithm: string; value: string }>();
  for (const [file, text] of opts.checksumTexts) {
    const implied = file.replace(/\.(?:sha(?:1|256|384|512)|md5)(?:sum)?$/i, '');
    for (const e of parseChecksumFile(text, implied).entries)
      if (STRONG.has(e.algorithm) && !fromFile.has(e.name)) fromFile.set(e.name, e);
  }
  const candidates = opts.assets.filter(
    (a) =>
      ['binary', 'archive', 'package'].includes(a.kind) &&
      (fromFile.has(a.name) || (a.apiDigest && STRONG.has(a.apiDigest.algorithm))),
  );
  const out: Check[] = [];
  let total = 0;
  for (const a of candidates.slice(0, 10)) {
    const expected = [
      fromFile.get(a.name),
      a.apiDigest && STRONG.has(a.apiDigest.algorithm) ? a.apiDigest : undefined,
    ].filter((x): x is { algorithm: string; value: string } => !!x);
    const first = expected[0];
    const base: Check = {
      asset: a.name.replace(/[^\x20-\x7e]/g, '?').slice(0, 300),
      state: 'checksum_present',
      algorithm: first?.algorithm ?? null,
      expected: first?.value ?? null,
      actual: null,
      bytes: null,
      inspection: null,
    };
    const verifiedSoFar = out.filter((c) => c.bytes !== null).length;
    if (
      verifiedSoFar >= lim.maxAssets ||
      a.size === null ||
      a.size > lim.maxAssetBytes ||
      total + a.size > lim.maxTotalBytes ||
      !opts.isSafeUrl(a.url) ||
      !opts.budgetOk()
    ) {
      out.push({
        ...base,
        state:
          a.url && opts.isSafeUrl(a.url)
            ? 'verification_skipped_resource_limit'
            : 'checksum_present',
      });
      continue;
    }
    try {
      const r = await opts.http.request(a.url as string, {
        maxBytes: lim.maxAssetBytes,
        binary: true,
      });
      if (r.status !== 200) {
        out.push({ ...base, state: 'download_failed' });
        continue;
      }
      const bytes = Buffer.from(r.body, 'latin1');
      total += bytes.length;
      let mismatch: { algorithm: string; value: string; actual: string } | undefined;
      let actualShown: string | null = null;
      for (const e of expected) {
        const actual = createHash(e.algorithm).update(bytes).digest('hex');
        actualShown ??= actual;
        if (actual !== e.value.toLowerCase() && !mismatch) mismatch = { ...e, actual };
      }
      const meta = binaryMeta(bytes);
      const arch = inspectArchive(bytes);
      out.push({
        ...base,
        state: mismatch ? 'checksum_mismatch' : 'checksum_verified',
        algorithm: (mismatch ?? first)?.algorithm ?? null,
        expected: (mismatch ?? first)?.value ?? null,
        actual: mismatch?.actual ?? actualShown,
        bytes: bytes.length,
        inspection: {
          format: meta.format,
          architecture: meta.architecture,
          platform: meta.platform,
          archive_problems: arch.problems.slice(0, 12),
          entries: arch.format === 'unknown' ? null : arch.entries,
        },
      });
    } catch (e) {
      out.push({
        ...base,
        state:
          e instanceof TooLargeError ? 'verification_skipped_resource_limit' : 'download_failed',
      });
    }
  }
  return out;
}
