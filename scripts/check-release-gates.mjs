// Machine-checkable public-release gates (documented in docs/release-gates.md).
//
//   node scripts/check-release-gates.mjs [--online] [--strict]
//
// PASS / FAIL / MANUAL (needs a person) / SKIP (needs --online). Exit 1 if any gate FAILs; with --strict MANUAL and
// SKIP also fail. A missing artifact is always a FAIL, never a pass. Needs `npm run build` (loads the calibration loader).
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const online = process.argv.includes('--online');
const strict = process.argv.includes('--strict');
const read = (p) => readFileSync(join(root, p), 'utf8');
const exists = (p) => existsSync(join(root, p));
const results = [];
const gate = (id, name, status, detail = '') => results.push({ id, name, status, detail });
const pkg = JSON.parse(read('package.json'));

function workflowFiles() {
  const dir = join(root, '.github', 'workflows');
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => /\.ya?ml$/.test(f))
        .map((f) => `.github/workflows/${f}`)
    : [];
}
function gh(args) {
  return execFileSync('gh', args, { cwd: root, encoding: 'utf8', timeout: 60000 }).trim();
}

// 1 + 2 (online part)
if (online) {
  try {
    const run = JSON.parse(
      gh([
        'run',
        'list',
        '--workflow',
        'ci',
        '--branch',
        'main',
        '--limit',
        '1',
        '--json',
        'conclusion,headSha',
      ]),
    )[0];
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const ok = run?.conclusion === 'success';
    gate(
      1,
      'CI green on a hosted runner',
      ok ? 'PASS' : 'FAIL',
      `latest ci on main: ${run?.conclusion ?? 'none'}${run && run.headSha !== head ? ' (not the local HEAD)' : ''}`,
    );
  } catch (e) {
    gate(
      1,
      'CI green on a hosted runner',
      'FAIL',
      `cannot query GitHub: ${String(e.message).slice(0, 80)}`,
    );
  }
} else gate(1, 'CI green on a hosted runner', 'SKIP', 'needs --online');

// 2 Action on >= 3 real repositories
{
  const ci = exists('.github/workflows/ci.yml') ? read('.github/workflows/ci.yml') : '';
  const matrix = ci.split('action-matrix:')[1]?.split(/\n {2}\S+:\n/)[0] ?? '';
  const repos = [...matrix.matchAll(/^\s+- ([\w.-]+\/[\w.-]+)\s*$/gm)].map((m) => m[1]);
  gate(
    2,
    'Action exercised on >= 3 real repositories',
    repos.length >= 3 ? 'PASS' : 'FAIL',
    `${repos.length} real repositories in the CI matrix${online ? ' (CI result: gate 1)' : ''}`,
  );
}

// 3 release path
{
  const f = '.github/workflows/release-action.yml';
  const t = exists(f) ? read(f) : '';
  const ok =
    /workflow_dispatch:/.test(t) &&
    /dry_run:[\s\S]{0,200}default:\s*true/.test(t) &&
    exists('tests/unit/release-packaging.test.ts') &&
    exists('scripts/package-action.mjs');
  gate(
    3,
    'dist/action release path defined and tested',
    ok ? 'PASS' : 'FAIL',
    ok
      ? 'dispatch-only workflow, dry-run default, packaging test present'
      : 'workflow, dry-run default or packaging test missing',
  );
}

// 4 corpus
let corpus;
try {
  const { loadCorpus } = await import('../dist/calibration/load.js');
  corpus = loadCorpus(join(root, 'calibration'));
  const shas = corpus.labels.every((l) => /^[0-9a-f]{40}$/.test(l.commit));
  const ok = corpus.problems.length === 0 && corpus.labels.length >= 30 && shas;
  gate(
    4,
    'Calibration corpus >= 30 pinned repositories',
    ok ? 'PASS' : 'FAIL',
    `${corpus.labels.length} labels, ${corpus.problems.length} problems, pinned=${shas}`,
  );
} catch (e) {
  gate(
    4,
    'Calibration corpus >= 30 pinned repositories',
    'FAIL',
    `cannot load corpus (run npm run build): ${String(e.message).slice(0, 80)}`,
  );
}

// 5-7 calibration results
{
  const dir = join(root, 'calibration', 'results');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
  const load = (f) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const all = files.map((f) => ({ f, r: load(f) }));
  let methodology = '?';
  try {
    methodology = (await import('../dist/scoring/rules.js')).loadRuleSet(root).methodology;
  } catch {
    /* reported through gate 5 */
  }
  // Only a FRESH holdout built for this methodology counts: an older holdout that was already observed is not independent.
  const finals = all.filter(
    (x) =>
      x.r.holdout_evaluated &&
      x.r.fresh_holdout === true &&
      x.r.for_methodology === methodology &&
      x.r.methodology_version === methodology,
  );
  gate(
    5,
    'Holdout evaluated for the current methodology',
    finals.length ? 'PASS' : 'FAIL',
    finals.length
      ? finals.map((x) => x.f).join(', ')
      : `no FRESH holdout result for methodology ${methodology} (run scripts/calibrate.mjs --corpus <fresh holdout dir> --final once, after tuning)`,
  );
  const withSplit = all.filter(
    (x) =>
      x.r.by_split &&
      Object.values(x.r.by_split).some((s) => s.artifact && s.domain && 'abstained' in s.artifact),
  );
  gate(
    6,
    'Identity quality audited',
    withSplit.length ? 'PASS' : 'FAIL',
    withSplit.length
      ? `${withSplit.length} result file(s) with artifact/domain accuracy and abstentions`
      : 'no result file with identity metrics',
  );
  const withCaps = all.filter(
    (x) =>
      x.r.disagreements &&
      x.r.by_split &&
      Object.values(x.r.by_split).some((s) => s.capabilities && Object.keys(s.capabilities).length),
  );
  gate(
    7,
    'Capability false positives audited',
    withCaps.length ? 'PASS' : 'FAIL',
    withCaps.length
      ? 'per-capability precision/recall and disagreements recorded'
      : 'no result file with capability metrics',
  );
}

