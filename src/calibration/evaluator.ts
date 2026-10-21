import { calculateBinaryMetrics, type BinaryMetricRow, type BinaryMetrics } from './metrics.js';

export const INCIDENT_MECHANISMS = [
  'publisher_control_change',
  'new_dependency_introduction',
  'artifact_behavior_change',
  'install_hook_abuse',
  'external_domain_introduction',
  'provenance_loss',
  'source_code_semantic_sabotage',
  'credential_theft',
  'unknown',
] as const;
export type IncidentMechanism = (typeof INCIDENT_MECHANISMS)[number];
export type LabelStatus =
  'known_incident' | 'known_benign' | 'ambiguous' | 'disputed' | 'insufficient_evidence';
export type Evaluability =
  | 'evaluable_positive'
  | 'evaluable_negative'
  | 'not_evaluable'
  | 'ambiguous_label'
  | 'not_applicable_to_detector';
export interface DetectorApplicability {
  required_evidence: readonly string[];
  applicable_mechanisms: readonly IncidentMechanism[];
  out_of_scope_mechanisms: readonly IncidentMechanism[];
}
export interface EvaluabilityResult {
  label_status: LabelStatus;
  evaluability: Evaluability;
  reason: string;
  truth: boolean | null;
}
export interface EvaluatorCase {
  label_status: LabelStatus;
  incident_mechanism: IncidentMechanism;
  synthetic?: boolean;
  artifact_available: boolean;
  artifact_provenance_verified: boolean;
  registry_history_available: boolean;
  dependency_history_available: boolean;
  behavioral_delta_available: boolean;
}
export const evaluateCase = (
  c: EvaluatorCase,
  detector: DetectorApplicability,
): EvaluabilityResult => {
  if (c.synthetic)
    return {
      label_status: c.label_status,
      evaluability: 'not_evaluable',
      reason: 'synthetic_functional_coverage',
      truth: null,
    };
  if (c.label_status === 'ambiguous' || c.label_status === 'disputed')
    return {
      label_status: c.label_status,
      evaluability: 'ambiguous_label',
      reason: `${c.label_status}_label`,
      truth: null,
    };
  if (
    detector.out_of_scope_mechanisms.includes(c.incident_mechanism) &&
    c.incident_mechanism !== 'unknown'
  )
    return {
      label_status: c.label_status,
      evaluability: 'not_applicable_to_detector',
      reason: 'mechanism_out_of_scope',
      truth: null,
    };
  if (c.label_status === 'insufficient_evidence')
    return {
      label_status: c.label_status,
      evaluability: 'not_evaluable',
      reason: 'insufficient_incident_evidence',
      truth: null,
    };
  if (!c.artifact_available)
    return {
      label_status: c.label_status,
      evaluability: 'not_evaluable',
      reason: 'artifact_unavailable',
      truth: null,
    };
  if (!c.artifact_provenance_verified)
    return {
      label_status: c.label_status,
      evaluability: 'not_evaluable',
      reason: 'artifact_provenance_unverified',
      truth: null,
    };
  if (c.label_status === 'known_incident')
    return {
      label_status: c.label_status,
      evaluability: 'evaluable_positive',
      reason: 'verified_artifact_and_settled_incident_label',
      truth: true,
    };
  return {
    label_status: c.label_status,
    evaluability: 'evaluable_negative',
    reason: 'verified_artifact_and_settled_benign_label',
    truth: false,
  };
};
export interface EvaluatorSummary {
  total: number;
  evaluable: number;
  not_evaluable: number;
  ambiguous: number;
  not_applicable: number;
  by_reason: Record<string, number>;
  metrics: BinaryMetrics;
  sample_note: string | null;
  synthetic_functional_coverage: number;
}
export function summarizeEvaluator(
  rows: readonly { result: EvaluabilityResult; observed: boolean | null; synthetic?: boolean }[],
): EvaluatorSummary {
  const metricRows: BinaryMetricRow[] = [];
  const byReason: Record<string, number> = {};
  let evaluable = 0,
    notEvaluable = 0,
    ambiguous = 0,
    notApplicable = 0,
    synthetic = 0;
  for (const row of rows) {
    if (row.synthetic) {
      synthetic++;
      continue;
    }
    const r = row.result;
    if (r.evaluability === 'evaluable_positive' || r.evaluability === 'evaluable_negative') {
      evaluable++;
      metricRows.push({ expected: r.truth, observed: row.observed });
    } else if (r.evaluability === 'ambiguous_label') ambiguous++;
    else if (r.evaluability === 'not_applicable_to_detector') notApplicable++;
    else notEvaluable++;
    byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
  }
  const metrics = calculateBinaryMetrics(metricRows);
  const sample = evaluable < 5 ? 'sample insufficient: fewer than 5 evaluable cases' : null;
  return {
    total: rows.length,
    evaluable,
    not_evaluable: notEvaluable,
    ambiguous,
    not_applicable: notApplicable,
    by_reason: byReason,
    metrics,
    sample_note: sample,
    synthetic_functional_coverage: synthetic,
  };
}
