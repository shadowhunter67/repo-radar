import { readFileSync } from 'node:fs';
import { analyzeRepository, type AnalyzeOptions } from './analyze.js';
import { FsSnapshotStore } from './store/snapshots.js';
import { parseRepoRef, type RepoRef } from './util/repo-ref.js';
import type { Report } from './report/schema.js';
import { HttpClient } from './util/http.js';
import { GITHUB_HOSTS } from './collectors/github/collector.js';

export interface BatchOptions extends AnalyzeOptions {
  listFile: string;
  snapshotDir?: string;
  orgSummary?: boolean;
  maxRepos?: number;
  maxRequests?: number;
  maxMinutes?: number;
  maxBytes?: number;
  maxSnapshotReads?: number;
}
export interface BatchResult {
  requested: number;
  analyzed: number;
  reused: number;
  refreshed: number;
  incomplete: number;
  failed: number;
  critical_findings: number;
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
  freshness: Record<
    string,
    | 'snapshot_exact_match'
    | 'snapshot_stale'
    | 'snapshot_missing'
    | 'snapshot_incompatible'
    | 'snapshot_conflict'
  >;
}

const safeError = (e: unknown): string =>
  e instanceof Error ? e.message.slice(0, 200) : 'analysis failed';
export function readBatchList(path: string): RepoRef[] {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const at = x.lastIndexOf('@');
      if (at > x.indexOf('/') && /^[0-9a-f]{40}$/i.test(x.slice(at + 1)))
        return { ...parseRepoRef(x.slice(0, at)), ref: x.slice(at + 1).toLowerCase() };
      return parseRepoRef(x);
    });
}
export async function runBatch(options: BatchOptions): Promise<BatchResult> {
  const refs = readBatchList(options.listFile);
  const max = Math.min(options.maxRepos ?? 25, 25);
  const started = Date.now();
  const out: BatchResult = {
    requested: Math.min(refs.length, max),
    analyzed: 0,
    reused: 0,
    refreshed: 0,
    incomplete: 0,
    failed: 0,
    critical_findings: 0,
    repositories: { analyzed: [], reused: [], failed: [], incomplete: [] },
    policy_failures: 0,
    high_findings: 0,
    medium_findings: 0,
    new_temporal_indicators: 0,
    unverified_provenance: 0,
    dependency_publisher_changes: 0,
    install_context_domains: [],
    stopped_by: null,
    freshness: {},
  };
  const store = options.snapshotDir ? new FsSnapshotStore(options.snapshotDir) : undefined;
  let requests = 0;
  let bytes = 0;
  let snapshotReads = 0;
  let exceeded: string | null = null;
  class BatchBudgetError extends Error {
    constructor(readonly reason: string) {
      super(reason);
    }
  }
  const fetchWithBudget = options.fetch
    ? async (url: string, init?: RequestInit): Promise<Response> => {
        if (options.maxRequests !== undefined && requests >= options.maxRequests)
          throw ((exceeded = 'max_requests'), new BatchBudgetError('max_requests'));
        if (options.maxMinutes !== undefined && Date.now() - started >= options.maxMinutes * 60_000)
          throw ((exceeded = 'max_minutes'), new BatchBudgetError('max_minutes'));
        requests++;
        const response = await options.fetch!(url, init);
        if (options.maxBytes !== undefined) {
          const measured = await response.clone().arrayBuffer();
          bytes += measured.byteLength;
          if (bytes > options.maxBytes)
            throw ((exceeded = 'max_bytes'), new BatchBudgetError('max_bytes'));
        }
        return response;
      }
    : undefined;
  const headHttp = new HttpClient({
    allowedHosts: GITHUB_HOSTS,
    token: options.token,
    ...(fetchWithBudget ? { fetch: fetchWithBudget } : {}),
  });
  const compatible = (report: Report): boolean => {
    const f = report.analysis_manifest.feature_flags;
    const wanted: Record<string, boolean> = {
      verify_crypto: options.verifyCrypto === true,
      dependency_artifacts: options.inspectDependencyArtifacts === true,
      compliance: options.compliance !== false,
      dependency_attestations:
        options.dependencyRegistry !== false &&
        options.registry !== false &&
        options.dependencyRegistryBudget?.maxAttestations !== 0,
      registry: options.registry !== false,
      name_intelligence: options.nameIntelligence === true,
      trusted_root_identity: !!options.trust?.expectedIdentity,
    };
    return Object.entries(wanted).every(([k, v]) => f[k] === v);
  };
  const work = refs.slice(0, max);
  for (const [index, ref] of work.entries()) {
    if (options.maxMinutes !== undefined && Date.now() - started >= options.maxMinutes * 60_000) {
      out.stopped_by = 'max_minutes';
      const rest = work.slice(index).map((r) => `${r.owner}/${r.repo}`);
      out.repositories.incomplete.push(...rest);
      out.incomplete += rest.length;
      break;
    }
    if (options.maxRequests !== undefined && requests >= options.maxRequests) {
      out.stopped_by = 'max_requests';
      const rest = work.slice(index).map((r) => `${r.owner}/${r.repo}`);
      out.repositories.incomplete.push(...rest);
      out.incomplete += rest.length;
      break;
    }
    const name = `${ref.owner}/${ref.repo}`;
    try {
      const immutable = !!ref.ref;
      let head: string | undefined;
      if (
        store &&
        options.maxSnapshotReads !== undefined &&
        snapshotReads >= options.maxSnapshotReads
      )
        throw new BatchBudgetError('max_snapshot_reads');
      if (!immutable && store) {
        const response = await headHttp.request(
          `https://api.github.com/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/commits?per_page=1`,
          { maxBytes: 64 * 1024 },
        );
        const parsed = JSON.parse(response.body) as { sha?: unknown }[];
        head = typeof parsed[0]?.sha === 'string' ? parsed[0].sha : undefined;
        if (!head || !/^[0-9a-f]{40}$/i.test(head))
          throw new Error('head resolution did not return a full commit SHA');
      }
      const expectedCommit = ref.ref ?? head;
      const existing = store?.listSnapshots({
        repository: name.toLowerCase(),
        ...(expectedCommit ? { commit: expectedCommit } : {}),
        limit: 1,
      })[0];
      if (store) snapshotReads++;
      if (store) {
        const anySnapshot =
          store.listSnapshots({ repository: name.toLowerCase(), limit: 1 }).length > 0;
        let existingCompatible = false;
        if (existing) {
          if (options.maxSnapshotReads !== undefined && snapshotReads >= options.maxSnapshotReads)
            throw new BatchBudgetError('max_snapshot_reads');
          snapshotReads++;
          const candidate = store.getSnapshot(existing);
          existingCompatible = 'report' in candidate && compatible(candidate.report);
        }
        out.freshness[name] = existingCompatible
          ? 'snapshot_exact_match'
          : existing
            ? 'snapshot_incompatible'
            : anySnapshot && head
              ? 'snapshot_stale'
              : 'snapshot_missing';
      }
      let report: Report;
      if (existing && store && out.freshness[name] === 'snapshot_exact_match') {
        const got = store.getSnapshot(existing);
        if ('report' in got) {
          report = got.report;
          out.repositories.reused.push(name);
          out.reused++;
        } else throw new Error(got.error);
      } else {
        report = await analyzeRepository(name, {
          ...options,
          ...(fetchWithBudget ? { fetch: fetchWithBudget } : {}),
          ...(ref.ref ? { ref: ref.ref } : {}),
        });
        if (exceeded) {
          out.stopped_by = exceeded;
          out.repositories.incomplete.push(name);
          out.incomplete++;
          break;
        }
        out.repositories.analyzed.push(name);
        out.analyzed++;
        if (existing) out.refreshed++;
        const stored = store?.putSnapshot(report);
        if (stored?.status === 'conflict') out.freshness[name] = 'snapshot_conflict';
      }
      if (report.policy.violations.length || report.policy.block_violations.length)
        out.policy_failures++;
      out.high_findings += report.findings.filter((f) => f.severity === 'high').length;
      // The report vocabulary has no critical severity; retain an explicit zero for the batch contract.
      out.critical_findings += 0;
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
      const budgetReason =
        exceeded ??
        (e instanceof BatchBudgetError
          ? e.reason
          : e instanceof Error &&
              /^(max_requests|max_minutes|max_bytes|max_snapshot_reads)$/.test(e.message)
            ? e.message
            : null);
      if (budgetReason) {
        out.stopped_by = budgetReason;
        out.repositories.incomplete.push(name);
        out.incomplete++;
        break;
      }
      out.repositories.failed.push({ repository: name, error: safeError(e) });
      out.failed++;
    }
  }
  if (!out.stopped_by && refs.length > max) out.stopped_by = 'max_repos';
  return out;
}
