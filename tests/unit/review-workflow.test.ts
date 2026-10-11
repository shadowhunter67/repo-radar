import { describe, expect, it } from 'vitest';
import {
  causeOf,
  contested,
  disagreements,
  evaluate,
  type Case,
  type Prediction,
} from '../../src/calibration/metrics.js';
import {
  compareReviews,
  consolidateField,
  renderAdjudication,
  ReviewSubmissionSchema,
} from '../../src/calibration/review.js';
import { LabelSchema, type Label } from '../../src/calibration/schema.js';

const SHA = 'a'.repeat(40);
const label = (over: Record<string, unknown> = {}): Label =>
  LabelSchema.parse({
    repository: 'o/r',
    commit: SHA,
    split: 'holdout',
    tuned_on: false,
    labelled_on: '2026-10-11',
    review: { kind: 'ai-assisted-single', method: 'm', reviewers: ['ai'] },
    artifact_type: 'library',
    domain: 'web',
    capabilities: {},
    install_hooks: { automatic: 'no' },
    persistence: 'no',
    hard_coded_secrets: 'no',
    ...over,
  });
const sub = (id: string, over: Record<string, unknown> = {}) =>
  ReviewSubmissionSchema.parse({
    reviewer: { id, kind: 'human-single', labelled_on: '2026-10-12' },
    reviewed_at: '2026-10-12T09:30:00+07:00',
    label_version: '2',
    repo_sha: SHA,
    independent: true,
    decision_confidence: 'high',
    artifact_type: 'library',
    domain: 'web',
    capabilities: {},
    install_hooks: { automatic: 'no' },
    persistence: 'no',
    hard_coded_secrets: 'no',
    ...over,
  });

describe('review submissions carry provenance without personal data', () => {
  it('accepts timestamp, label version, commit, confidence and an identity v2 opinion', () => {
    const s = sub('rev-1', {
      field_confidence: { artifact_type: 'low' },
      identity_v2: {
        primary_artifact: 'cli',
        packaging: 'workspace',
        secondary_roles: ['library_api'],
      },
    });
    expect(s.repo_sha).toBe(SHA);
    expect(s.identity_v2?.primary_artifact).toBe('cli');
  });

  it('rejects an e-mail address as reviewer id and a malformed commit or timestamp', () => {
    expect(() => sub('person@example.com')).toThrow();
    expect(() => sub('rev', { repo_sha: 'abc' })).toThrow();
    expect(() => sub('rev', { reviewed_at: 'yesterday' })).toThrow();
  });

  it('a submission made against another commit is rejected, not compared', () => {
    const c = compareReviews(
      [label()],
      new Map([['o/r', sub('rev', { repo_sha: 'b'.repeat(40) })]]),
    );
    expect(c.repositories).toBe(0);
    expect(c.rejected[0]?.reason).toMatch(/not the pinned commit/);
    expect(renderAdjudication(c)).toMatch(/Rejected submissions/);
  });
});

describe('disagreement is represented, not forced into consensus', () => {
  it('consolidateField distinguishes agreed / disagreed / uncertain / needs_adjudication', () => {
    const o = (reviewer: string, value: string, confidence?: 'low' | 'high') => ({
      reviewer,
      value,
      ...(confidence ? { confidence } : {}),
    });
    expect(consolidateField('cli', [o('a', 'cli'), o('b', 'cli')])).toBe('agreed');
    expect(consolidateField('cli', [o('a', 'library'), o('b', 'library')])).toBe(
      'needs_adjudication',
    );
    expect(consolidateField('cli', [o('a', 'cli'), o('b', 'library')])).toBe('disagreed');
    expect(consolidateField('cli', [o('a', 'unknown')])).toBe('uncertain');
    expect(consolidateField('cli', [o('a', 'cli', 'low')])).toBe('uncertain');
  });

  it('two reviewers are compared independently and the AI-assisted label is never one of the opinions', () => {
    const c = compareReviews(
      [label()],
      new Map([
        ['o/r', [sub('rev-1', { persistence: 'yes' }), sub('rev-2', { persistence: 'no' })]],
      ]),
    );
    const st = c.consolidated.find((x) => x.field === 'persistence');
    expect(st?.status).toBe('disagreed');
    expect(st?.opinions.map((x) => x.reviewer)).toEqual(['rev-1', 'rev-2']);
    expect(c.disagreements.filter((d) => d.field === 'persistence').map((d) => d.reviewer)).toEqual(
      ['rev-1'],
    );
    expect(c.consolidated.find((x) => x.field === 'domain')?.status).toBe('agreed');
  });

  it('a low-confidence reviewer makes the field uncertain even when values match', () => {
    const c = compareReviews(
      [label()],
      new Map([['o/r', sub('rev', { field_confidence: { artifact_type: 'low' } })]]),
    );
    expect(c.consolidated.find((x) => x.field === 'artifact_type')?.status).toBe('uncertain');
  });
});

describe('calibration separates model error from label ambiguity', () => {
  const pred = (artifact: string): Prediction => ({
    artifact: { value: artifact, confidence: 0.6, alternatives: [] },
    domain: { value: 'web', confidence: 0.5, alternatives: [] },
    capabilities: {},
    automaticHooks: false,
    persistence: false,
    secrets: false,
    sourceCoverage: 1,
  });
  const cases = (l: Label, p: string): Case[] => [{ label: l, prediction: pred(p) }];

  it('contested fields are excluded from accuracy like "disputed"', () => {
    const l = label({ artifact_type: 'cli', field_status: { artifact_type: 'disagreed' } });
    expect(contested(l, 'artifact_type')).toBe(true);
    const e = evaluate(cases(l, 'library'));
    expect(e.artifact.n).toBe(0);
    expect(e.artifact.excluded).toBe(1);
    expect(disagreements(cases(l, 'library'))[0]?.cause).toBe('reviewers_disagree');
  });

  it('an unsettled label is "label_ambiguous"; a settled mismatch is "model_wrong"', () => {
    expect(causeOf(label({ field_status: { artifact_type: 'uncertain' } }), 'artifact_type')).toBe(
      'label_ambiguous',
    );
    expect(causeOf(label(), 'artifact_type')).toBe('model_wrong');
    const l = label({ artifact_type: 'cli', field_status: { artifact_type: 'agreed' } });
    expect(disagreements(cases(l, 'library'))[0]?.cause).toBe('model_wrong');
  });

  it('opinions can be stored side by side on a label', () => {
    const l = label({
      opinions: [
        { field: 'artifact_type', reviewer: 'rev-1', value: 'cli', confidence: 'high' },
        { field: 'artifact_type', reviewer: 'rev-2', value: 'library' },
      ],
      field_status: { artifact_type: 'disagreed' },
    });
    expect(l.opinions).toHaveLength(2);
  });
});
