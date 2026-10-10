import { describe, expect, it } from 'vitest';
import {
  addBinary,
  calibration,
  emptyCounts,
  evaluate,
  prf,
  renderMarkdown,
  type Case,
  type Prediction,
} from '../../src/calibration/metrics.js';
import {
  assignSplit,
  DatasetSchema,
  LabelSchema,
  type Label,
} from '../../src/calibration/schema.js';

const baseLabel = (over: Partial<Label> = {}): Label =>
  LabelSchema.parse({
    repository: 'o/r',
    commit: 'a'.repeat(40),
    split: 'dev',
    tuned_on: false,
    labelled_on: '2026-10-10',
    review: { kind: 'ai-assisted-single', method: 'test', reviewers: ['t'] },
    artifact_type: 'library',
    domain: 'web',
    capabilities: {},
    install_hooks: { automatic: 'no' },
    persistence: 'no',
    hard_coded_secrets: 'no',
    ...over,
  });
const basePred = (over: Partial<Prediction> = {}): Prediction => ({
  artifact: { value: 'library', confidence: 0.8, alternatives: [] },
  domain: { value: 'web', confidence: 0.6, alternatives: [] },
  capabilities: {},
  automaticHooks: false,
  persistence: false,
  secrets: false,
  sourceCoverage: 1,
  ...over,
});

describe('abstention', () => {
  it('an "unknown" answer is reported separately: neither correct nor wrong', () => {
    const unknown = basePred({ artifact: { value: 'unknown', confidence: 0.2, alternatives: [] } });
    const e = evaluate([
      { label: baseLabel(), prediction: unknown },
      { label: baseLabel(), prediction: basePred() },
      { label: baseLabel({ artifact_type: 'cli' }), prediction: basePred() },
    ]);
    expect(e.artifact).toMatchObject({ n: 3, abstained: 1, correct: 1 });
    expect(e.artifact.accuracy).toBeCloseTo(0.5);
    expect(e.artifact.accuracyOverall).toBeCloseTo(1 / 3);
    expect(e.artifact.calibration.n).toBe(2);
  });
});

describe('binary metrics', () => {
  it('counts tp/fp/fn/tn and derives precision and recall exactly', () => {
    const c = emptyCounts();
    for (const [pred, lab] of [
      [true, 'yes'],
      [true, 'yes'],
      [true, 'yes'],
      [true, 'no'],
      [false, 'yes'],
      [false, 'no'],
      [false, 'no'],
    ] as const)
      addBinary(c, pred, lab);
    expect(c).toMatchObject({ tp: 3, fp: 1, fn: 1, tn: 2, n: 7, excluded: 0 });
    const m = prf(c);
    expect(m.precision).toBeCloseTo(0.75);
    expect(m.recall).toBeCloseTo(0.75);
    expect(m.f1).toBeCloseTo(0.75);
  });

  it('the issue-text example: 10 true, 8 found -> recall 80%; 10 reported, 8 correct -> precision 80%', () => {
    const rec = emptyCounts();
    for (let i = 0; i < 10; i++) addBinary(rec, i < 8, 'yes');
    expect(prf(rec).recall).toBeCloseTo(0.8);
    const pre = emptyCounts();
    for (let i = 0; i < 10; i++) addBinary(pre, true, i < 8 ? 'yes' : 'no');
    expect(prf(pre).precision).toBeCloseTo(0.8);
  });

  it('unknown and disputed labels are excluded and counted, never scored', () => {
    const c = emptyCounts();
    addBinary(c, true, 'unknown');
    addBinary(c, false, 'disputed');
    addBinary(c, true, 'yes');
    expect(c).toMatchObject({ n: 1, excluded: 2, tp: 1 });
  });

  it('undefined ratios stay null instead of becoming 0 or 100', () => {
    expect(prf(emptyCounts())).toMatchObject({ precision: null, recall: null, f1: null });
    const c = emptyCounts();
    addBinary(c, false, 'no');
    expect(prf(c).precision).toBeNull();
    expect(prf(c).recall).toBeNull();
  });
});

describe('confidence calibration', () => {
  it('bins by confidence and reports accuracy per bin, ECE and Brier', () => {
    const pts = [
      ...Array.from({ length: 10 }, (_, i) => ({ confidence: 0.9, correct: i < 9 })), // calibrated: 90% / 90%
      ...Array.from({ length: 10 }, (_, i) => ({ confidence: 0.9, correct: i < 5 })), // overconfident half
    ];
    const s = calibration(pts);
    expect(s.n).toBe(20);
    const top = s.bins[4]!;
    expect(top.n).toBe(20);
    expect(top.meanConfidence).toBeCloseTo(0.9);
    expect(top.accuracy).toBeCloseTo(0.7);
    expect(s.ece).toBeCloseTo(0.2);
    expect(s.brier).toBeGreaterThan(0.1);
  });

  it('a perfectly calibrated set has ECE near 0 and empty input gives nulls', () => {
    const pts = [
      ...Array.from({ length: 10 }, (_, i) => ({ confidence: 0.5, correct: i < 5 })),
      ...Array.from({ length: 10 }, () => ({ confidence: 1, correct: true })),
    ];
    expect(calibration(pts).ece).toBeCloseTo(0);
    expect(calibration([])).toMatchObject({ n: 0, ece: null, brier: null });
  });

  it('clamps out-of-range confidence into the first or last bin', () => {
    const s = calibration([
      { confidence: 7, correct: true },
      { confidence: -1, correct: false },
    ]);
    expect(s.bins[4]!.n).toBe(1);
    expect(s.bins[0]!.n).toBe(1);
  });
});

