import type { Report } from '../report/schema.js';
export function errorBody(code: string, message: string) {
  return { error: { code, message } };
}
export function reportFilename(owner: string, repo: string, sha: string): string {
  const clean = (s: string) => s.replace(/^\.+/, '_').replace(/[^A-Za-z0-9_-]/g, '_');
  return `repo-radar-${clean(owner)}-${clean(repo)}-${sha.replace(/[^a-fA-F0-9]/g, '').slice(0, 12) || 'unknown'}.json`;
}
export function reportSha(report: Report): string {
  const r = report as unknown as Record<string, unknown>;
  return String(r.repository_sha ?? r.commit_sha ?? r.analyzed_sha ?? '');
}
