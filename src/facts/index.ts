import { z } from 'zod';
import type { CodeAnalysis } from '../analysis/index.js';
import { CAPABILITIES, RISK_ORDER } from '../analysis/types.js';
import type { Clock } from '../evidence/builder.js';
import type { EvidenceStore } from '../evidence/store.js';
import { EvidenceIdSchema, EvidenceValueSchema, type Evidence } from '../evidence/types.js';
import { round } from '../util/text.js';

export const FACTS_VERSION = '0.1';

/**
 * A "not found" result (no secret, no persistence, capability not observed) is only evidence if the scan actually
 * saw a meaningful part of the code. Below this share of source files, absence facts are NOT emitted: the rules that
 * read them become unobserved instead of scoring "nothing found in what we did not read" as full marks.
 */
export const ABSENCE_MIN_COVERAGE = 0.2;
/** ...and at least this many code files, so one or two files never count as a clean bill of health. */
export const ABSENCE_MIN_FILES = 3;

/**
 * Normalized facts: semantic statements about the repository that rules consume instead of re-parsing
 * raw collector output. Every fact names what it was derived from (`derived_from` holds evidence ids,
 * detection ids, chain ids, hook ids or secret-candidate ids that all appear in the report).
 *
 * Families: repo.* artifact.* ci.* capability.* execution.* persistence.* secret.* scan.*
 */
export const FactSchema = z.object({
  id: EvidenceIdSchema,
  value: EvidenceValueSchema,
  /** How sure we are of the fact. "Not observed" facts carry reduced confidence, scaled by scan coverage. */
  confidence: z.number().min(0).max(1),
  scope: z.enum([
    'repo',
    'artifact',
    'ci',
    'capability',
    'execution',
    'secret',
    'scan',
    'dependency',
  ]),
  derived_from: z.array(z.string()),
  derived_by: z.string(),
});
export type Fact = z.infer<typeof FactSchema>;

/** Confidence that something is really absent, given the share of source files that were scanned. */
export const notObservedConfidence = (coverage: number): number =>
  round(0.3 + 0.5 * Math.max(0, Math.min(1, coverage)), 2);

export interface FactInput {
  store: EvidenceStore;
  code: CodeAnalysis;
  artifact: { type: string; confidence: number };
}

