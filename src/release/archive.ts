import { gunzipSync } from 'node:zlib';
import { nameProblems } from './checksums.js';

/**
 * Structural inspection of downloaded release archives. The bytes are hostile: nothing is extracted, executed or written to
 * disk, only metadata (names, sizes, counts) is read, under hard limits. A bomb is detected from declared sizes and from the
 * compression ratio, not by inflating it.
 */
export const ARCHIVE_LIMITS = {
  maxInputBytes: 25 * 1024 * 1024,
  maxEntries: 20_000,
  maxTotalUncompressed: 2 * 1024 * 1024 * 1024,
  maxEntryUncompressed: 1024 * 1024 * 1024,
  maxRatio: 200,
  /** gunzip output cap when listing a .tar.gz */
  maxGunzipBytes: 64 * 1024 * 1024,
} as const;

export type ArchiveFormat = 'zip' | 'tar' | 'tar.gz' | 'unknown';
export interface ArchiveReport {
  format: ArchiveFormat;
  entries: number;
  total_uncompressed: number;
  /** Findings, each factual. Empty means nothing alarming in the metadata, not that the archive is safe. */
  problems: ArchiveProblem[];
  nested_archives: number;
  executables: number;
  truncated: boolean;
  /** First entry names, sanitized for display. */
  sample: string[];
}
export type ArchiveProblem =
  | 'path_traversal'
  | 'absolute_path'
  | 'unsafe_name'
  | 'too_many_entries'
  | 'declared_size_too_large'
  | 'compression_bomb'
  | 'nested_archive'
  | 'symlink_entry'
  | 'malformed'
  | 'input_too_large'
  | 'duplicate_entry';

const display = (n: string): string => n.replace(/[^\x20-\x7e]/g, '?').slice(0, 100);
const ARCHIVE_NAME = /\.(?:zip|jar|war|tar|tgz|tar\.gz|gz|bz2|xz|7z|rar|whl|nupkg)$/i;
const EXEC_NAME = /\.(?:exe|dll|so|dylib|sh|bat|cmd|ps1|msi|app|bin)$/i;

export function sniffFormat(
  b: Uint8Array,
): 'elf' | 'pe' | 'macho' | 'script' | 'zip' | 'gzip' | 'xz' | 'bzip2' | 'tar' | 'unknown' {
  if (b.length >= 4 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46)
    return 'elf';
  if (b.length >= 2 && b[0] === 0x4d && b[1] === 0x5a) return 'pe';
  if (b.length >= 4) {
    const m =
      ((b[0] as number) << 24) |
      ((b[1] as number) << 16) |
      ((b[2] as number) << 8) |
      (b[3] as number);
    if (
      [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].map((x) => x | 0).includes(m | 0)
    )
      return 'macho';
  }
  if (b.length >= 2 && b[0] === 0x23 && b[1] === 0x21) return 'script';
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5)) return 'zip';
  if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) return 'gzip';
  if (b.length >= 6 && b[0] === 0xfd && b[1] === 0x37 && b[2] === 0x7a) return 'xz';
  if (b.length >= 3 && b[0] === 0x42 && b[1] === 0x5a && b[2] === 0x68) return 'bzip2';
  if (b.length >= 262 && Buffer.from(b.subarray(257, 262)).toString('latin1') === 'ustar')
    return 'tar';
  return 'unknown';
}

function addProblem(r: ArchiveReport, p: ArchiveProblem): void {
  if (!r.problems.includes(p)) r.problems.push(p);
}
function checkName(name: string, r: ArchiveReport): void {
  const add = (p: ArchiveProblem): void => void (!r.problems.includes(p) && r.problems.push(p));
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) add('absolute_path');
  if (name.split(/[/\\]/).some((p) => p === '..')) add('path_traversal');
  else if (nameProblems(name)) add('unsafe_name');
  if (ARCHIVE_NAME.test(name)) r.nested_archives++;
  if (EXEC_NAME.test(name)) r.executables++;
}
function empty(format: ArchiveFormat): ArchiveReport {
  return {
    format,
    entries: 0,
    total_uncompressed: 0,
    problems: [],
    nested_archives: 0,
    executables: 0,
    truncated: false,
    sample: [],
  };
}
function finish(r: ArchiveReport, compressedSize: number): ArchiveReport {
  if (r.nested_archives > 0) r.problems.push('nested_archive');
  if (r.total_uncompressed > ARCHIVE_LIMITS.maxTotalUncompressed)
    r.problems.push('declared_size_too_large');
  if (
    compressedSize > 0 &&
    r.total_uncompressed / compressedSize > ARCHIVE_LIMITS.maxRatio &&
    r.total_uncompressed > 10 * 1024 * 1024
  )
    r.problems.push('compression_bomb');
  return r;
}

