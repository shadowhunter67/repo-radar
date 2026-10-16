import type { Finding } from '../../analysis/findings.js';
import type { Fact } from '../../facts/index.js';
import type { BuildSources } from './model.js';
export function buildSourceFindings(b: BuildSources): Finding[] {
  if (b.status !== 'analyzed') return [];
  return b.files.flatMap((f, i) =>
    f.signals.includes('remote_source_unpinned') || f.signals.includes('http_url')
      ? [
          {
            id: `RR-BUILD-${String(i + 1).padStart(3, '0')}`,
            title: 'Build source is not fully pinned',
            severity: 'low' as const,
            confidence: 0.75,
            dimension: 'supply-chain' as const,
            category: 'registry' as const,
            evidence_ids: [`build:${f.path}`],
            rule_ids: [],
            standards: [],
            summary: `${f.path}: remote build source has an unpinned or insecure reference. This is an observed build configuration signal; intent is undetermined.`,
            remediation: 'Pin remote sources by commit or checksum and prefer HTTPS.',
            intent: 'undetermined' as const,
          },
        ]
      : [],
  );
}
export function deriveBuildFacts(b: BuildSources): Fact[] {
  if (b.status !== 'analyzed') return [];
  const from = b.files.map((f) => `build:${f.path}`);
  const out: Fact[] = [];
  if (b.remote_source_unpinned === true)
    out.push({
      id: 'build.remote_source_unpinned',
      value: true,
      confidence: 0.8,
      scope: 'repo',
      derived_from: from,
      derived_by: 'build-systems@0.1',
    });
  else if (b.remote_source_unpinned === false && b.files.length > 0)
    out.push({
      id: 'build.remote_source_unpinned',
      value: false,
      confidence: 0.7,
      scope: 'repo',
      derived_from: from,
      derived_by: 'build-systems@0.1',
    });
  return out;
}
