import { describe, expect, it } from 'vitest';
import { analyzeCode } from '../../src/analysis/index.js';
import type { ScannedFile } from '../../src/analysis/types.js';
import { EvidenceStore } from '../../src/evidence/store.js';
import {
  ABSENCE_MIN_COVERAGE,
  ABSENCE_MIN_FILES,
  deriveFacts,
  notObservedConfidence,
} from '../../src/facts/index.js';
import { scoreValue } from '../../src/scoring/engine.js';
import { loadRuleSet } from '../../src/scoring/rules.js';

const jsFile = (i: number): ScannedFile => ({
  path: `src/f${i}.js`,
  content: 'const a = 1;\n',
  size: 13,
  role: 'source',
});
const facts = (nFiles: number, total: number) =>
  deriveFacts({
    store: new EvidenceStore(),
    code: analyzeCode({
      manifests: [],
      files: Array.from({ length: nFiles }, (_, i) => jsFile(i)),
      treePaths: Array.from({ length: nFiles }, (_, i) => `src/f${i}.js`),
      sourceFilesTotal: total,
      fetch: { skippedTooLarge: 0, skippedOverBudget: 0 },
    }),
    artifact: { type: 'library', confidence: 0.5 },
  });
const reliable = (nFiles: number, total: number): boolean =>
  facts(nFiles, total).find((f) => f.id === 'scan.absence_reliable')!.value as boolean;
const has = (nFiles: number, total: number, id: string): boolean =>
  facts(nFiles, total).some((f) => f.id === id);

describe('absence gating boundaries', () => {
  it('constants are what the documentation says', () => {
    expect(ABSENCE_MIN_COVERAGE).toBe(0.2);
    expect(ABSENCE_MIN_FILES).toBe(3);
  });

  it('exactly 20% coverage with 3 files is reliable; just below, or fewer than 3 files, is not', () => {
    expect(reliable(3, 15)).toBe(true); // 0.2, 3 files
    expect(reliable(3, 16)).toBe(false); // 0.1875
    expect(reliable(2, 2)).toBe(false); // 100% but only 2 files
    expect(reliable(3, 3)).toBe(true);
    expect(reliable(0, 0)).toBe(false);
  });

  it('withheld absence facts disappear while presence-independent facts remain', () => {
    expect(has(2, 2, 'secret.candidates.count')).toBe(false);
    expect(has(2, 2, 'capability.persistence.observed')).toBe(false);
    expect(has(2, 2, 'execution.chain.install_time')).toBe(false);
    expect(has(2, 2, 'execution.install_hooks.max_risk')).toBe(true);
    expect(has(2, 2, 'scan.source_coverage')).toBe(true);
    expect(has(3, 3, 'secret.candidates.count')).toBe(true);
  });

  it('confidence of a "not found" fact follows coverage between 0.3 and 0.8', () => {
    expect(notObservedConfidence(0)).toBe(0.3);
    expect(notObservedConfidence(1)).toBe(0.8);
    expect(notObservedConfidence(0.5)).toBe(0.55);
    expect(notObservedConfidence(7)).toBe(0.8);
    expect(notObservedConfidence(-1)).toBe(0.3);
  });
});

describe('thresholds of the new scored rules', () => {
  const rules = new Map(loadRuleSet().rules.map((r) => [r.id, r]));
  const score = (id: string, v: number | boolean): number =>
    scoreValue(v, rules.get(id)!.scoring) as number;

  it('supply-chain.install-hooks: none 10, low 8, medium 4, high 1', () => {
    expect([0, 1, 2, 3].map((v) => score('supply-chain.install-hooks', v))).toEqual([10, 8, 4, 1]);
    expect(rules.get('supply-chain.install-hooks')!.warn!.below).toBe(5);
  });

  it('security.hardcoded-secrets: 0 -> 10, 1 or 2 -> 2, 3 and more -> 0', () => {
    expect([0, 1, 2, 3, 50].map((v) => score('security.hardcoded-secrets', v))).toEqual([
      10, 2, 2, 0, 0,
    ]);
  });

  it('security.install-time-download-execute: true 0, false 10', () => {
    expect([
      score('security.install-time-download-execute', true),
      score('security.install-time-download-execute', false),
    ]).toEqual([0, 10]);
  });

  it('informational capability rules never carry weight', () => {
    for (const id of [
      'security.download-execute-chain',
      'security.persistence-capability',
      'security.credential-access-capability',
      'security.browser-data-capability',
    ]) {
      expect(rules.get(id)!.informational, id).toBe(true);
      expect(rules.get(id)!.weight, id).toBe(0);
    }
  });
});
