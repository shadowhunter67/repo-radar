import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inspectArtifact } from '../dist/registry/artifacts/inspect.js';
import { compareDependencyArtifacts } from '../dist/registry/artifacts/delta.js';
import { extractStaticFacts } from '../dist/registry/artifacts/static.js';
import { calculateBinaryMetrics } from '../dist/calibration/metrics.js';
import { evaluateCase, summarizeEvaluator } from '../dist/calibration/evaluator.js';
import process from 'node:process';

const root = resolve('calibration/incidents-v3');
const args = new Set(process.argv.slice(2));
const FINAL = args.has('--final');
const finalPath = join(root, 'results', 'final-holdout-v3.json');
// the final holdout is written once and is never overwritten
if (FINAL && existsSync(finalPath))
  throw new Error('final-holdout-v3.json already exists; the v3 holdout runs exactly once');
const cases = JSON.parse(readFileSync(join(root, 'cases.json'), 'utf8'));
const split = (ecosystem, pkg) => {
  const n = createHash('sha256').update(`${ecosystem}:${pkg}`).digest()[0] % 10;
  return n < 6 ? 'development' : n < 8 ? 'validation' : 'holdout';
};
for (const c of cases)
  if (c.source === 'real_artifact_pair' && split(c.ecosystem, c.package) !== c.split)
    throw new Error(`split drift: ${c.id}`);
const digest = (file, integrity) => {
  const bytes = readFileSync(resolve(file));
  const expected = integrity.replace(/^sha512-/, '');
  const actual = createHash('sha512').update(bytes).digest('base64');
  return { bytes, ok: actual === expected };
};
const inspect = (c, side) => {
  if (!c[`artifact_${side}`]) return { status: 'missing_artifact' };
  const d = digest(c[`artifact_${side}`], c[`digest_${side}`]);
  if (!d.ok) return { status: 'digest_mismatch' };
  const result = inspectArtifact(d.bytes, {
    expectedDigest: c[`digest_${side}`],
    algorithm: 'sha512',
  });
  return { status: result.state, result };
};
const rows = cases
  .filter((c) => (FINAL ? c.split === 'holdout' : c.split !== 'holdout'))
  .map((c) => {
    const before = inspect(c, 'before');
    const after = inspect(c, 'after');
    const abstentions = [];
    if (before.status !== 'verified' || after.status !== 'verified')
      abstentions.push(`${before.status}/${after.status}`);
    let delta = null;
    if (!abstentions.length) {
      const toArtifact = (x, version) => {
        const facts = extractStaticFacts(x, { name: c.package, version });
        return {
          registry: 'npm',
          package: c.package,
          version,
          url: null,
          state: 'verified',
          entries: x.entries.length,
          total_size: x.totalSize,
          hooks: facts.hooks,
          domains: facts.domains,
          mismatches: facts.mismatches,
          reason: null,
          evidence: [`fixture:${c.id}`],
          executable_entry_present: facts.executable_entry_present,
          native_binary_present: facts.native_binary_present,
          repository_host: facts.repository_host,
          publisher_organization: null,
        };
      };
      delta = compareDependencyArtifacts(
        toArtifact(before.result, c.version_before),
        toArtifact(after.result, c.version_after),
      );
    }
    return {
      id: c.id,
      package: c.package,
      split: c.split,
      label: c.label,
      label_status: c.label,
      incident_mechanism: c.incident_mechanism ?? 'unknown',
      artifact_pair: !abstentions.length,
      delta,
      abstentions,
    };
  });
const count = (items) => items.reduce((a, x) => ((a[x] = (a[x] ?? 0) + 1), a), {});
const scored = rows.filter(
  (r) => cases.find((c) => c.id === r.id)?.source !== 'synthetic_from_real',
);
const evaluatorRows = rows.map((r) => {
  const c = cases.find((x) => x.id === r.id);
  const result = evaluateCase(
    {
      label_status: c.label_status ?? c.label,
      incident_mechanism: c.incident_mechanism ?? 'unknown',
      synthetic: c.source === 'synthetic_from_real',
      artifact_available: r.artifact_pair,
      artifact_provenance_verified: r.artifact_pair,
      registry_history_available: Object.keys(c.publish_timestamps ?? {}).length > 0,
      dependency_history_available: false,
      behavioral_delta_available: r.delta !== null,
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
  return {
    result,
    observed: r.delta?.behavior.length > 0 ? true : r.delta ? false : null,
    synthetic: c.source === 'synthetic_from_real',
  };
});
const out = {
  version: 3,
  corpus: 'incident-calibration-v3',
  incident_model_version: '0.13.0',
  holdout: FINAL,
  split_scope: FINAL ? 'holdout_only' : 'development_and_validation',
  cases: rows,
  coverage: {
    total_cases: cases.length,
    evaluated_cases: scored.length,
    by_label: count(cases.map((c) => c.label)),
    by_split: count(cases.map((c) => c.split)),
    artifact_pair_coverage: scored.filter((r) => r.artifact_pair).length,
    history_introduction_coverage: 0,
    behavior_delta_coverage: scored.filter((r) => r.delta !== null).length,
  },
  abstention_reasons: count(scored.flatMap((r) => r.abstentions)),
  metrics: calculateBinaryMetrics(
    scored.map((r) => ({
      expected: r.label === 'known_incident',
      observed: r.delta?.behavior.length > 0 ? true : r.delta ? false : null,
    })),
  ),
  evaluator_v2: summarizeEvaluator(evaluatorRows),
};
mkdirSync(join(root, 'results'), { recursive: true });
writeFileSync(
  FINAL ? finalPath : join(root, 'results', 'development-validation.json'),
  JSON.stringify(out, null, 2) + '\n',
  FINAL ? { flag: 'wx' } : undefined,
);
process.stdout.write(JSON.stringify(out.coverage, null, 2) + '\n');
