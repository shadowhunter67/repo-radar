import type { ArtifactDigest } from './model.js';

/** Hex length -> algorithm. Lengths that fit no algorithm make the line malformed. */
const BY_LENGTH: Record<number, ArtifactDigest['algorithm']> = {
  32: 'md5',
  40: 'sha1',
  64: 'sha256',
  96: 'sha384',
  128: 'sha512',
};
const NAMED: Record<string, ArtifactDigest['algorithm']> = {
  md5: 'md5',
  sha1: 'sha1',
  'sha-1': 'sha1',
  sha256: 'sha256',
  'sha-256': 'sha256',
  sha384: 'sha384',
  sha512: 'sha512',
  'sha-512': 'sha512',
};

export const CHECKSUM_LIMITS = {
  maxBytes: 1024 * 1024,
  maxLines: 5000,
  maxNameLength: 300,
} as const;

export interface ChecksumEntry {
  algorithm: ArtifactDigest['algorithm'];
  value: string;
  name: string;
}
export interface ChecksumFile {
  entries: ChecksumEntry[];
  malformed: number;
  /** A name listed with two different digests of the same algorithm. */
  conflicts: string[];
  /** A listed name that is absolute, contains `..`, a backslash or a control character. */
  unsafe_names: string[];
  truncated: boolean;
}

/** Control characters (including ESC) and path tricks: such a name is data, never a path. */
export function nameProblems(name: string): boolean {
  for (const ch of name) {
    const c = ch.charCodeAt(0);
    if (c < 32 || c === 127 || (c >= 0x80 && c <= 0x9f)) return true;
    if (c === 0x202e || (c >= 0x2066 && c <= 0x2069)) return true; // bidi overrides/isolates
  }
  return (
    name.includes('\\') ||
    name.startsWith('/') ||
    /^[a-zA-Z]:/.test(name) ||
    name.split('/').some((p) => p === '..')
  );
}

/**
 * Parse sha*sum style (`<hex>  <name>`, `<hex> *<name>`) and BSD style (`SHA256 (<name>) = <hex>`) files. The text is
 * untrusted: the size and line count are capped, nothing is interpreted as a path, and a name with two different digests is
 * reported as a conflict instead of picking one.
 */
export function parseChecksumFile(text: string, impliedName?: string): ChecksumFile {
  const out: ChecksumFile = {
    entries: [],
    malformed: 0,
    conflicts: [],
    unsafe_names: [],
    truncated: false,
  };
  let body = text;
  if (body.length > CHECKSUM_LIMITS.maxBytes) {
    body = body.slice(0, CHECKSUM_LIMITS.maxBytes);
    out.truncated = true;
  }
  const seen = new Map<string, string>();
  let seenBare = false;
  const lines = body.split(/\r?\n/);
  if (lines.length > CHECKSUM_LIMITS.maxLines) out.truncated = true;
  for (const raw of lines.slice(0, CHECKSUM_LIMITS.maxLines)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    // `<asset>.sha256` files often hold one bare digest (the asset is named by the file, not inside it)
    const bare = /^([0-9a-fA-F]{32,128})$/.exec(line);
    if (bare && impliedName) {
      const v = (bare[1] as string).toLowerCase();
      const a = BY_LENGTH[v.length];
      if (a && !seenBare) {
        seenBare = true;
        out.entries.push({ algorithm: a, value: v, name: impliedName });
        seen.set(`${a}:${impliedName}`, v);
        continue;
      }
      out.malformed++;
      continue;
    }
    let algo: ArtifactDigest['algorithm'] | undefined;
    let value: string | undefined;
    let name: string | undefined;
    const bsd = /^([A-Za-z0-9-]{3,10}) ?\((.{1,400})\) ?= ?([0-9a-fA-F]{32,128})$/.exec(line);
    if (bsd) {
      algo = NAMED[(bsd[1] as string).toLowerCase()];
      name = bsd[2];
      value = (bsd[3] as string).toLowerCase();
      if (algo && BY_LENGTH[value.length] !== algo) algo = undefined;
    } else {
      const gnu = /^([0-9a-fA-F]{32,128})[ \t]+\*?(.{1,400})$/.exec(line);
      if (gnu) {
        value = (gnu[1] as string).toLowerCase();
        name = gnu[2];
        algo = BY_LENGTH[value.length];
      }
    }
    if (!algo || !value || !name || name.length > CHECKSUM_LIMITS.maxNameLength) {
      out.malformed++;
      continue;
    }
    if (nameProblems(name)) {
      out.unsafe_names.push(name.replace(/[^\x20-\x7e]/g, '?').slice(0, 80));
      out.malformed++;
      continue;
    }
    const key = `${algo}:${name}`;
    const prev = seen.get(key);
    if (prev !== undefined && prev !== value) {
      if (!out.conflicts.includes(name)) out.conflicts.push(name);
      continue;
    }
    seen.set(key, value);
    if (prev === undefined) out.entries.push({ algorithm: algo, value, name });
  }
  return out;
}

export const isWeak = (a: ArtifactDigest['algorithm']): boolean => a === 'md5' || a === 'sha1';

/** `sha256:<hex>` as GitHub reports an asset digest. */
export function parseDigestString(
  s: unknown,
): { algorithm: ArtifactDigest['algorithm']; value: string } | undefined {
  if (typeof s !== 'string') return undefined;
  const m = /^([a-z0-9-]{3,8}):([0-9a-f]{32,128})$/.exec(s.toLowerCase());
  if (!m) return undefined;
  const algo = NAMED[m[1] as string];
  const value = m[2] as string;
  return algo && BY_LENGTH[value.length] === algo ? { algorithm: algo, value } : undefined;
}

export function looksLikeChecksumFile(name: string): boolean {
  return (
    (/(?:^|[._-])(?:sha(?:1|256|384|512)sums?|checksums?|md5sums?|sha256|sha512)(?:[._-]|$)/i.test(
      name,
    ) &&
      !/\.(?:sig|asc|pem|sigstore|sigstore\.json|bundle|minisig)$/i.test(name)) ||
    /\.(?:sha256|sha512|sha1|md5)(?:sum)?$/i.test(name)
  );
}
