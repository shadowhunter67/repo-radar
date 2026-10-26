import type { Report } from '../report/schema.js';
export function errorBody(code: string, message: string) {
  return { error: { code, message } };
}
export function reportFilename(owner: string, repo: string, sha: string): string {
  const clean = (s: string) => s.replace(/^\.+/, '_').replace(/[^A-Za-z0-9_-]/g, '_');
  return `repo-radar-${clean(owner)}-${clean(repo)}-${sha.replace(/[^a-fA-F0-9]/g, '').slice(0, 12) || 'unknown'}.json`;
}
export function reportSha(report: Report): string {
  const r = report as unknown as {
    analysis_manifest?: { commit?: unknown };
    subject?: { ref?: unknown; revision_kind?: unknown };
  };
  const commit = typeof r.analysis_manifest?.commit === 'string' ? r.analysis_manifest.commit : '';
  if (/^[a-f0-9]{40}$/i.test(commit)) return commit;
  const ref = r.subject?.ref;
  return r.subject?.revision_kind === 'immutable' &&
    typeof ref === 'string' &&
    /^[a-f0-9]{40}$/i.test(ref)
    ? ref
    : '';
}
