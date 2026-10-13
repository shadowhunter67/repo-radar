import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { ReportSchema, type Report } from '../report/schema.js';
import { canonicalReportHash } from '../report/integrity.js';

/**
 * Immutable snapshot store. A snapshot is one analysis report, keyed by
 *   repository identity + commit SHA + schema version + methodology + configuration digest.
 * The first report stored under a key is the canonical record: it is never overwritten. A later report for the same key with
 * a different hash is a CONFLICT (reported, not stored) unless the caller explicitly asks for a content-addressed revision,
 * which is written next to it and likewise never replaced. Nothing is a database: a directory tree plus an append-only index.
 *
 * Every key component is validated against a strict pattern before it becomes a path segment, so a repository name or a
 * report field can never traverse out of the store. Stored files are hostile on read: size-capped, hash-checked against the
 * report's own integrity digest, and validated against the report schema.
 */
export interface SnapshotKey {
  repository: string; // owner/repo, lowercase
  commit: string; // 40 hex
  schema_version: string;
  methodology: string;
  config_digest: string; // first 16 hex of the configuration digest
}

export type PutStatus = 'stored' | 'exists' | 'conflict' | 'revision_stored' | 'rejected';
export interface PutResult {
  status: PutStatus;
  key: SnapshotKey | null;
  path: string | null;
  report_sha256: string | null;
  /** The hash of the report already stored under the key (for `exists`/`conflict`). */
  stored_sha256?: string;
  message: string;
}

export interface IndexEntry extends SnapshotKey {
  file: string;
  report_sha256: string;
  generated_at: string;
  tool_version: string;
  stored_at: string;
  bytes: number;
  /** Non-empty for a content-addressed revision stored after a conflict. */
  revision_of?: string;
}

export interface SnapshotStore {
  putSnapshot(report: Report, options?: { allowRevision?: boolean }): PutResult;
  getSnapshot(key: SnapshotKey): { report: Report; entry: IndexEntry } | { error: string };
  hasSnapshot(key: SnapshotKey): boolean;
  listSnapshots(filter?: Partial<SnapshotKey> & { limit?: number }): IndexEntry[];
}

const REPO = /^[a-z0-9][a-z0-9._-]{0,38}\/[a-z0-9._-]{1,100}$/;
const SEG = /^[a-z0-9][a-z0-9._-]*$/;
export const SNAPSHOT_LIMITS = { maxBytes: 50 * 1024 * 1024, maxIndexLines: 100_000 } as const;

export function keyOf(r: Report): SnapshotKey | undefined {
  const repository = `${r.subject.owner}/${r.subject.repo}`.toLowerCase();
  const commit = r.subject.ref;
  if (!commit || !/^[0-9a-f]{40}$/.test(commit)) return undefined;
  const key: SnapshotKey = {
    repository,
    commit,
    schema_version: r.schema_version,
    methodology: r.methodology.version,
    config_digest: r.methodology.config_digest.slice(0, 16),
  };
  return validKey(key) ? key : undefined;
}

export function validKey(k: SnapshotKey): boolean {
  return (
    REPO.test(k.repository) &&
    k.repository.split('/').every((p) => p !== '.' && p !== '..' && !p.startsWith('.')) &&
    /^[0-9a-f]{40}$/.test(k.commit) &&
    /^\d{1,3}\.\d{1,3}$/.test(k.schema_version) &&
    /^\d{1,3}\.\d{1,3}$/.test(k.methodology) &&
    /^[0-9a-f]{16}$/.test(k.config_digest)
  );
}

const fileName = (k: SnapshotKey, revision?: string): string =>
  `${k.schema_version}__${k.methodology}__${k.config_digest}${revision ? `__rev-${revision}` : ''}.json`;