/** List a ZIP from its central directory (end-of-central-directory record -> central headers). Never inflates anything. */
export function inspectZip(bytes: Uint8Array): ArchiveReport {
  const r = empty('zip');
  if (bytes.length > ARCHIVE_LIMITS.maxInputBytes) {
    r.problems.push('input_too_large');
    return r;
  }
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) {
    r.problems.push('malformed');
    return r;
  }
  const declared = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (declared > ARCHIVE_LIMITS.maxEntries) {
    r.problems.push('too_many_entries');
    r.truncated = true;
  }
  const seen = new Set<string>();
  for (let n = 0; n < Math.min(declared, ARCHIVE_LIMITS.maxEntries); n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) {
      r.problems.push('malformed');
      break;
    }
    const compressed = buf.readUInt32LE(off + 20);
    const size = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const attrs = buf.readUInt32LE(off + 38);
    if (off + 46 + nameLen > buf.length) {
      r.problems.push('malformed');
      break;
    }
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (size > ARCHIVE_LIMITS.maxEntryUncompressed) addProblem(r, 'declared_size_too_large');
    if (size > 10 * 1024 * 1024 && compressed > 0 && size / compressed > ARCHIVE_LIMITS.maxRatio)
      addProblem(r, 'compression_bomb');
    if (((attrs >>> 16) & 0xf000) === 0xa000) addProblem(r, 'symlink_entry');
    if (seen.has(name)) addProblem(r, 'duplicate_entry');
    seen.add(name);
    r.entries++;
    r.total_uncompressed += size;
    checkName(name, r);
    if (r.sample.length < 10) r.sample.push(display(name));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return finish(r, bytes.length);
}

/** List a tar (optionally gzip-compressed) from its 512-byte headers. */
export function inspectTar(bytes: Uint8Array, gz = false): ArchiveReport {
  const r = empty(gz ? 'tar.gz' : 'tar');
  if (bytes.length > ARCHIVE_LIMITS.maxInputBytes) {
    r.problems.push('input_too_large');
    return r;
  }
  let data: Buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (gz) {
    try {
      data = gunzipSync(data, { maxOutputLength: ARCHIVE_LIMITS.maxGunzipBytes });
    } catch {
      // either malformed or larger than the inflate cap: both are reported, neither is followed
      r.problems.push(bytes.length > 0 ? 'compression_bomb' : 'malformed');
      return r;
    }
  }
  let off = 0;
  const seen = new Set<string>();
  while (off + 512 <= data.length) {
    const header = data.subarray(off, off + 512);
    if (header.every((x) => x === 0)) break;
    const name = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '');
    const full = prefix ? `${prefix}/${name}` : name;
    const sizeStr = header.toString('ascii', 124, 136).replace(/\0.*$/, '').trim();
    const size = /^[0-7]+$/.test(sizeStr) ? parseInt(sizeStr, 8) : NaN;
    const type = String.fromCharCode(header[156] as number);
    if (!Number.isFinite(size) || size < 0) {
      r.problems.push('malformed');
      break;
    }
    if (r.entries >= ARCHIVE_LIMITS.maxEntries) {
      r.problems.push('too_many_entries');
      r.truncated = true;
      break;
    }
    if (type === '2' || type === '1') addProblem(r, 'symlink_entry');
    if (seen.has(full)) addProblem(r, 'duplicate_entry');
    seen.add(full);
    r.entries++;
    r.total_uncompressed += size;
    checkName(full, r);
    if (r.sample.length < 10) r.sample.push(display(full));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return finish(r, gz ? bytes.length : 0);
}

export function inspectArchive(bytes: Uint8Array): ArchiveReport {
  switch (sniffFormat(bytes)) {
    case 'zip':
      return inspectZip(bytes);
    case 'gzip':
      return inspectTar(bytes, true);
    case 'tar':
      return inspectTar(bytes, false);
    default: {
      const r = empty('unknown');
      return r;
    }
  }
}
