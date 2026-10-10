export interface RepoRef {
  owner: string;
  repo: string;
}

const REPO_SECTIONS = new Set([
  'tree',
  'blob',
  'issues',
  'pull',
  'pulls',
  'releases',
  'tags',
  'commits',
  'commit',
  'actions',
  'wiki',
  'security',
  'discussions',
  'projects',
  'compare',
  'network',
  'graphs',
  'pulse',
  'branches',
]);

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

export class RepoRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepoRefError';
  }
}

/** A commit SHA, tag or branch name to read files at. Validated, then percent-encoded wherever it is used. */
export function parseGitRef(input: string): string {
  const r = input.trim();
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(r) ||
    r.includes('..') ||
    r.endsWith('/') ||
    r.endsWith('.lock')
  ) {
    throw new RepoRefError('invalid --ref: use a commit SHA, tag or branch name');
  }
  return r;
}

/** Accepts `owner/repo` or a github.com URL. Anything else is rejected, never fetched. */
export function parseRepoRef(input: string): RepoRef {
  const raw = input.trim();
  let owner: string | undefined;
  let repo: string | undefined;
  if (/^https?:\/\//i.test(raw)) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new RepoRefError(`invalid URL: ${raw.slice(0, 80)}`);
    }
    if (u.protocol !== 'https:' || u.host !== 'github.com' || u.username || u.password) {
      throw new RepoRefError('only https://github.com/<owner>/<repo> URLs are supported');
    }
    const segments = u.pathname.split('/').filter(Boolean);
    // Only a bare repository URL or a known repository sub-page maps to owner/repo; anything else
    // could point somewhere other than the user intended.
    if (segments.length > 2 && !REPO_SECTIONS.has(segments[2] as string)) {
      throw new RepoRefError('unsupported GitHub URL path; use https://github.com/<owner>/<repo>');
    }
    [owner, repo] = segments;
  } else {
    const parts = raw.split('/');
    if (parts.length !== 2) throw new RepoRefError('expected owner/repo or a github.com URL');
    [owner, repo] = parts;
  }
  if (repo?.endsWith('.git')) repo = repo.slice(0, -4);
  if (
    !owner ||
    !repo ||
    !OWNER_RE.test(owner) ||
    !REPO_RE.test(repo) ||
    repo === '.' ||
    repo === '..'
  ) {
    throw new RepoRefError('invalid owner/repo');
  }
  return { owner, repo };
}
