import { readFileSync } from 'node:fs';
import { analyzeRepository, type AnalyzeOptions } from './analyze.js';
import { FsSnapshotStore } from './store/snapshots.js';
import { parseRepoRef, type RepoRef } from './util/repo-ref.js';
import type { Report } from './report/schema.js';

export interface BatchOptions extends AnalyzeOptions {
  listFile: string;
  snapshotDir?: string;
  orgSummary?: boolean;
  maxRepos?: number;
  maxRequests?: number;
  maxMinutes?: number;
}
export interface BatchResult {
  repositories: {
    analyzed: string[];
    reused: string[];
    failed: { repository: string; error: string }[];
    incomplete: string[];
  };
  policy_failures: number;
  high_findings: number;
  medium_findings: number;
  new_temporal_indicators: number;
  unverified_provenance: number;
  dependency_publisher_changes: number;
  install_context_domains: string[];
  stopped_by: string | null;
}

const safeError = (e: unknown): string =>
  e instanceof Error ? e.message.slice(0, 200) : 'analysis failed';
export function readBatchList(path: string): RepoRef[] {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => parseRepoRef(x));
}
export async function runBatch(options: BatchOptions): Promise<BatchResult> {
  const refs = readBatchList(options.listFile);
  const max = Math.min(options.maxRepos ?? 25, 25);
  const started = Date.now();
  const out: BatchResult = {
    repositories: { analyzed: [], reused: [], failed: [], incomplete: [] },
    policy_failures: 0,
    high_findings: 0,
    medium_findings: 0,
    new_temporal_indicators: 0,
    unverified_provenance: 0,
    dependency_publisher_changes: 0,
    install_context_domains: [],
    stopped_by: null,
  };
  const store = options.snapshotDir ? new FsSnapshotStore(options.snapshotDir) : undefined;
  for (const ref of refs.slice(0, max)) {
    if (options.maxMinutes !== undefined && Date.now() - started >= options.maxMinutes * 60_000) {
      out.stopped_by = 'max_minutes';
      break;
    }
    if (
      options.maxRequests !== undefined &&
      out.repositories.analyzed.length >= options.maxRequests
    ) {
      out.stopped_by = 'max_requests';
      break;
    }
    const name = `${ref.owner}/${ref.repo}`;
    try {
      const existing = store?.listSnapshots({ repository: name.toLowerCase(), limit: 1 })[0];
      let report: Report;
      if (existing && store) {
        const got = store.getSnapshot(existing);
        if ('report' in got) {
          report = got.report;
          out.repositories.reused.push(name);
        } else throw new Error(got.error);
      } else {
        report = await analyzeRepository(name, options);
        out.repositories.analyzed.push(name);
        store?.putSnapshot(report);
      }
      if (report.policy.violations.length || report.policy.block_violations.length)
        out.policy_failures++;
      out.high_findings += report.findings.filter((f) => f.severity === 'high').length;
      out.medium_findings += report.findings.filter((f) => f.severity === 'medium').length;
      out.new_temporal_indicators += report.timeline.correlations.length;
      out.unverified_provenance += report.dependency_registry_intel.packages.filter((p) =>
        Object.values(p.attestation_states).some((s) => s === 'provenance_present_unverified'),
      ).length;
      out.dependency_publisher_changes += report.dependency_registry_intel.events.filter(
        (e) => e.type === 'dependency_publisher_changed',
      ).length;
      for (const a of report.dependency_artifacts.artifacts)
        for (const d of a.domains)
          if (!out.install_context_domains.includes(d)) out.install_context_domains.push(d);
    } catch (e) {
      out.repositories.failed.push({ repository: name, error: safeError(e) });
    }
  }
  if (!out.stopped_by && refs.length > max) out.stopped_by = 'max_repos';
  return out;
}