export function deriveFacts(input: FactInput): Fact[] {
  const { store, code, artifact } = input;
  const facts: Fact[] = [];
  const push = (f: Fact): void => void facts.push(f);

  push({
    id: 'artifact.type',
    value: artifact.type,
    confidence: artifact.confidence,
    scope: 'artifact',
    derived_from: ['identity.canonical_type'],
    derived_by: 'artifact-classifier@0.1',
  });

  // Migration seam: CI facts re-expose workflow evidence under a stable semantic name, so rules (and
  // future non-GitHub CI collectors) do not depend on the GitHub-specific evidence id.
  const mirror = (factId: string, evId: string): void => {
    const e = store.get(evId);
    if (e)
      push({
        id: factId,
        value: e.value,
        confidence: e.confidence,
        scope: 'ci',
        derived_from: [e.id],
        derived_by: 'ci-normalizer@0.1',
      });
  };
  mirror('ci.permissions.declared_ratio', 'github.workflows.permissions_declared_ratio');
  mirror('ci.actions.pinned_ratio', 'github.workflows.pinned_actions_ratio');

  if (!code.scan.performed) return facts;

  const cov = code.scan.source_coverage;
  const absent = notObservedConfidence(cov);
  const absenceReliable =
    cov >= ABSENCE_MIN_COVERAGE && code.scan.source_files_scanned >= ABSENCE_MIN_FILES;
  const scanFact = (id: string, value: number | boolean): void =>
    push({ id, value, confidence: 1, scope: 'scan', derived_from: [], derived_by: 'scan@0.1' });
  scanFact('scan.source_coverage', round(code.scan.source_coverage, 3));
  scanFact('scan.files_scanned', code.scan.files_scanned);
  scanFact('scan.absence_reliable', absenceReliable);

  /** "Not found" facts are emitted only when the scan saw enough code (see ABSENCE_MIN_COVERAGE). */
  const gated = (f: Fact, isAbsence: boolean): void => {
    if (!isAbsence || absenceReliable) push(f);
  };

  for (const s of code.capabilities.summary) {
    const key = `capability.${s.capability.toLowerCase()}`;
    const ids = code.capabilities.detections
      .filter((d) => d.capability === s.capability)
      .slice(0, 10)
      .map((d) => d.id);
    const conf = s.observed ? s.confidence : absent;
    const base = {
      confidence: conf,
      scope: 'capability' as const,
      derived_from: ids,
      derived_by: 'capability-detectors@0.1',
    };
    gated({ id: `${key}.observed`, value: s.observed, ...base }, !s.observed);
    gated(
      { id: `${key}.install_time`, value: s.contexts.includes('install'), ...base },
      !s.contexts.includes('install'),
    );
  }

  const hooks = code.execution.hooks;
  const dependentHooks = hooks.filter((h) => h.runs_for_dependents);
  const hookRisk = dependentHooks.reduce((m, h) => Math.max(m, RISK_ORDER[h.risk]), 0);
  // Hooks come from manifests and build files selected by name from the full git tree, so they do not
  // depend on how much of the source was sampled.
  push({
    id: 'execution.install_hooks.count',
    value: hooks.length,
    confidence: 0.9,
    scope: 'execution',
    derived_from: hooks.map((h) => h.id),
    derived_by: 'execution-graph@0.1',
  });
  push({
    id: 'execution.install_hooks.max_risk',
    value: hookRisk,
    confidence:
      dependentHooks.length > 0 ? Math.max(...dependentHooks.map((h) => h.confidence)) : 0.9,
    scope: 'execution',
    derived_from: dependentHooks.map((h) => h.id),
    derived_by: 'execution-graph@0.1',
  });
  const ex = code.execution;
  push({
    id: 'execution.entrypoints.count',
    value: ex.entrypoints.length,
    confidence: 0.9,
    scope: 'execution',
    derived_from: ex.entrypoints.map((e) => e.id).slice(0, 10),
    derived_by: 'execution-graph@0.2',
  });
  push({
    id: 'execution.build.repository_code',
    value: ex.projects.some((p) => p.repository_code_runs),
    confidence: 0.85,
    scope: 'execution',
    derived_from: ex.projects
      .filter((p) => p.repository_code_runs)
      .flatMap((p) => p.hook_ids)
      .slice(0, 10),
    derived_by: 'execution-graph@0.2',
  });
  push({
    id: 'execution.native_build.present',
    value: ex.projects.some((p) => p.native_build_systems.length > 0),
    confidence: 0.8,
    scope: 'execution',
    derived_from: ex.hooks
      .filter((h) => h.stage === 'NATIVE_BUILD')
      .map((h) => h.id)
      .slice(0, 10),
    derived_by: 'execution-graph@0.2',
  });
  const chains = code.execution.chains;
  const installChains = chains.filter((c) => c.contexts.includes('install'));
  gated(
    {
      id: 'execution.chain.any',
      value: chains.length > 0,
      confidence: chains.length > 0 ? Math.max(...chains.map((c) => c.confidence)) : absent,
      scope: 'execution',
      derived_from: chains.map((c) => c.id),
      derived_by: 'chain-detector@0.1',
    },
    chains.length === 0,
  );
  gated(
    {
      id: 'execution.chain.install_time',
      value: installChains.length > 0,
      confidence:
        installChains.length > 0 ? Math.max(...installChains.map((c) => c.confidence)) : absent,
      scope: 'execution',
      derived_from: installChains.map((c) => c.id),
      derived_by: 'chain-detector@0.1',
    },
    installChains.length === 0,
  );

  const p = code.persistence;
  const pIds = code.capabilities.detections
    .filter((d) => d.persistence_kind)
    .slice(0, 10)
    .map((d) => d.id);
  const pBase = {
    confidence: p.observed ? 0.8 : absent,
    scope: 'capability' as const,
    derived_from: pIds,
    derived_by: 'capability-detectors@0.1',
  };
  gated({ id: 'persistence.observed', value: p.observed, ...pBase }, !p.observed);
  gated({ id: 'persistence.install_time', value: p.install_time, ...pBase }, !p.install_time);
  gated({ id: 'persistence.kinds', value: p.kinds, ...pBase }, p.kinds.length === 0);

  // Secret scanning only sees fetched files: a count of 0 means "none found in what was read".
  const sc = code.secrets.scored_count;
  gated(
    {
      id: 'secret.candidates.count',
      value: sc,
      confidence: sc > 0 ? 0.85 : absent,
      scope: 'secret',
      derived_from: code.secrets.candidates
        .filter((c) => c.mode === 'DIRECT' && !c.in_test_or_example)
        .map((c) => c.id),
      derived_by: 'secret-scanner@0.1',
    },
    sc === 0,
  );

  return facts;
}

/** Facts enter scoring as evidence of source `derived`; the report keeps them in a separate `facts` list. */
export function factToEvidence(f: Fact, clock: Clock): Evidence {
  return {
    id: f.id,
    value: f.value,
    source: 'derived',
    kind: 'fact',
    observed_at: clock.now().toISOString(),
    confidence: f.confidence,
    provenance: { method: f.derived_by },
    metadata: { derived_from: f.derived_from },
  };
}

export const FACT_CAPABILITY_IDS = CAPABILITIES.map(
  (c) => `capability.${c.toLowerCase()}.observed`,
);
