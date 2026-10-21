import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { evaluateCase, summarizeEvaluator } from '../dist/calibration/evaluator.js';

const source = resolve('calibration/incidents-v3/results/final-holdout-v3.json');
const original = readFileSync(source);
const file = JSON.parse(original);
const rows = (file.cases ?? []).map((row) => {
  const result = evaluateCase(
    {
      label_status: row.label ?? 'insufficient_evidence',
      incident_mechanism: row.incident_mechanism ?? 'unknown',
      synthetic: false,
      artifact_available: row.artifact_pair === true,
      artifact_provenance_verified: row.artifact_pair === true,
      registry_history_available: false,
      dependency_history_available: false,
      behavioral_delta_available: row.delta !== null,
    },
    {
      required_evidence: ['artifact_digest'],
      applicable_mechanisms: [
        'artifact_behavior_change',
        'install_hook_abuse',
        'external_domain_introduction',
        'unknown',
      ],
      out_of_scope_mechanisms: ['source_code_semantic_sabotage'],
    },
  );
  return { result, observed: row.delta?.behavior?.length > 0 ? true : row.delta ? false : null };
});
const output = {
  result_kind: 'metric-recalculation',
  evaluator_version: '0.13.0',
  source_file: 'final-holdout-v3.json',
  source_sha256: createHash('sha256').update(original).digest('hex'),
  root_cause:
    'The prior evaluator treated insufficient evidence as a negative observation; evaluator v2 excludes it from TP/FP/TN/FN and reports evaluability separately.',
  before: file.metrics,
  after: summarizeEvaluator(rows),
};
mkdirSync(resolve('calibration/incidents-v3/results'), { recursive: true });
writeFileSync(
  resolve('calibration/incidents-v3/results/metric-recalculation-v3-evaluator-v2.json'),
  JSON.stringify(output, null, 2) + '\n',
);
