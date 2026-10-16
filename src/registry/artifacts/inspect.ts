/** Checked binary access for hostile archive bytes. */
export class BoundedBinaryReader {
  constructor(private readonly bytes: Uint8Array) {}
  canRead(offset: number, length: number): boolean {
    return (
      Number.isSafeInteger(offset) &&
      Number.isSafeInteger(length) &&
      offset >= 0 &&
      length >= 0 &&
      offset <= this.bytes.length - length
    );
  }
  readUInt16LE(offset: number): number | undefined {
    return this.canRead(offset, 2)
      ? (this.bytes[offset] ?? 0) + (this.bytes[offset + 1] ?? 0) * 0x100
      : undefined;
  }
  readUInt32LE(offset: number): number | undefined {
    return this.canRead(offset, 4)
      ? (this.bytes[offset] ?? 0) +
          (this.bytes[offset + 1] ?? 0) * 0x100 +
          (this.bytes[offset + 2] ?? 0) * 0x10000 +
          (this.bytes[offset + 3] ?? 0) * 0x1000000
      : undefined;
  }
  readUInt32BE(offset: number): number | undefined {
    return this.canRead(offset, 4)
      ? (this.bytes[offset] ?? 0) * 0x1000000 +
          (this.bytes[offset + 1] ?? 0) * 0x10000 +
          (this.bytes[offset + 2] ?? 0) * 0x100 +
          (this.bytes[offset + 3] ?? 0)
      : undefined;
  }
  slice(offset: number, length: number): Uint8Array | undefined {
    return this.canRead(offset, length) ? this.bytes.slice(offset, offset + length) : undefined;
  }
}
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
const strictText = (b: Uint8Array): string | undefined => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return undefined;
  }
};
const oct = (b: Uint8Array): number | undefined => {
  const s = text(b).replace(/\0.*$/, '').trim();
  if (!/^[0-7]*$/.test(s)) return undefined;
  const value = s ? parseInt(s, 8) : 0;
  return Number.isSafeInteger(value) ? value : undefined;
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
    longName: string | undefined,
    longLink: string | undefined,
    pax: Record<string, string> = {};
  while (off + 512 <= raw.length && entries.length < LIMITS.maxArtifactEntries) {
    const h = raw.subarray(off, off + 512);
    off += 512;
    if (h.every((x) => x === 0)) break;
    const name = pax.path ?? longName ?? text(h.subarray(0, 100)).replace(/\0.*$/, '');
    longName = undefined;
    const size = oct(h.subarray(124, 136));
    const type = h[156];
    if (size === undefined || size > raw.length - off) {
      diagnostics.push('truncated_entry');
      break;
    }
    const body = raw.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    if (type === 'x'.charCodeAt(0) || type === 'g'.charCodeAt(0)) {
      if (size > 256 * 1024) {
        diagnostics.push('pax_block_limit');
        continue;
      }
      const paxText = strictText(body);
      if (paxText === undefined) {
        diagnostics.push('invalid_utf8');
        continue;
      }
      for (const record of paxText.split('\n')) {
        if (!record) continue;
        const space = record.indexOf(' ');
        const eq = record.indexOf('=', space + 1);
        const length = Number(space > 0 ? record.slice(0, space) : 'NaN');
        if (!Number.isSafeInteger(length) || length !== record.length + 1 || eq <= space + 1) {
          diagnostics.push('invalid_pax_record');
          continue;
        }
        const key = record.slice(space + 1, eq);
        if (!['path', 'linkpath', 'size'].includes(key)) continue;
        if (Object.hasOwn(pax, key)) diagnostics.push('duplicate_pax_key');
        pax[key] = record.slice(eq + 1);
      }
      continue;
    }
    if (name === '././@LongLink' || type === 'L'.charCodeAt(0)) {
      longName = text(body).replace(/\0.*$/, '');
      continue;
    }
    if (type === 'K'.charCodeAt(0)) {
      longLink = text(body).replace(/\0.*$/, '');
      continue;
    }
    const effectiveSize = pax.size === undefined ? size : Number(pax.size);
    if (
      !Number.isSafeInteger(effectiveSize) ||
      effectiveSize < 0 ||
      effectiveSize > LIMITS.maxArtifactMetadataBytes
    ) {
      diagnostics.push('invalid_pax_size');
      pax = {};
      continue;
    }
    const effectiveLink = pax.linkpath ?? longLink;
    if (name.length > 300 || (effectiveLink !== undefined && effectiveLink.length > 300))
      diagnostics.push('path_limit');
    const kind: ArtifactEntryKind =
      type === 5 ? 'directory' : type === 2 ? 'symlink' : type === 1 ? 'hardlink' : 'file';
    const duplicate = seen.has(name);
    seen.add(name);
    const unsafe =
      unsafePath(name) ||
      (effectiveLink !== undefined && unsafePath(effectiveLink)) ||
      kind === 'symlink' ||
      kind === 'hardlink';
    if (unsafe && (kind === 'symlink' || kind === 'hardlink'))
      diagnostics.push('link_not_followed');
    total += Math.min(effectiveSize, LIMITS.maxArtifactFileBytes);
    entries.push({
      path: name.slice(0, 300),
      kind,
      size: effectiveSize,
      unsafe,
      duplicate,
      ...(kind === 'file' && size <= LIMITS.maxArtifactFileBytes ? { content: body.slice() } : {}),
    });
    pax = {};
    longLink = undefined;
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
  const r = new BoundedBinaryReader(raw);
  const entries: ArtifactEntry[] = [];
  const seen = new Set<string>();
  const limits: string[] = [];
  const diagnostics: string[] = [];
  let eocd = -1;
  for (let i = Math.max(0, raw.length - 65557); i <= raw.length - 22; i++)
    if (r.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) return { entries, total: 0, limits, diagnostics: ['missing_zip_end_record'] };
  const count = r.readUInt16LE(eocd + 10),
    cdSize = r.readUInt32LE(eocd + 12),
    cdOff = r.readUInt32LE(eocd + 16);
  if (
    count === undefined ||
    cdSize === undefined ||
    cdOff === undefined ||
    count === 0xffff ||
    !r.canRead(cdOff, cdSize)
  )
    return { entries, total: 0, limits, diagnostics: ['zip64_unsupported'] };
  let p = cdOff,
    total = 0;
  for (let i = 0; i < count && entries.length < LIMITS.maxArtifactEntries; i++) {
    if (!r.canRead(p, 46) || r.readUInt32LE(p) !== 0x02014b50) {
      diagnostics.push('truncated_central_directory');
      break;
    }
    const method = r.readUInt16LE(p + 10),
      csize = r.readUInt32LE(p + 20),
      usize = r.readUInt32LE(p + 24),
      nl = r.readUInt16LE(p + 28),
      xl = r.readUInt16LE(p + 30),
      cl = r.readUInt16LE(p + 32),
      lo = r.readUInt32LE(p + 42);
    if (
      [method, csize, usize, nl, xl, cl, lo].some((v) => v === undefined) ||
      !r.canRead(p + 46, (nl ?? 0) + (xl ?? 0) + (cl ?? 0))
    ) {
      diagnostics.push('truncated_central_directory');
      break;
    }
    const name = text(r.slice(p + 46, nl ?? 0) ?? new Uint8Array());
    p += 46 + (nl ?? 0) + (xl ?? 0) + (cl ?? 0);
    const dir = name.endsWith('/');
    const duplicate = seen.has(name);
    seen.add(name);
    const unsafe = unsafePath(name);
    let content: Uint8Array | undefined;
    if (
      !dir &&
      (usize ?? 0) <= LIMITS.maxArtifactFileBytes &&
      r.readUInt32LE(lo ?? 0) === 0x04034b50
    ) {
      const lnl = r.readUInt16LE((lo ?? 0) + 26),
        lxl = r.readUInt16LE((lo ?? 0) + 28);
      const body =
        lnl !== undefined && lxl !== undefined
          ? r.slice((lo ?? 0) + 30 + lnl + lxl, csize ?? 0)
          : undefined;
      try {
        content =
          method === 0 && body
            ? body.slice()
            : method === 8 && body
              ? inflateRawSync(body, { maxOutputLength: LIMITS.maxArtifactFileBytes })
              : undefined;
      } catch {
        diagnostics.push('corrupt_entry');
      }
    }
    total += Math.min(usize ?? 0, LIMITS.maxArtifactFileBytes);
    entries.push({
      path: name.slice(0, 300),
      kind: dir ? 'directory' : 'file',
      size: usize ?? 0,
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
    ? {
        algorithm,
        expected,
        actual,
        verified:
          algorithm === 'sha256'
            ? actual.toLowerCase() === expected.toLowerCase()
            : actual === expected,
      }
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
