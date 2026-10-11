import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  depPredictionFrom,
  evaluateDependencies,
  type DepPrediction,
} from '../../src/calibration/dep-metrics.js';
import { loadCorpus } from '../../src/calibration/load.js';
import {
  compareReviews,
  renderAdjudication,
  ReviewSubmissionSchema,
} from '../../src/calibration/review.js';
import { LabelSchema } from '../../src/calibration/schema.js';
import { packageRoot } from '../../src/util/paths.js';

const root = join(packageRoot(), 'calibration');
const fresh = loadCorpus(join(root, 'fresh-holdout-0.4'));
const main = loadCorpus(root);

describe('fresh holdout corpus (methodology 0.4)', () => {
  it('loads cleanly, is pinned, is entirely holdout and has the intended size', () => {
    expect(fresh.problems).toEqual([]);
    expect(fresh.labels.length).toBeGreaterThanOrEqual(10);
    expect(fresh.labels.length).toBeLessThanOrEqual(15);
    for (const l of fresh.labels) {
      expect(l.commit, l.repository).toMatch(/^[0-9a-f]{40}$/);
      expect(l.split, l.repository).toBe('holdout');
      expect(l.tuned_on, l.repository).toBe(false);
    }
    expect(fresh.dataset).toMatchObject({
      corpus_id: 'fresh-holdout-0.4',
      for_methodology: '0.4',
      fixed_split: 'holdout',
    });
  });

  it('shares no repository with the earlier corpus and excludes repositories whose analyzer output was already inspected', () => {
    const earlier = new Set(main.labels.map((l) => l.repository.toLowerCase()));
    for (const l of fresh.labels)
      expect(earlier.has(l.repository.toLowerCase()), l.repository).toBe(false);
    const observed = [
      'mongodb/node-mongodb-native',
      'mongodb/mongo-go-driver',
      'mongodb/mongo-python-driver',
      'mongodb/mongo-tools',
      'ruby/ruby.wasm',
      'onnx/onnx',
      'google/brotli',
      'jrsoftware/issrc',
    ];
    for (const r of observed)
      expect(
        fresh.labels.some((l) => l.repository === r),
        r,
      ).toBe(false);
    expect(fresh.dataset.selection_notes).toContain('Excluded on purpose');
  });

  it('covers the intended variety, including real SBOMs of different formats and a lockfile-less and a locked project per ecosystem', () => {
    const cats = new Set(fresh.dataset.repositories.flatMap((r) => r.categories));
    for (const c of [
      'npm-lockfile',
      'npm-no-lockfile',
      'python-lockfile',
      'python-no-lockfile',
      'cargo-workspace',
      'go-module',
      'sbom-cyclonedx',
      'sbom-spdx',
      'examples-scope',
      'large-tree',
      'cli',
      'library',
      'service',
    ])
      expect(cats.has(c), c).toBe(true);
    const formats = new Set(fresh.labels.map((l) => l.dependencies?.sbom_format));
    expect(formats.has('CycloneDX')).toBe(true);
    expect(formats.has('SPDX')).toBe(true);
    expect(fresh.labels.some((l) => l.dependencies?.has_lockfile === 'no')).toBe(true);
    expect(fresh.labels.some((l) => l.dependencies?.has_lockfile === 'yes')).toBe(true);
  });

  it('every label has a dependency block and admits uncertainty instead of guessing', () => {
    for (const l of fresh.labels) expect(l.dependencies, l.repository).toBeDefined();
    const values = fresh.labels.flatMap((l) => Object.values(l.capabilities));
    expect(values.some((v) => v === 'unknown')).toBe(true);
    expect(fresh.labels.some((l) => l.dependencies?.sbom_consistency === 'disputed')).toBe(true);
    for (const l of fresh.labels) expect(l.review.kind).toBe('ai-assisted-single');
  });

  it('never records content of environment files (policy) in a label', () => {
    for (const l of fresh.labels) expect(l.ambiguity_notes).not.toMatch(/[A-Z_]{4,}=\S+/);
  });
});

const pred = (over: Partial<DepPrediction> = {}): DepPrediction => ({
  lockfiles: ['package-lock.json'],
  sbomParsed: false,
  sbomFormats: [],
  sbomComparison: null,
  primaryManifests: 1,
  direct: 10,
  directRegistry: 10,
  exactRatio: 1,
  checkedRatio: 1,
  auxiliary: 0,
  missingFromSbom: 0,
  additionalSbomComponents: 0,
  vulnerableTotal: 0,
  ...over,
});
const labelWith = (dependencies: Record<string, unknown>) =>
  LabelSchema.parse({
    repository: 'o/r',
    commit: 'a'.repeat(40),
    split: 'holdout',
    tuned_on: false,
    labelled_on: '2026-10-11',
    review: { kind: 'ai-assisted-single', method: 't', reviewers: ['t'] },
    artifact_type: 'library',
    domain: 'web',
    capabilities: {},
    install_hooks: { automatic: 'no' },
    persistence: 'no',
    hard_coded_secrets: 'no',
    dependencies,
  });

