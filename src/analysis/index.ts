import { z } from 'zod';
import type { ParsedManifest } from '../collectors/manifests/parse.js';
import { LIMITS } from '../limits.js';
import {
  ExecEdgeSchema,
  ExecNodeSchema,
  HookSchema,
  analyzeExecution,
  chainKey,
} from './execution.js';
import { fileKind } from './detectors.js';
import { scanFile, type FileScan } from './scan.js';
import { scanSecretsInFile, secretFilenameCandidates } from './secrets.js';
import {
  CAPABILITIES,
  CAPABILITY_RISK,
  ChainSchema,
  DetectionSchema,
  PERSISTENCE_KINDS,
  RISK_ORDER,
  SecretCandidateSchema,
  type Capability,
  type Chain,
  type Detection,
  type ExecContext,
  type RiskLevel,
  type ScannedFile,
  type SecretCandidate,
} from './types.js';

export const CapabilitySummarySchema = z.object({
  capability: z.enum(CAPABILITIES),
  observed: z.boolean(),
  /** Strongest detection mode among observations; null when nothing was observed. */
  mode: z.enum(['DIRECT', 'INFERRED', 'POSSIBLE']).nullable(),
  risk: z.enum(['none', 'low', 'medium', 'high']),
  confidence: z.number().min(0).max(1),
  count: z.number(),
  contexts: z.array(z.enum(['install', 'build', 'runtime'])),
  files: z.array(z.string()),
});
export type CapabilitySummary = z.infer<typeof CapabilitySummarySchema>;

export const CodeAnalysisSchema = z.object({
  scan: z.object({
    performed: z.boolean(),
    files_scanned: z.number(),
    source_files_scanned: z.number(),
    source_files_total: z.number(),
    /** source_files_scanned / source_files_total (a sample; "not observed" is only valid inside it). */
    source_coverage: z.number().min(0).max(1),
    skipped_too_large: z.number(),
    skipped_over_budget: z.number(),
    limits_hit: z.array(z.string()),
  }),
  capabilities: z.object({
    summary: z.array(CapabilitySummarySchema),
    detections: z.array(DetectionSchema),
    detections_total: z.number(),
  }),
  persistence: z.object({
    observed: z.boolean(),
    kinds: z.array(z.enum(PERSISTENCE_KINDS)),
    install_time: z.boolean(),
  }),
  execution: z.object({
    hooks: z.array(HookSchema),
    chains: z.array(ChainSchema),
    graph: z.object({
      nodes: z.array(ExecNodeSchema),
      edges: z.array(ExecEdgeSchema),
      truncated: z.boolean(),
    }),
  }),
  secrets: z.object({
    candidates: z.array(SecretCandidateSchema),
    /** DIRECT candidates outside tests/examples: the number used for scoring. */
    scored_count: z.number(),
    files_scanned: z.number(),
  }),
});
export type CodeAnalysis = z.infer<typeof CodeAnalysisSchema>;

export interface FetchStats {
  skippedTooLarge: number;
  skippedOverBudget: number;
}

export interface CodeAnalysisInput {
  manifests: ParsedManifest[];
  files: ScannedFile[];
  treePaths: string[];
  sourceFilesTotal: number;
  fetch: FetchStats;
}

const MODE_ORDER = { DIRECT: 3, INFERRED: 2, POSSIBLE: 1 } as const;

export function emptyCodeAnalysis(): CodeAnalysis {
  return {
    scan: {
      performed: false,
      files_scanned: 0,
      source_files_scanned: 0,
      source_files_total: 0,
      source_coverage: 0,
      skipped_too_large: 0,
      skipped_over_budget: 0,
      limits_hit: [],
    },
    capabilities: {
      summary: CAPABILITIES.map((c) => ({
        capability: c,
        observed: false,
        mode: null,
        risk: 'none',
        confidence: 0,
        count: 0,
        contexts: [],
        files: [],
      })),
      detections: [],
      detections_total: 0,
    },
    persistence: { observed: false, kinds: [], install_time: false },
    execution: { hooks: [], chains: [], graph: { nodes: [], edges: [], truncated: false } },
    secrets: { candidates: [], scored_count: 0, files_scanned: 0 },
  };
}

