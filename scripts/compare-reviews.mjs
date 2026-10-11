// Compares human reviewer submissions with the existing (AI-assisted) labels AFTER the reviewer has finished.
//
//   node scripts/compare-reviews.mjs --corpus calibration/fresh-holdout-0.4 --reviews <dir with <owner>__<repo>.yaml|json>
//
// Writes calibration/review/<corpus>/adjudication-<reviewer>.md. It never edits labels and never marks release gate 14
// as satisfied; that stays a manual decision recorded by a person.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { loadCorpus } from '../dist/calibration/load.js';
import {
  compareReviews,
  renderAdjudication,
  ReviewSubmissionSchema,
} from '../dist/calibration/review.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const corpusRel = opt('--corpus', 'calibration');
const reviewsDir = opt('--reviews');
if (!reviewsDir) {
  process.stderr.write('usage: compare-reviews.mjs --corpus <dir> --reviews <dir>\n');
  process.exit(64);
}
const corpus = loadCorpus(join(root, corpusRel));
const submissions = new Map();
const problems = [];
for (const f of readdirSync(reviewsDir).filter((x) => /\.(?:ya?ml|json)$/.test(x))) {
  const raw = parse(readFileSync(join(reviewsDir, f), 'utf8'));
  const repo = raw?.repository ?? f.replace(/\.(?:ya?ml|json)$/, '').replace('__', '/');
  const r = ReviewSubmissionSchema.safeParse(raw);
  if (!r.success)
    problems.push(
      `${f}: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  else submissions.set(repo, [...(submissions.get(repo) ?? []), r.data]);
}
if (problems.length) {
  process.stderr.write(`invalid submissions:\n${problems.join('\n')}\n`);
  process.exit(1);
}
// Every reviewer's submission is compared on its own; opinions are never averaged into a fake consensus.
const reviewers = [...new Set([...submissions.values()].flat().map((s) => s.reviewer.id))].sort();
const cmp = compareReviews(corpus.labels, submissions);
const out = join(
  root,
  'calibration',
  'review',
  corpus.dataset.corpus_id ?? 'calibration-v0',
  `adjudication-${reviewers.join('+')}.md`,
);
writeFileSync(out, renderAdjudication(cmp));
process.stdout.write(
  `${cmp.repositories} repositories compared; ${cmp.disagreements.length} disagreements; worksheet: ${out.replace(root, '.')}\n`,
);