export class FsSnapshotStore implements SnapshotStore {
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(join(this.root, 'snapshots'), { recursive: true });
  }

  private dirOf(k: SnapshotKey): string {
    const [owner, repo] = k.repository.split('/') as [string, string];
    if (!SEG.test(owner) || !SEG.test(repo)) throw new Error('unsafe repository name');
    const dir = resolve(this.root, 'snapshots', owner, repo, k.commit);
    // Defence in depth: the resolved directory must still be inside the store.
    if (!dir.startsWith(join(this.root, 'snapshots') + sep))
      throw new Error('path escapes the snapshot store');
    return dir;
  }
  private get indexPath(): string {
    return join(this.root, 'index.jsonl');
  }

  putSnapshot(report: Report, options: { allowRevision?: boolean } = {}): PutResult {
    const key = keyOf(report);
    if (!key)
      return {
        status: 'rejected',
        key: null,
        path: null,
        report_sha256: null,
        message:
          'the report has no full commit SHA or an invalid key component; it cannot be stored as an immutable snapshot',
      };
    const sha = report.integrity.report_sha256;
    if (canonicalReportHash(report) !== sha)
      return {
        status: 'rejected',
        key,
        path: null,
        report_sha256: sha,
        message: "the report's integrity digest does not match its content",
      };
    const dir = this.dirOf(key);
    mkdirSync(dir, { recursive: true });
    const primary = join(dir, fileName(key));
    const data = JSON.stringify(report);
    if (existsSync(primary)) {
      const stored = this.readHash(primary);
      if (stored === sha)
        return {
          status: 'exists',
          key,
          path: primary,
          report_sha256: sha,
          stored_sha256: stored,
          message: 'an identical snapshot is already stored',
        };
      if (!options.allowRevision)
        return {
          status: 'conflict',
          key,
          path: primary,
          report_sha256: sha,
          ...(stored ? { stored_sha256: stored } : {}),
          message:
            'a different report is already stored under this key; the stored one was kept (nothing was overwritten)',
        };
      const rev = join(dir, fileName(key, sha.slice(0, 12)));
      if (existsSync(rev))
        return {
          status: 'exists',
          key,
          path: rev,
          report_sha256: sha,
          message: 'this revision is already stored',
        };
      this.writeNew(rev, data);
      this.index(
        key,
        rev,
        report,
        data.length,
        report.integrity.report_sha256 === stored ? undefined : (stored ?? 'unreadable'),
      );
      return {
        status: 'revision_stored',
        key,
        path: rev,
        report_sha256: sha,
        ...(stored ? { stored_sha256: stored } : {}),
        message: 'stored as a content-addressed revision next to the canonical snapshot',
      };
    }
    this.writeNew(primary, data);
    this.index(key, primary, report, data.length);
    return { status: 'stored', key, path: primary, report_sha256: sha, message: 'stored' };
  }

  /** Write a new file atomically and refuse to replace an existing one (hard link fails when the target exists). */
  private writeNew(path: string, data: string): void {
    const tmp = `${path}.${process.pid}.${createHash('sha256')
      .update(data.slice(0, 4096) + Date.now())
      .digest('hex')
      .slice(0, 8)}.tmp`;
    writeFileSync(tmp, data, { flag: 'wx' });
    try {
      linkSync(tmp, path);
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        /* temp already gone */
      }
    }
  }

  private index(k: SnapshotKey, file: string, r: Report, bytes: number, revisionOf?: string): void {
    const entry: IndexEntry = {
      ...k,
      file: file
        .slice(this.root.length + 1)
        .split(sep)
        .join('/'),
      report_sha256: r.integrity.report_sha256,
      generated_at: r.generated_at,
      tool_version: r.tool.version,
      stored_at: new Date().toISOString(),
      bytes,
      ...(revisionOf ? { revision_of: revisionOf } : {}),
    };
    appendFileSync(this.indexPath, JSON.stringify(entry) + '\n');
  }

  private readHash(path: string): string | undefined {
    try {
      if (statSync(path).size > SNAPSHOT_LIMITS.maxBytes) return undefined;
      const j = JSON.parse(readFileSync(path, 'utf8')) as {
        integrity?: { report_sha256?: unknown };
      };
      return typeof j.integrity?.report_sha256 === 'string' ? j.integrity.report_sha256 : undefined;
    } catch {
      return undefined;
    }
  }

  hasSnapshot(key: SnapshotKey): boolean {
    return validKey(key) && existsSync(join(this.dirOf(key), fileName(key)));
  }

  getSnapshot(key: SnapshotKey): { report: Report; entry: IndexEntry } | { error: string } {
    if (!validKey(key)) return { error: 'invalid snapshot key' };
    const path = join(this.dirOf(key), fileName(key));
    if (!existsSync(path)) return { error: 'no snapshot stored under this key' };
    try {
      if (statSync(path).size > SNAPSHOT_LIMITS.maxBytes)
        return { error: 'stored file exceeds the size limit' };
      const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      const parsed = ReportSchema.safeParse(raw);
      if (!parsed.success) return { error: 'stored file does not match the report schema' };
      const r = parsed.data;
      if (canonicalReportHash(raw as object) !== r.integrity.report_sha256)
        return {
          error: 'stored file was modified: its content does not match its integrity digest',
        };
      const entry = this.listSnapshots({ ...key, limit: 1 })[0];
      if (!entry) return { error: 'snapshot is not in the index' };
      // The report as stored (validated, not re-ordered): its integrity digest depends on key order, so a copy made from the
      // schema-parsed object would no longer match its own digest and could not be stored again.
      return { report: raw as Report, entry };
    } catch (e) {
      return {
        error: `unreadable snapshot (${e instanceof Error ? e.message.slice(0, 60) : 'error'})`,
      };
    }
  }

  listSnapshots(filter: Partial<SnapshotKey> & { limit?: number } = {}): IndexEntry[] {
    if (!existsSync(this.indexPath)) return [];
    let text: string;
    try {
      if (statSync(this.indexPath).size > SNAPSHOT_LIMITS.maxBytes) return [];
      text = readFileSync(this.indexPath, 'utf8');
    } catch {
      return [];
    }
    const out: IndexEntry[] = [];
    for (const line of text.split('\n').slice(0, SNAPSHOT_LIMITS.maxIndexLines)) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as IndexEntry;
        if (!validKey(e) || typeof e.file !== 'string' || e.file.includes('..')) continue; // corrupt or hostile line
        if (filter.repository && e.repository !== filter.repository.toLowerCase()) continue;
        if (filter.commit && e.commit !== filter.commit) continue;
        if (filter.schema_version && e.schema_version !== filter.schema_version) continue;
        if (filter.methodology && e.methodology !== filter.methodology) continue;
        if (filter.config_digest && e.config_digest !== filter.config_digest) continue;
        out.push(e);
      } catch {
        /* skip an unreadable index line */
      }
    }
    out.sort((a, b) => (a.stored_at < b.stored_at ? 1 : -1));
    return out.slice(0, filter.limit ?? 200);
  }
}

/**
 * Copy every snapshot of one store into another (export / import, or a move to another backend). Each snapshot is read with
 * its hash verified and written through the target's own immutability rules, so a conflicting snapshot in the target is kept
 * and reported, never overwritten.
 */
export function copySnapshots(
  from: SnapshotStore,
  to: SnapshotStore,
  options: { allowRevision?: boolean } = {},
): { copied: number; existing: number; conflicts: number; unreadable: number } {
  const out = { copied: 0, existing: 0, conflicts: 0, unreadable: 0 };
  for (const entry of from.listSnapshots({ limit: SNAPSHOT_LIMITS.maxIndexLines })) {
    const got = from.getSnapshot(entry);
    if ('error' in got) {
      out.unreadable++;
      continue;
    }
    const r = to.putSnapshot(got.report, options);
    if (r.status === 'stored' || r.status === 'revision_stored') out.copied++;
    else if (r.status === 'exists') out.existing++;
    else if (r.status === 'conflict') out.conflicts++;
    else out.unreadable++;
  }
  return out;
}
