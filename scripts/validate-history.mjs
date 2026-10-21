import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { classifyHistory } from '../dist/history/validation.js';

const rawPath = resolve('calibration/history-validation/ground-truth-raw.json');
const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
const date = new Date().toISOString().slice(0, 10);
const cases = raw.cases ?? raw;
const rows = cases.map((c) => ({
  repo: c.repo,
  dependency: c.dependency,
  classification: classifyHistory({ observed: c.observed ?? {}, truth: c.truth ?? c }),
}));
const counts = {
  cases_total: rows.length,
  evaluated: rows.filter((r) => Object.values(r.classification).length > 0).length,
  exact: 0,
  partial: 0,
  unknown: 0,
  incorrect: 0,
  budget_exhausted: 0,
};
for (const r of rows)
  for (const value of Object.values(r.classification)) {
    if (
      value === 'exact_commit' ||
      value === 'correct_relationship' ||
      value === 'correct_manifest'
    )
      counts.exact++;
    else if (value === 'acceptable_ancestor_or_window') counts.partial++;
    else if (value === 'unknown_ground_truth' || value === 'ambiguous_history') counts.unknown++;
    else if (value === 'incorrect') counts.incorrect++;
  }
const result = {
  result_kind: 'history-validation',
  generated_at: new Date().toISOString(),
  source_sha256: createHash('sha256').update(readFileSync(rawPath)).digest('hex'),
  cases: rows,
  summary: counts,
  cost: {
    requests: null,
    commits_scanned: null,
    files: null,
    elapsed_ms: null,
    cache_hit_ratio: null,
  },
};
mkdirSync(resolve('calibration/history-validation/results'), { recursive: true });
writeFileSync(
  resolve(`calibration/history-validation/results/validation-${date}.json`),
  JSON.stringify(result, null, 2) + '\n',
);
process.stdout.write(`${JSON.stringify({ summary: counts, output: `validation-${date}.json` })}\n`);
