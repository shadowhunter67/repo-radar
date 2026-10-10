import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCorpus } from '../../src/calibration/load.js';
import { assignSplit } from '../../src/calibration/schema.js';
import { packageRoot } from '../../src/util/paths.js';

const corpus = loadCorpus(join(packageRoot(), 'calibration'));

describe('calibration corpus v0 (dataset, pins, labels)', () => {
  it('every dataset repository has exactly one valid label and a pinned commit, with no inconsistencies', () => {
    expect(corpus.problems).toEqual([]);
    expect(corpus.labels.length).toBe(corpus.dataset.repositories.length);
  });

  it('is the intended size and pins every repository to a full commit SHA', () => {
    expect(corpus.labels.length).toBeGreaterThanOrEqual(30);
    expect(corpus.labels.length).toBeLessThanOrEqual(50);
    for (const l of corpus.labels) expect(l.commit, l.repository).toMatch(/^[0-9a-f]{40}$/);
    for (const [repo, p] of Object.entries(corpus.pins.repos))
      expect(p.error, repo).toBeUndefined();
  });

  it('splits follow the documented rule; tuned-on repositories are dev only; every split is populated', () => {
    const counts = { dev: 0, validation: 0, holdout: 0 };
    for (const l of corpus.labels) {
      counts[l.split]++;
      expect(l.split, l.repository).toBe(assignSplit(l.repository, l.tuned_on));
      if (l.tuned_on) expect(l.split, l.repository).toBe('dev');
    }
    expect(counts.dev).toBeGreaterThanOrEqual(10);
    expect(counts.validation).toBeGreaterThanOrEqual(8);
    expect(counts.holdout).toBeGreaterThanOrEqual(8);
  });

  it('covers the intended variety (categories, ecosystems, tiny repos, archived, intentionally vulnerable, installers)', () => {
    const cats = new Set(corpus.dataset.repositories.flatMap((r) => r.categories));
    for (const c of [
      'library',
      'cli',
      'service',
      'monorepo',
      'archived',
      'intentionally-vulnerable',
      'installer',
      'install-hook',
      'minimal',
      'supply-chain-incident',
      'security-tool',
      'native-addon',
    ])
      expect(cats.has(c), c).toBe(true);
    const artifacts = new Set(corpus.labels.map((l) => l.artifact_type));
    expect(artifacts.size).toBeGreaterThanOrEqual(7);
  });

  it('labels admit uncertainty: unknown/disputed are used, and no label claims certainty it cannot have', () => {
    let unknown = 0;
    let total = 0;
    for (const l of corpus.labels) {
      for (const v of Object.values(l.capabilities)) {
        total++;
        if (v === 'unknown' || v === 'disputed') unknown++;
      }
    }
    expect(unknown).toBeGreaterThan(0);
    expect(unknown / total).toBeLessThan(0.5);
    for (const l of corpus.labels) expect(l.review.kind, l.repository).toBe('ai-assisted-single');
  });

  it('install hooks labelled automatic list their names, and "no" lists none', () => {
    for (const l of corpus.labels) {
      if (l.install_hooks.automatic === 'yes')
        expect(l.install_hooks.names.length, l.repository).toBeGreaterThan(0);
      if (l.install_hooks.automatic === 'no')
        expect(l.install_hooks.names, l.repository).toEqual([]);
    }
  });
});
