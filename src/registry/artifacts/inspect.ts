/* eslint-disable @typescript-eslint/ban-ts-comment */
// Binary archive offsets are validated at runtime; indexed byte access is intentionally unchecked here.
// @ts-nocheck
import { createHash } from 'node:crypto';
import { inflateRawSync, gunzipSync } from 'node:zlib';
import { LIMITS } from '../../limits.js';

export type ArtifactKind = 'npm' | 'pypi' | 'crates.io' | 'unknown';
export type ArtifactState =
  'verified' | 'verification_unavailable' | 'invalid' | 'unsupported' | 'failed';
export type ArtifactEntryKind = 'file' | 'directory' | 'symlink' | 'hardlink';
export interface ArtifactEntry {
  path: string;
  kind: ArtifactEntryKind;
  size: number;
  unsafe: boolean;
  duplicate: boolean;
  content?: Uint8Array;
}
export interface ArtifactInspection {
  state: ArtifactState;
  format: 'tar' | 'zip' | 'unknown';
  entries: ArtifactEntry[];
  totalSize: number;
  limitsHit: string[];
  diagnostics: string[];
  digest?: { algorithm: 'sha256' | 'sha512'; expected: string; actual: string; verified: boolean };
}

const text = (b: Uint8Array): string => new TextDecoder('utf-8', { fatal: false }).decode(b);
const oct = (b: Uint8Array): number => {
  const s = text(b).replace(/\0.*$/, '').trim();
  return s ? parseInt(s, 8) || 0 : 0;
};
const unsafePath = (p: string): boolean => {
  const n = p.replaceAll('\\', '/');
  return (
    n.startsWith('/') ||
    /^[A-Za-z]:\//.test(n) ||
    n.split('/').some((x) => x === '..') ||
    [...p].some(
      (c) =>
        c.charCodeAt(0) < 32 ||
        c === '\u202e' ||
        c === '\u202a' ||
        c === '\u202b' ||
        c === '\u202c' ||
        c === '\u202d',
    )
  );
};

function entriesTar(raw: Uint8Array): {
  entries: ArtifactEntry[];
  total: number;
  limits: string[];
  diagnostics: string[];
} {
  const entries: ArtifactEntry[] = [];
  const seen = new Set<string>();
  const limits: string[] = [];
  const diagnostics: string[] = [];
  let off = 0,
    total = 0,
    longName: string | undefined;
  while (off + 512 <= raw.length && entries.length < LIMITS.maxArtifactEntries) {
    const h = raw.subarray(off, off + 512);
    off += 512;
    if (h.every((x) => x === 0)) break;
    const name = longName ?? text(h.subarray(0, 100)).replace(/\0.*$/, '');
    longName = undefined;
    const size = oct(h.subarray(124, 136));
    const type = h[156];
    if (off + size > raw.length) {
      diagnostics.push('truncated_entry');
      break;
    }
    const body = raw.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    if (name === '././@LongLink' || type === 'L'.charCodeAt(0)) {
      longName = text(body).replace(/\0.*$/, '');
      continue;
    }
    const kind: ArtifactEntryKind =
      type === 5 ? 'directory' : type === 2 ? 'symlink' : type === 1 ? 'hardlink' : 'file';
    const duplicate = seen.has(name);
    seen.add(name);
    const unsafe = unsafePath(name) || kind === 'symlink' || kind === 'hardlink';
    if (unsafe && (kind === 'symlink' || kind === 'hardlink'))
      diagnostics.push('link_not_followed');
    total += Math.min(size, LIMITS.maxArtifactFileBytes);
    entries.push({
      path: name.slice(0, 300),
      kind,
      size,
      unsafe,
      duplicate,
      ...(kind === 'file' && size <= LIMITS.maxArtifactFileBytes ? { content: body.slice() } : {}),
    });
  }
  if (entries.length >= LIMITS.maxArtifactEntries) limits.push('entry_limit');
  return { entries, total, limits, diagnostics };
}

