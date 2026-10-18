import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import {
  assignIncidentSplit,
  evaluateIncidentCase,
  loadIncidentCases,
  PATTERN_IDS,
} from '../dist/calibration/incidents.js';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'calibration', 'incidents');
const args = process.argv.slice(2);
const final = args.includes('--final');
const incidentModelVersion = '0.11.0';
const cases = loadIncidentCases(root);
for (const c of cases)
  if (assignIncidentSplit(c.ecosystem, c.package) !== c.split)
    throw new Error(`split drift: ${c.id}`);
if (final && existsSync(join(root, 'results', 'final-holdout-v2.json')))
  throw new Error('final holdout already recorded; refusing a second run');
const selected = final
  ? cases.filter((c) => c.split === 'holdout' && c.holdout_spent !== true)
  : cases.filter((c) => c.split !== 'holdout');
const rows = selected.map((c) => ({
  id: c.id,
  split: c.split,
  conclusion: c.conclusion,
  ...evaluateIncidentCase(c, root),
}));
const metrics = {};
for (const label of [
  'publisher_change',
  'maintainer_change',
  'repository_change',
  'dormancy_end',
  'release_cadence_change',
  'install_script_introduced',
  'provenance_changed',
  'external_domain_introduced',
]) {
  const usable = rows.filter(
    (r) =>
      !['unknown', 'disputed', 'insufficient_evidence'].includes(
        cases.find((c) => c.id === r.id).labels[label],
      ),
  );
  const labelOf = (r) => cases.find((c) => c.id === r.id).labels[label];
  const tp = usable.filter((r) => labelOf(r) === 'true' && r.observations[label]).length;
  const fp = usable.filter((r) => labelOf(r) === 'false' && r.observations[label]).length;
  const fn = usable.filter((r) => labelOf(r) === 'true' && !r.observations[label]).length;
  metrics[label] = {
    n: usable.length,
    abstained: selected.length - usable.length,
    accuracy: usable.length
      ? usable.filter((r) => (labelOf(r) === 'true') === r.observations[label]).length /
        usable.length
      : null,
    precision: tp + fp ? tp / (tp + fp) : null,
    recall: tp + fn ? tp / (tp + fn) : null,
    false_positive_rate: usable.filter((r) => cases.find((c) => c.id === r.id).kind !== 'incident')
      .length
      ? fp / usable.filter((r) => cases.find((c) => c.id === r.id).kind !== 'incident').length
      : null,
  };
}
const byId = new Map(cases.map((c) => [c.id, c]));
/** Pattern precision/recall over cases whose expectation is decided (null = abstention). */
function patternMetrics(rowsIn) {
  const out = {};
  for (const pattern of PATTERN_IDS) {
    const decided = rowsIn.filter(
      (r) => (byId.get(r.id).pattern_expectations[pattern]?.should_fire ?? null) !== null,
    );
    const exp = (r) => byId.get(r.id).pattern_expectations[pattern]?.should_fire ?? null;
    const tp = decided.filter((r) => r.patterns[pattern] && exp(r)).length;
    const fp = decided.filter((r) => r.patterns[pattern] && !exp(r)).length;
    const fn = decided.filter((r) => !r.patterns[pattern] && exp(r)).length;
    const benign = decided.filter((r) => byId.get(r.id).kind !== 'incident');
    const incidents = decided.filter((r) => byId.get(r.id).kind === 'incident');
    out[pattern] = {
      decided: decided.length,
      abstained: rowsIn.length - decided.length,
      tp,
      fp,
      fn,
      precision: tp + fp ? tp / (tp + fp) : null,
      recall: tp + fn ? tp / (tp + fn) : null,
      benign_cases: benign.length,
      benign_false_positive_rate: benign.length
        ? benign.filter((r) => r.patterns[pattern]).length / benign.length
        : null,
      incident_cases_fired: incidents.filter((r) => r.patterns[pattern]).length,
      incident_cases: incidents.length,
    };
  }
  return out;
}
const patterns = patternMetrics(rows);
// Window sensitivity: the REAL correlation engine with every pattern's within_days overridden, development+validation only.
const tuning = selected.filter((c) => c.split !== 'holdout');
const grid = {};
for (const days of [7, 14, 30, 60, 90, 120, 180]) {
  const r = tuning.map((c) => ({
    id: c.id,
    patterns: evaluateIncidentCase(c, root, days).patterns,
  }));
  grid[`within_days=${days}`] = patternMetrics(r);
}
const thresholdGrid = {
  development_validation_only: true,
  evaluated: 'pattern within_days (real correlation engine)',
  not_evaluated:
    'dormancy / cadence / new-publisher thresholds: event-level expectations were authored against the current definitions, so a grid over them would be circular',
  results: grid,
  decision: 'unchanged',
};
const out = {
  version: 2,
  corpus: 'incident-calibration-v2',
  methodology: '0.4',
  incident_model_version: incidentModelVersion,
  holdout: final,
  cases: rows,
  raw_observation_metrics: metrics,
  temporal_patterns: patterns,
  threshold_grid: thresholdGrid,
  thresholds: {
    decision: 'unchanged',
    reason:
      'no window shows a stable validation gain without more benign false positives (see threshold_grid); old values kept',
  },
};
if (final) {
  mkdirSync(join(root, 'results'), { recursive: true });
  writeFileSync(
    join(root, 'results', 'final-holdout-v2.json'),
    JSON.stringify(out, null, 2) + '\n',
  );
}
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