// 8 secret leak test
{
  const t = exists('tests/unit/code-analysis-pipeline.test.ts')
    ? read('tests/unit/code-analysis-pipeline.test.ts')
    : '';
  gate(
    8,
    'Secret scanner does not leak values (test exists)',
    /never leaks the secret value/.test(t) ? 'PASS' : 'FAIL',
    'a green `npm test` is required in addition; this gate only checks the test exists',
  );
}

// 9 disclaimers
{
  const text = exists('src/report/text.ts') ? read('src/report/text.ts') : '';
  const lim = exists('docs/limitations.md') ? read('docs/limitations.md') : '';
  const ok = /not an absolute verdict/.test(text) && /not a security\s+audit/.test(lim);
  gate(
    9,
    'Score/confidence disclaimers present',
    ok ? 'PASS' : 'FAIL',
    ok
      ? 'text report and docs/limitations.md'
      : 'disclaimer missing in the text report or limitations',
  );
}

// 10 schema compatibility
{
  const schemas = exists('schemas')
    ? readdirSync(join(root, 'schemas')).filter((f) => f.endsWith('.json'))
    : [];
  const ok =
    schemas.length > 0 &&
    exists('tests/unit/docs-sync.test.ts') &&
    exists('scripts/gen-schemas.mjs');
  gate(
    10,
    'Schema compatibility checks exist',
    ok ? 'PASS' : 'FAIL',
    `${schemas.length} generated schema file(s); a green \`npm test\` is required in addition`,
  );
}

// 11 SECURITY.md current
{
  const sec = exists('SECURITY.md') ? read('SECURITY.md') : '';
  const minor = pkg.version.split('.').slice(0, 2).join('.');
  const ok = sec.includes(`${minor}.x`) && exists('docs/security-model.md');
  gate(
    11,
    'SECURITY.md and threat model current',
    ok ? 'PASS' : 'FAIL',
    ok
      ? `supported version ${minor}.x listed`
      : `SECURITY.md does not list ${minor}.x as supported, or docs/security-model.md is missing`,
  );
}

// 12 pinned actions
{
  const bad = [];
  for (const f of [...workflowFiles(), 'action.yml']) {
    if (!exists(f)) continue;
    for (const m of read(f).matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
      const ref = m[1];
      if (ref.startsWith('./') || /@[0-9a-f]{40}$/.test(ref)) continue;
      bad.push(`${f}: ${ref}`);
    }
  }
  gate(
    12,
    'Third-party actions pinned to full SHAs',
    bad.length ? 'FAIL' : 'PASS',
    bad.length ? bad.slice(0, 3).join('; ') : 'all `uses:` pinned',
  );
}

// 13 commit identity
{
  const out = execFileSync('git', ['log', '--format=%an <%ae>|%cn <%ce>'], {
    cwd: root,
    encoding: 'utf8',
  });
  const ids = new Set(
    out
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((l) => l.split('|')),
  );
  const allowed = new Set([
    'repo-radar dev <dev@repo-radar.invalid>',
    'GitHub <noreply@github.com>', // committer of squash merges made in the GitHub UI
  ]);
  const other = [...ids].filter((i) => !allowed.has(i) && !/\[bot\]/.test(i));
  gate(
    13,
    'Commit identity is the project identity',
    other.length ? 'FAIL' : 'PASS',
    other.length
      ? `other identities in history: ${other.length}`
      : 'all commits use the project identity',
  );
}

// 14 manual
gate(
  14,
  'Calibration labels reviewed by a human',
  'MANUAL',
  'labels are single AI-assisted review; confirm a human review before public claims',
);

const icon = { PASS: 'PASS  ', FAIL: 'FAIL  ', MANUAL: 'MANUAL', SKIP: 'SKIP  ' };
for (const g of results)
  process.stdout.write(
    `${icon[g.status]} ${String(g.id).padStart(2)}. ${g.name}${g.detail ? ` - ${g.detail}` : ''}\n`,
  );
const count = (s) => results.filter((g) => g.status === s).length;
process.stdout.write(
  `\n${count('PASS')} pass, ${count('FAIL')} fail, ${count('MANUAL')} manual, ${count('SKIP')} skipped\n`,
);
const failing = count('FAIL') > 0 || (strict && (count('MANUAL') > 0 || count('SKIP') > 0));
process.exit(failing ? 1 : 0);