describe('dependency / SBOM metrics', () => {
  it('scores lockfile, SBOM, exact-version and coverage detectors and keeps unknown out of the denominator', () => {
    const e = evaluateDependencies([
      {
        label: labelWith({
          has_lockfile: 'yes',
          has_sbom: 'no',
          sbom_format: 'none',
          exact_version_expected: 'yes',
          osv_checkable: 'yes',
          dependency_manifest_count: 1,
          direct_dependency_count_expected: 10,
        }),
        prediction: pred(),
      },
      {
        label: labelWith({
          has_lockfile: 'no',
          has_sbom: 'yes',
          sbom_format: 'CycloneDX',
          sbom_consistency: 'mismatch',
        }),
        prediction: pred({
          lockfiles: ['yarn.lock'],
          sbomParsed: true,
          sbomFormats: ['CycloneDX'],
          sbomComparison: 'partial',
          exactRatio: 0.2,
          checkedRatio: 0.2,
        }),
      },
      { label: labelWith({ has_lockfile: 'unknown', has_sbom: 'unknown' }), prediction: pred() },
    ]);
    expect(e.repositories).toBe(3);
    expect(e.detectors['has_lockfile']).toMatchObject({ n: 2, tp: 1, fp: 1, excluded: 1 });
    expect(e.detectors['has_sbom']).toMatchObject({ n: 2, tp: 1, tn: 1, excluded: 1 });
    expect(e.sbomFormat).toMatchObject({ n: 2, correct: 2, excluded: 1 });
    expect(e.sbomConsistency).toMatchObject({ n: 1, correct: 0 });
    expect(e.sbomConsistency.confusion).toEqual({ mismatch: { partial: 1 } });
    expect(e.dependencyManifestCount).toMatchObject({ n: 1, exact: 1 });
    expect(e.directDependencyCount).toMatchObject({ n: 1, exact: 1, within10pct: 1 });
    expect(e.coverage.exactRatioWhenExpected).toBe(1);
  });

  it('a report without dependency_intel (older schema) yields no prediction instead of crashing', () => {
    expect(depPredictionFrom({} as never)).toBeUndefined();
    expect(
      evaluateDependencies([{ label: labelWith({ has_lockfile: 'yes' }), prediction: undefined }])
        .repositories,
    ).toBe(0);
  });
});

describe('blind review comparison', () => {
  const base = labelWith({ has_lockfile: 'yes', has_sbom: 'no' });
  const submission = (over: Record<string, unknown> = {}) =>
    ReviewSubmissionSchema.parse({
      reviewer: { id: 'rev1', kind: 'human-single', labelled_on: '2026-10-12' },
      artifact_type: 'library',
      domain: 'web',
      capabilities: {},
      install_hooks: { automatic: 'no' },
      persistence: 'no',
      hard_coded_secrets: 'no',
      dependencies: { has_lockfile: 'yes', has_sbom: 'no' },
      ...over,
    });

  it('counts agreement, keeps unknown out of it, and lists decided disagreements for adjudication', () => {
    const c = compareReviews(
      [base],
      new Map([
        [
          'o/r',
          submission({
            persistence: 'yes',
            hard_coded_secrets: 'unknown',
            dependencies: { has_lockfile: 'no', has_sbom: 'no' },
          }),
        ],
      ]),
    );
    expect(c.repositories).toBe(1);
    expect(c.disagreements.map((d) => d.field).sort()).toEqual([
      'dependencies.has_lockfile',
      'persistence',
    ]);
    expect(c.fields.find((f) => f.field === 'hard_coded_secrets')).toMatchObject({
      undecided: 1,
      comparable: 0,
    });
    expect(c.kappaYesNo).not.toBeNull();
    expect(renderAdjudication(c)).toMatch(/\| o\/r \| persistence \| no \| yes \|/);
  });

  it('a submission cannot claim to be AI-assisted: only human reviewer kinds validate', () => {
    expect(
      ReviewSubmissionSchema.safeParse({
        ...submission(),
        reviewer: { id: 'x', kind: 'ai-assisted-single', labelled_on: 'd' },
      }).success,
    ).toBe(false);
  });
});