const CODE_ROLES = new Set(['script', 'ref', 'build', 'source', 'config']);

export function analyzeCode(input: CodeAnalysisInput): CodeAnalysis {
  const tree = new Set(input.treePaths);
  const exec = analyzeExecution({ manifests: input.manifests, files: input.files, tree });
  const scans = new Map<string, FileScan>(exec.scans);
  const limitsHit: string[] = [];

  for (const f of input.files) {
    if (!CODE_ROLES.has(f.role) || scans.has(f.path)) continue;
    scans.set(f.path, scanFile(f));
  }

  const roleOf = new Map(input.files.map((f) => [f.path, f.role]));
  const contextsFor = (path: string): ExecContext[] => {
    const fromGraph = exec.fileContexts.get(path);
    if (fromGraph && fromGraph.size > 0) return [...fromGraph].sort();
    const role = roleOf.get(path);
    if (role === 'build' || role === 'config') return ['build'];
    return ['runtime'];
  };

  // Detections (capped, deterministic order).
  const all: Omit<Detection, 'id'>[] = [];
  const chainsRaw: (Omit<Chain, 'id'> & { key: string })[] = [];
  for (const [path, s] of [...scans.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (s.truncated) limitsHit.push(`lines truncated in ${path}`);
    const contexts = contextsFor(path);
    for (const d of s.detections) all.push({ ...d, contexts });
    for (const c of s.chains)
      chainsRaw.push({ ...c, contexts, key: chainKey(path, c.kind, c.lines) });
  }
  const detectionsTotal = all.length;
  if (detectionsTotal > LIMITS.maxDetections)
    limitsHit.push(`detections capped at ${LIMITS.maxDetections} of ${detectionsTotal}`);
  // When capping, keep the first few detections of EVERY capability first, so a capability that is reported
  // as observed always has detection ids to trace back to; then fill the rest in deterministic order.
  const keep = new Set<number>();
  const perCapability = new Map<string, number>();
  all.forEach((d, i) => {
    const n = perCapability.get(d.capability) ?? 0;
    if (n < 3 && keep.size < LIMITS.maxDetections) {
      keep.add(i);
      perCapability.set(d.capability, n + 1);
    }
  });
  for (let i = 0; i < all.length && keep.size < LIMITS.maxDetections; i++) keep.add(i);
  const detections: Detection[] = all
    .filter((_, i) => keep.has(i))
    .map((d, i) => ({ id: `CAP-${String(i + 1).padStart(4, '0')}`, ...d }));
  const chainIdByKey = new Map<string, string>();
  const chains: Chain[] = chainsRaw.map((c, i) => {
    const id = `CHAIN-${String(i + 1).padStart(3, '0')}`;
    chainIdByKey.set(c.key, id);
    const { key: _key, ...rest } = c;
    void _key;
    return { id, ...rest };
  });
  for (const h of exec.hooks) h.chain_ids = h.chain_ids.map((k) => chainIdByKey.get(k) ?? k);
  if (exec.truncated) limitsHit.push(`execution graph capped at ${LIMITS.maxGraphNodes} nodes`);

  // Capability summary (every capability is listed so "not observed" is explicit).
  const summary: CapabilitySummary[] = CAPABILITIES.map((cap) => {
    let ds = all.filter((d) => d.capability === cap);
    // Downloading from a remote host implies a network client, even where no client library is named.
    if (cap === 'NETWORK_CLIENT' && ds.length === 0) {
      ds = all
        .filter((d) => d.capability === 'REMOTE_DOWNLOAD' && d.mode !== 'POSSIBLE')
        .map((d) => ({
          ...d,
          mode: 'INFERRED' as const,
          confidence: Math.round(d.confidence * 80) / 100,
        }));
    }
    if (ds.length === 0)
      return {
        capability: cap,
        observed: false,
        mode: null,
        risk: 'none',
        confidence: 0,
        count: 0,
        contexts: [],
        files: [],
      };
    const best = ds.reduce((a, b) =>
      MODE_ORDER[b.mode] > MODE_ORDER[a.mode] || (b.mode === a.mode && b.confidence > a.confidence)
        ? b
        : a,
    );
    const contexts = [...new Set(ds.flatMap((d) => d.contexts))].sort() as ExecContext[];
    let risk: RiskLevel = best.mode === 'POSSIBLE' ? 'low' : CAPABILITY_RISK[cap];
    // The same capability matters more when it can run at install time.
    if (
      contexts.includes('install') &&
      best.mode !== 'POSSIBLE' &&
      RISK_ORDER[risk] < 3 &&
      RISK_ORDER[risk] >= 2
    )
      risk = 'high';
    return {
      capability: cap,
      observed: true,
      mode: best.mode,
      risk,
      confidence: best.confidence,
      count: ds.length,
      contexts,
      files: [...new Set(ds.map((d) => d.file))].slice(0, 5),
    };
  });

  const persistDs = all.filter(
    (d) =>
      d.persistence_kind &&
      d.mode !== 'POSSIBLE' &&
      (d.capability === 'PERSISTENCE' || d.capability === 'BACKGROUND_PROCESS'),
  );
  const persistence = {
    observed: persistDs.some((d) => d.capability === 'PERSISTENCE'),
    kinds: [
      ...new Set(persistDs.map((d) => d.persistence_kind as (typeof PERSISTENCE_KINDS)[number])),
    ].sort(),
    install_time: persistDs.some((d) => d.contexts.includes('install')),
  };

  // Secrets: every fetched file (including workflows and manifests) plus file-name-only candidates.
  const secretCandidates: SecretCandidate[] = [];
  const counter = { n: 0 };
  for (const f of input.files) scanSecretsInFile(f, secretCandidates, counter);
  secretFilenameCandidates(input.treePaths, secretCandidates, counter);
  if (secretCandidates.length >= LIMITS.maxSecretCandidates)
    limitsHit.push(`secret candidates capped at ${LIMITS.maxSecretCandidates}`);

  const sourceScanned = input.files.filter(
    (f) => CODE_ROLES.has(f.role) && ['js', 'py', 'go', 'rs', 'sh'].includes(fileKind(f.path)),
  ).length;
  if (input.fetch.skippedTooLarge > 0)
    limitsHit.push(
      `${input.fetch.skippedTooLarge} file(s) skipped: larger than ${LIMITS.maxScanFileBytes} bytes`,
    );
  if (input.fetch.skippedOverBudget > 0)
    limitsHit.push(
      `${input.fetch.skippedOverBudget} candidate file(s) not fetched: scan budget reached`,
    );

  return {
    scan: {
      performed: true,
      files_scanned: input.files.length,
      source_files_scanned: sourceScanned,
      source_files_total: input.sourceFilesTotal,
      source_coverage:
        input.sourceFilesTotal > 0
          ? Math.min(1, sourceScanned / input.sourceFilesTotal)
          : input.files.length > 0
            ? 1
            : 0,
      skipped_too_large: input.fetch.skippedTooLarge,
      skipped_over_budget: input.fetch.skippedOverBudget,
      limits_hit: limitsHit,
    },
    capabilities: { summary, detections, detections_total: detectionsTotal },
    persistence,
    execution: {
      hooks: exec.hooks,
      chains,
      graph: { nodes: exec.nodes, edges: exec.edges, truncated: exec.truncated },
    },
    secrets: {
      candidates: secretCandidates,
      scored_count: secretCandidates.filter((c) => c.mode === 'DIRECT' && !c.in_test_or_example)
        .length,
      files_scanned: input.files.length,
    },
  };
}

export type { Capability };