function entriesZip(raw: Uint8Array): {
  entries: ArtifactEntry[];
  total: number;
  limits: string[];
  diagnostics: string[];
} {
  const r = raw as unknown as { [index: number]: number };
  const entries: ArtifactEntry[] = [];
  const seen = new Set<string>();
  const limits: string[] = [];
  const diagnostics: string[] = [];
  let eocd = -1;
  for (let i = raw.length - 22; i >= Math.max(0, raw.length - 65557); i--)
    if (r[i] === 0x50 && r[i + 1] === 0x4b && r[i + 2] === 5 && r[i + 3] === 6) {
      eocd = i;
      break;
    }
  if (eocd < 0) return { entries, total: 0, limits, diagnostics: ['missing_zip_end_record'] };
  // ZIP fields are bounds-checked by the surrounding central-directory validation.
  // @ts-expect-error indexed binary fields are known present after the bounds check
  const count = r[eocd + 10] | (r[eocd + 11] << 8);
  const cdSize = r[eocd + 12] | (r[eocd + 13] << 8) | (r[eocd + 14] << 16) | (r[eocd + 15] << 24);
  const cdOff = r[eocd + 16] | (r[eocd + 17] << 8) | (r[eocd + 18] << 16) | (r[eocd + 19] << 24);
  if (count === 0xffff || cdSize < 0 || cdOff < 0 || cdOff + cdSize > raw.length)
    return { entries, total: 0, limits, diagnostics: ['unsupported_or_invalid_zip64'] };
  let p = cdOff,
    total = 0;
  for (let i = 0; i < count && entries.length < LIMITS.maxArtifactEntries; i++) {
    if (
      p + 46 > raw.length ||
      r[p] !== 0x50 ||
      r[p + 1] !== 0x4b ||
      r[p + 2] !== 1 ||
      r[p + 3] !== 2
    ) {
      diagnostics.push('truncated_central_directory');
      break;
    }
    // @ts-expect-error indexed binary fields are known present after the bounds check
    const method = r[p + 10] | (r[p + 11] << 8);
    const csize = r[p + 20] | (r[p + 21] << 8) | (r[p + 22] << 16) | (r[p + 23] << 24);
    const usize = r[p + 24] | (r[p + 25] << 8) | (r[p + 26] << 16) | (r[p + 27] << 24);
    const nl = r[p + 28] | (r[p + 29] << 8);
    const xl = r[p + 30] | (r[p + 31] << 8);
    const cl = r[p + 32] | (r[p + 33] << 8);
    const lo = r[p + 42] | (r[p + 43] << 8) | (r[p + 44] << 16) | (r[p + 45] << 24);
    const name = text(raw.subarray(p + 46, p + 46 + nl));
    p += 46 + nl + xl + cl;
    const dir = name.endsWith('/');
    const duplicate = seen.has(name);
    seen.add(name);
    const unsafe = unsafePath(name);
    let content: Uint8Array | undefined;
    // @ts-expect-error indexed binary fields are known present after the bounds check
    if (
      !dir &&
      usize <= LIMITS.maxArtifactFileBytes &&
      lo + 30 <= raw.length &&
      r[lo] === 0x50 &&
      r[lo + 1] === 0x4b &&
      r[lo + 2] === 3 &&
      r[lo + 3] === 4
    ) {
      const lnl = r[lo + 26] | (r[lo + 27] << 8);
      const lxl = r[lo + 28] | (r[lo + 29] << 8);
      const body = raw.subarray(lo + 30 + lnl + lxl, lo + 30 + lnl + lxl + csize);
      try {
        content =
          method === 0
            ? body.slice()
            : method === 8
              ? inflateRawSync(body, { maxOutputLength: LIMITS.maxArtifactFileBytes })
              : undefined;
      } catch {
        diagnostics.push('corrupt_entry');
      }
    }
    total += Math.min(usize, LIMITS.maxArtifactFileBytes);
    entries.push({
      path: name.slice(0, 300),
      kind: dir ? 'directory' : 'file',
      size: usize,
      unsafe,
      duplicate,
      ...(content ? { content } : {}),
    });
  }
  if (entries.length >= LIMITS.maxArtifactEntries) limits.push('entry_limit');
  return { entries, total, limits, diagnostics };
}

export function inspectArtifact(
  bytes: Uint8Array,
  opts: { kind?: ArtifactKind; expectedDigest?: string; algorithm?: 'sha256' | 'sha512' } = {},
): ArtifactInspection {
  const algorithm =
    opts.algorithm ?? (opts.expectedDigest?.startsWith('sha512-') ? 'sha512' : 'sha256');
  const actual = createHash(algorithm)
    .update(bytes)
    .digest(algorithm === 'sha256' ? 'hex' : 'base64');
  const expected = opts.expectedDigest?.replace(/^sha(?:256|512)-/, '').trim();
  const digest = expected
    ? { algorithm, expected, actual, verified: actual === expected }
    : undefined;
  if (digest && !digest.verified)
    return {
      state: 'invalid',
      format: 'unknown',
      entries: [],
      totalSize: 0,
      limitsHit: [],
      diagnostics: ['digest_mismatch'],
      digest,
    };
  if (bytes.length > LIMITS.maxArtifactCompressedBytes)
    return {
      state: 'failed',
      format: 'unknown',
      entries: [],
      totalSize: 0,
      limitsHit: ['artifact_size'],
      diagnostics: [],
      digest,
    };
  let raw = bytes;
  let format: 'tar' | 'zip' | 'unknown' = 'unknown';
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      raw = gunzipSync(bytes, { maxOutputLength: LIMITS.maxArtifactMetadataBytes });
      format = 'tar';
    } catch (e) {
      // Node reports an output over the cap as ERR_BUFFER_TOO_LARGE: that is a decompression bomb (or simply too large), never inspected
      const big = (e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE';
      return {
        state: 'failed',
        format,
        entries: [],
        totalSize: 0,
        limitsHit: big ? ['uncompressed_size'] : [],
        diagnostics: [big ? 'decompression_bomb' : 'corrupt_gzip'],
        digest,
      };
    }
  } else if (bytes[0] === 0x50 && bytes[1] === 0x4b) format = 'zip';
  const parsed =
    format === 'tar'
      ? entriesTar(raw)
      : format === 'zip'
        ? entriesZip(raw)
        : { entries: [], total: 0, limits: [], diagnostics: ['unsupported_archive'] };
  return {
    state: digest ? 'verified' : 'verification_unavailable',
    format,
    entries: parsed.entries,
    totalSize: parsed.total,
    limitsHit: parsed.limits,
    diagnostics: parsed.diagnostics,
    digest,
  };
}
