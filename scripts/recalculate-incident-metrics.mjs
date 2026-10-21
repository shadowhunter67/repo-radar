import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculateBinaryMetrics } from '../dist/calibration/metrics.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const incidentRoot = join(root, 'calibration', 'incidents');
const resultDir = join(incidentRoot, 'results');
const labels = JSON.parse(readFileSync(join(incidentRoot, 'cases.json'), 'utf8'));
const labelById = new Map(labels.map((x) => [x.id, x]));
const observationKeys = [
  'publisher_change',
  'maintainer_change',
  'repository_change',
  'dormancy_end',
  'release_cadence_change',
  'install_script_introduced',
  'provenance_changed',
  'external_domain_introduced',
];

const boolLabel = (value) => (value === 'true' ? true : value === 'false' ? false : null);
const splitNames = ['development', 'validation', 'holdout', 'overall'];
const rowsFor = (rows, split) =>
  split === 'overall' ? rows : rows.filter((row) => row.split === split);

function corrected(original) {
  const rows = original.cases;
  const metrics = {};
  for (const key of observationKeys) {
    const bySplit = {};
    for (const split of splitNames) {
      const selected = rowsFor(rows, split);
      bySplit[split] = calculateBinaryMetrics(
        selected.map((row) => ({
          expected: boolLabel(labelById.get(row.id)?.labels?.[key]),
          observed: typeof row.observations?.[key] === 'boolean' ? row.observations[key] : null,
        })),
      );
    }
    metrics[key] = { before: original.raw_observation_metrics?.[key] ?? null, after: bySplit };
  }
  const patterns = {};
  const patternNames = Object.keys(rows[0]?.patterns ?? {});
  for (const pattern of patternNames) {
    const bySplit = {};
    for (const split of splitNames) {
      const selected = rowsFor(rows, split);
      bySplit[split] = calculateBinaryMetrics(
        selected.map((row) => ({
          expected: labelById.get(row.id)?.pattern_expectations?.[pattern]?.should_fire ?? null,
          observed: typeof row.patterns?.[pattern] === 'boolean' ? row.patterns[pattern] : null,
        })),
      );
    }
    patterns[pattern] = {
      before: original.temporal_patterns?.['within_days=90']?.[pattern] ?? null,
      after: bySplit,
    };
  }
  return { metrics, patterns };
}

const recalculations = {};
for (const name of ['final-holdout.json', 'final-holdout-v2.json']) {
  const path = join(resultDir, name);
  const bytes = readFileSync(path);
  const original = JSON.parse(bytes.toString('utf8'));
  recalculations[name] = {
    source_sha256: createHash('sha256').update(bytes).digest('hex'),
    source_file: `calibration/incidents/results/${name}`,
    label: 'metric-recalculation',
    corpus_version: original.version,
    methodology: original.methodology,
    split_blocks: splitNames,
    root_cause:
      'The prior false-positive rate divided FP by all non-incident rows instead of FP/(FP+TN), and did not publish explicit confusion-matrix counts or abstention coverage.',
    ...corrected(original),
  };
}
writeFileSync(
  join(resultDir, 'metric-recalculation-v2.json'),
  JSON.stringify({ version: 2, label: 'metric-recalculation', recalculations }, null, 2) + '\n',
);
