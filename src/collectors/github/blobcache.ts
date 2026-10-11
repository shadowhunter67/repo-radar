/**
 * Within-run reuse of fetched file contents, keyed by repository and git blob sha (a content address). When two
 * revisions of one repository are analyzed in the same run, every file whose blob did not change is read from here
 * instead of being downloaded again. Nothing persists past the process: it is a memo table, not a database.
 */
export class BlobCache {
  private readonly map = new Map<string, string>();
  private bytes = 0;
  hits = 0;
  misses = 0;
  constructor(
    private readonly maxEntries = 4000,
    private readonly maxBytes = 64 * 1024 * 1024,
  ) {}

  private key(repo: string, sha: string): string {
    return `${repo.toLowerCase()}@${sha}`;
  }

  get(repo: string, sha: string | undefined): string | undefined {
    if (!sha) return undefined;
    const v = this.map.get(this.key(repo, sha));
    if (v === undefined) this.misses++;
    else this.hits++;
    return v;
  }

  set(repo: string, sha: string | undefined, content: string): void {
    if (!sha || !/^[0-9a-f]{40}$/.test(sha)) return;
    const k = this.key(repo, sha);
    if (
      this.map.has(k) ||
      this.map.size >= this.maxEntries ||
      this.bytes + content.length > this.maxBytes
    )
      return;
    this.map.set(k, content);
    this.bytes += content.length;
  }

  private readonly parsed = new Map<string, unknown>();
  parseHits = 0;

  /**
   * Parse a blob once per run: keyed by repository, blob sha, parser id and parser version, so a changed parser (or a
   * different parser for the same bytes) never reuses a stale result. A missing sha means "no content address": no reuse.
   */
  memoParse<T>(
    repo: string,
    sha: string | undefined,
    parser: string,
    version: string,
    fn: () => T,
  ): T {
    if (!sha || !/^[0-9a-f]{40}$/.test(sha)) return fn();
    const k = `${this.key(repo, sha)}#${parser}@${version}`;
    if (this.parsed.has(k)) {
      this.parseHits++;
      return this.parsed.get(k) as T;
    }
    const v = fn();
    if (this.parsed.size < this.maxEntries) this.parsed.set(k, v);
    return v;
  }

  get size(): number {
    return this.map.size;
  }
}