describe('evaluate()', () => {
  const cases: Case[] = [
    { label: baseLabel(), prediction: basePred() },
    {
      label: baseLabel({ artifact_type: 'cli', domain: 'developer-tooling' }),
      prediction: basePred(),
    },
    { label: baseLabel({ artifact_type: 'unknown' }), prediction: basePred() },
    {
      label: baseLabel({ artifact_type: 'framework', artifact_also_acceptable: ['library'] }),
      prediction: basePred(),
    },
  ];

  it('artifact accuracy excludes unknown, honours acceptable alternatives and keeps a confusion matrix', () => {
    const e = evaluate(cases);
    expect(e.artifact).toMatchObject({ n: 3, excluded: 1, correct: 2 });
    expect(e.artifact.accuracy).toBeCloseTo(2 / 3);
    expect(e.artifact.confusion['cli']).toEqual({ library: 1 });
  });

  it('predicted alternatives raise top-k but not headline accuracy', () => {
    const e = evaluate([
      {
        label: baseLabel({ artifact_type: 'cli' }),
        prediction: basePred({
          artifact: { value: 'library', confidence: 0.3, alternatives: ['cli'] },
        }),
      },
    ]);
    expect(e.artifact.accuracy).toBe(0);
    expect(e.artifact.topKCorrect).toBe(1);
  });

  it('capability metrics use only labelled capabilities and split by scan coverage', () => {
    const lab = baseLabel({
      capabilities: { PROCESS_EXEC: 'yes', NETWORK_CLIENT: 'no', PERSISTENCE: 'unknown' },
    });
    const hi = basePred({
      sourceCoverage: 0.9,
      capabilities: {
        PROCESS_EXEC: { predicted: true, confidence: 0.85 },
        NETWORK_CLIENT: { predicted: false, confidence: 0 },
        PERSISTENCE: { predicted: true, confidence: 0.7 },
      },
    });
    const lo = basePred({
      sourceCoverage: 0.1,
      capabilities: {
        PROCESS_EXEC: { predicted: false, confidence: 0 },
        NETWORK_CLIENT: { predicted: true, confidence: 0.8 },
      },
    });
    const e = evaluate([
      { label: lab, prediction: hi },
      { label: lab, prediction: lo },
    ]);
    expect(e.capabilities['PROCESS_EXEC']).toMatchObject({ tp: 1, fn: 1, n: 2 });
    expect(e.capabilities['NETWORK_CLIENT']).toMatchObject({ fp: 1, tn: 1 });
    expect(e.capabilities['PERSISTENCE']).toMatchObject({ n: 0, excluded: 1 });
    expect(e.capabilitiesByCoverage.high).toMatchObject({ tp: 1, tn: 1 });
    expect(e.capabilitiesByCoverage.low).toMatchObject({ fn: 1, fp: 1 });
    // only positive predictions enter confidence calibration: 1 correct (0.85) + 1 wrong (0.8)
    expect(e.capabilityConfidence.n).toBe(2);
  });

  it('install hooks, persistence and secrets are scored as binary detectors', () => {
    const e = evaluate([
      {
        label: baseLabel({ install_hooks: { automatic: 'yes', names: ['postinstall'] } }),
        prediction: basePred({ automaticHooks: true }),
      },
      {
        label: baseLabel({ install_hooks: { automatic: 'yes', names: ['install'] } }),
        prediction: basePred({ automaticHooks: false }),
      },
      { label: baseLabel({ hard_coded_secrets: 'no' }), prediction: basePred({ secrets: true }) },
    ]);
    expect(e.installHooks).toMatchObject({ tp: 1, fn: 1, tn: 1 });
    expect(e.secrets).toMatchObject({ fp: 1, tn: 2, n: 3 });
  });

  it('renders a markdown report that states sample sizes and n/a for undefined metrics', () => {
    const md = renderMarkdown('dev', evaluate(cases));
    expect(md).toContain('### dev (4 repositories)');
    expect(md).toMatch(/\| artifact type \| 3 \| 1 \|/);
    expect(md).toContain('n/a');
  });
});

describe('dataset schema and splits', () => {
  it('assignSplit is stable, case-insensitive and forces tuned repositories into dev', () => {
    expect(assignSplit('pallets/flask', false)).toBe(assignSplit('Pallets/Flask', false));
    expect(assignSplit('anything/x', true)).toBe('dev');
    const spread = { dev: 0, validation: 0, holdout: 0 };
    for (let i = 0; i < 2000; i++) spread[assignSplit(`owner/repo-${i}`, false)]++;
    expect(spread.dev).toBeGreaterThan(600);
    expect(spread.validation).toBeGreaterThan(450);
    expect(spread.holdout).toBeGreaterThan(450);
  });

  it('labels reject malformed commits, unknown artifact types and unknown capabilities', () => {
    expect(() => baseLabel({ commit: 'main' })).toThrow();
    expect(() => baseLabel({ artifact_type: 'widget' as never })).toThrow();
    expect(() => baseLabel({ capabilities: { TELEPORT: 'yes' } as never })).toThrow();
    expect(() => baseLabel({ hard_coded_secrets: 'maybe' as never })).toThrow();
  });

  it('dataset requires at least one repository and well-formed names', () => {
    expect(() =>
      DatasetSchema.parse({ version: '1', selection_notes: 'x', repositories: [] }),
    ).toThrow();
    expect(() =>
      DatasetSchema.parse({
        version: '1',
        selection_notes: 'x',
        repositories: [{ repo: 'bad name', categories: [] }],
      }),
    ).toThrow();
  });
});
