import { readFileSync } from 'node:fs';
import process from 'node:process';

const [firstPath, secondPath] = process.argv.slice(2);
if (!firstPath || !secondPath)
  throw new Error('usage: compare-reviews-v2.mjs reviewer-1.json reviewer-2.json');
const a = JSON.parse(readFileSync(firstPath, 'utf8'));
const b = JSON.parse(readFileSync(secondPath, 'utf8'));
const fields = [
  'label',
  'incident_mechanism',
  'artifact_provenance_quality',
  'dependency_history_ground_truth',
];
const opinions = fields.map((field) => ({
  field,
  first: a.opinions?.[field] ?? null,
  second: b.opinions?.[field] ?? null,
}));
const status = opinions.some((x) => x.first === null || x.second === null)
  ? 'uncertain'
  : opinions.every((x) => x.first === x.second)
    ? 'agreed'
    : 'disagreed';
process.stdout.write(`${JSON.stringify({ status, opinions })}\n`);
