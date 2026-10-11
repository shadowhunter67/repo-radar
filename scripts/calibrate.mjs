// Runs the analyzer on a calibration corpus at the PINNED revisions and compares it with the labels.
//
//   npm run build && GITHUB_TOKEN=... node scripts/calibrate.mjs [--corpus calibration/fresh-holdout-0.4] [--splits dev,validation]
//                                                                  [--final] [--refresh] [--only owner/repo] [--no-deps]
//
// Holdout discipline: a holdout split (including a whole fresh-holdout corpus) is only evaluated with --final, which is
// allowed ONCE per (corpus, methodology): if calibration/results/<corpus>-methodology-<m>.json already exists the run is
// refused (exit 65), because a second run after looking at the first result would no longer be an independent measurement.
// Results go to calibration/results/ (committed); per-repository reports to calibration/runs/ (git-ignored cache).
// Needs network access (GitHub API + raw files) and a token for the rate limit. Everything runs sequentially.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { analyzeRepository, toolVersion } from '../dist/analyze.js';
import {
  depPredictionFrom,
  evaluateDependencies,
  renderDependencyMarkdown,
} from '../dist/calibration/dep-metrics.js';
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
const corpusRel = opt('--corpus', 'calibration');
const corpus = loadCorpus(join(root, corpusRel));
if (corpus.problems.length) {
  process.stderr.write(`corpus problems:\n${corpus.problems.join('\n')}\n`);
  process.exit(1);
}
const corpusId = corpus.dataset.corpus_id ?? 'calibration-v0';
const freshHoldout = corpus.dataset.fixed_split === 'holdout';
const splits = (
  opt('--splits', final || freshHoldout ? 'dev,validation,holdout' : 'dev,validation') ?? ''
).split(',');
if ((splits.includes('holdout') || freshHoldout) && !final) {
  process.stderr.write(
    'refusing to evaluate a holdout without --final (it is for the end of a tuning cycle)\n',
  );
  process.exit(64);
}
const rules = loadRuleSet(root);
if (corpus.dataset.for_methodology && corpus.dataset.for_methodology !== rules.methodology) {
  process.stderr.write(
    `corpus ${corpusId} is for methodology ${corpus.dataset.for_methodology}, but the analyzer implements ${rules.methodology}\n`,
  );
  process.exit(66);
}
const outDir = join(root, 'calibration', 'results');
const finalName = `${corpusId}-methodology-${rules.methodology}`;
if (final && freshHoldout && existsSync(join(outDir, `${finalName}.json`))) {
  process.stderr.write(
    `${finalName}.json already exists: a fresh holdout is evaluated once per methodology; not re-running\n`,
  );
  process.exit(65);
}
const only = opt('--only');
const token = process.env.GITHUB_TOKEN || undefined;
const withDeps = !flag('--no-deps') && corpus.labels.some((l) => l.dependencies);
const version = `${toolVersion(root)}-${rules.digest.slice(0, 10)}`;
const runDir = join(root, 'calibration', 'runs', corpusId, version + (withDeps ? '-deps' : ''));
mkdirSync(runDir, { recursive: true });

const labels = corpus.labels.filter(
  (l) => splits.includes(l.split) && (!only || l.repository === only),
);
const cases = { dev: [], validation: [], holdout: [] };
const depCases = { dev: [], validation: [], holdout: [] };
const failures = [];
const timings = [];
for (const l of labels) {
  const file = join(runDir, `${l.repository.replace('/', '__')}.${l.commit.slice(0, 10)}.json`);
  let report;
  try {
    const t0 = Date.now();
    if (existsSync(file) && !flag('--refresh')) report = JSON.parse(readFileSync(file, 'utf8'));
    else {
      report = await analyzeRepository(l.repository, {
        ref: l.commit,
        ...(token ? { token } : {}),
        scorecard: false,
        osv: withDeps,
        depsDev: false,
        sbom: withDeps,
      });
      writeFileSync(file, JSON.stringify(report));
    }
    timings.push({
      repository: l.repository,
      ms: Date.now() - t0,
      requests: report.stats.http_requests,
    });
    cases[l.split].push({ label: l, prediction: predictionFrom(report) });
    depCases[l.split].push({ label: l, prediction: depPredictionFrom(report) });
    process.stdout.write(`ok   ${l.split.padEnd(10)} ${l.repository}\n`);
  } catch (e) {
    failures.push({ repository: l.repository, error: String(e?.message ?? e).slice(0, 200) });
    process.stdout.write(`FAIL ${l.repository}: ${String(e?.message ?? e).slice(0, 120)}\n`);
  }
}

const result = {
  corpus_id: corpusId,
  corpus_dir: corpusRel,
  for_methodology: corpus.dataset.for_methodology ?? null,
  dataset_version: corpus.dataset.version,
  analyzer_version: toolVersion(root),
  rules_digest: rules.digest,
  methodology_version: rules.methodology,
  evaluated_at: new Date().toISOString(),
  splits,
  holdout_evaluated: splits.includes('holdout') && cases.holdout.length > 0,
  fresh_holdout: freshHoldout,
  label_review_kind: 'ai-assisted-single',
  deps_enabled: withDeps,
  failures,
  by_split: {},
  dependencies: {},
  disagreements: {},
  timings,
};
let md = `# Calibration results: ${corpusId}\n\nDataset ${result.dataset_version}, analyzer ${result.analyzer_version}, methodology ${result.methodology_version}, rules digest ${result.rules_digest.slice(0, 12)}.\n\nLabels come from ONE AI-assisted reviewer (not independent human review); read every number as an upper bound on how well the labels themselves are known.${freshHoldout ? ' This is a FRESH HOLDOUT: it was run once for this methodology and must not be used to tune the analyzer in this cycle.' : ' Repositories flagged `tuned_on` were looked at while building the analyzer and sit in dev only.'}\n\n`;
for (const s of ['dev', 'validation', 'holdout']) {
  if (!splits.includes(s) || cases[s].length === 0) continue;
  const e = evaluate(cases[s]);
  result.by_split[s] = e;
  result.disagreements[s] = disagreements(cases[s]);
  md += renderMarkdown(`${s} split`, e) + '\n';
  const de = evaluateDependencies(depCases[s]);
  if (de.repositories > 0) {
    result.dependencies[s] = de;
    md += renderDependencyMarkdown(de) + '\n';
  }
  md += `Disagreements (${s}):\n\n| repository | field | analyzer | label | confidence |\n| --- | --- | --- | --- | --- |\n`;
  for (const d of result.disagreements[s])
    md += `| ${d.repository} | ${d.field} | ${d.predicted} | ${d.label} | ${d.confidence === null ? '' : Math.round(d.confidence * 100) + '%'} |\n`;
  md += '\n';
}
if (timings.length)
  md += `Timing: ${timings.map((t) => `${t.repository.split('/')[1]} ${t.ms}ms/${t.requests}req`).join(', ')}\n\n`;
if (failures.length)
  md += `Failed repositories: ${failures.map((f) => `${f.repository} (${f.error})`).join('; ')}\n`;
mkdirSync(outDir, { recursive: true });
const name = opt(
  '--name',
  final && freshHoldout ? finalName : `${final ? 'final' : 'tuning'}-${version}`,
);
writeFileSync(join(outDir, `${name}.json`), JSON.stringify(result, null, 2) + '\n');
writeFileSync(join(outDir, `${name}.md`), md);
process.stdout.write(`results written to calibration/results/${name}.{json,md}\n`);
