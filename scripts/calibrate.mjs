// Runs the analyzer on the calibration corpus at the PINNED revisions and compares it with the labels.
//
//   npm run build && GITHUB_TOKEN=... node scripts/calibrate.mjs [--splits dev,validation] [--final] [--refresh] [--only owner/repo]
//
// Holdout discipline: the holdout split is only evaluated with --final, which must be used once per methodology version,
// after tuning is finished. Results are written to calibration/results/ (committed); per-repository reports to
// calibration/runs/ (git-ignored cache). Needs network access (GitHub API + raw files) and a token for the rate limit.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { analyzeRepository, toolVersion } from '../dist/analyze.js';
import { loadCorpus } from '../dist/calibration/load.js';
import {
  disagreements,
  evaluate,
  predictionFrom,
  renderMarkdown,
} from '../dist/calibration/metrics.js';
import { loadRuleSet } from '../dist/scoring/rules.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const final = flag('--final');
const splits = (opt('--splits', final ? 'dev,validation,holdout' : 'dev,validation') ?? '').split(
  ',',
);
if (splits.includes('holdout') && !final) {
  process.stderr.write(
    'refusing to evaluate the holdout split without --final (it is for the end of a tuning cycle)\n',
  );
  process.exit(64);
}
const only = opt('--only');
const token = process.env.GITHUB_TOKEN || undefined;
const corpus = loadCorpus(join(root, 'calibration'));
if (corpus.problems.length) {
  process.stderr.write(`corpus problems:\n${corpus.problems.join('\n')}\n`);
  process.exit(1);
}
const rules = loadRuleSet(root);
const version = `${toolVersion(root)}-${rules.digest.slice(0, 10)}`;
const runDir = join(root, 'calibration', 'runs', version);
mkdirSync(runDir, { recursive: true });

const labels = corpus.labels.filter(
  (l) => splits.includes(l.split) && (!only || l.repository === only),
);
const cases = { dev: [], validation: [], holdout: [] };
const failures = [];
const queue = [...labels];
async function worker() {
  for (;;) {
    const l = queue.shift();
    if (!l) return;
    const file = join(runDir, `${l.repository.replace('/', '__')}.${l.commit.slice(0, 10)}.json`);
    let report;
    try {
      if (existsSync(file) && !flag('--refresh')) report = JSON.parse(readFileSync(file, 'utf8'));
      else {
        report = await analyzeRepository(l.repository, {
          ref: l.commit,
          ...(token ? { token } : {}),
          scorecard: false,
          osv: false,
        });
        writeFileSync(file, JSON.stringify(report));
      }
      cases[l.split].push({ label: l, prediction: predictionFrom(report) });
      process.stdout.write(`ok   ${l.split.padEnd(10)} ${l.repository}\n`);
    } catch (e) {
      failures.push({ repository: l.repository, error: String(e?.message ?? e).slice(0, 200) });
      process.stdout.write(`FAIL ${l.repository}: ${String(e?.message ?? e).slice(0, 120)}\n`);
    }
  }
}
await Promise.all(Array.from({ length: Number(opt('--concurrency', '3')) }, worker));

const result = {
  dataset_version: corpus.dataset.version,
  analyzer_version: toolVersion(root),
  rules_digest: rules.digest,
  methodology_version: rules.methodology,
  evaluated_at: new Date().toISOString(),
  splits,
  holdout_evaluated: splits.includes('holdout'),
  label_review_kind: 'ai-assisted-single',
  failures,
  by_split: {},
  disagreements: {},
};
let md = `# Calibration results\n\nDataset ${result.dataset_version}, analyzer ${result.analyzer_version}, methodology ${result.methodology_version}, rules digest ${result.rules_digest.slice(0, 12)}.\n\nLabels come from ONE AI-assisted reviewer (not independent human review); read every number as an upper bound on how well the labels themselves are known. Repositories flagged \`tuned_on\` were looked at while building the analyzer and sit in dev only.\n\n`;
for (const s of ['dev', 'validation', 'holdout']) {
  if (!splits.includes(s) || cases[s].length === 0) continue;
  const e = evaluate(cases[s]);
  result.by_split[s] = e;
  result.disagreements[s] = disagreements(cases[s]);
  md += renderMarkdown(`${s} split`, e) + '\n';
  md += `Disagreements (${s}):\n\n| repository | field | analyzer | label | confidence |\n| --- | --- | --- | --- | --- |\n`;
  for (const d of result.disagreements[s])
    md += `| ${d.repository} | ${d.field} | ${d.predicted} | ${d.label} | ${d.confidence === null ? '' : Math.round(d.confidence * 100) + '%'} |\n`;
  md += '\n';
}
if (failures.length)
  md += `Failed repositories: ${failures.map((f) => `${f.repository} (${f.error})`).join('; ')}\n`;
const outDir = join(root, 'calibration', 'results');
mkdirSync(outDir, { recursive: true });
const name = opt('--name', `${final ? 'final' : 'tuning'}-${version}`);
writeFileSync(join(outDir, `${name}.json`), JSON.stringify(result, null, 2) + '\n');
writeFileSync(join(outDir, `${name}.md`), md);
process.stdout.write(`results written to calibration/results/${name}.{json,md}\n`);
