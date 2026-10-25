import { describe, expect, it } from 'vitest';
import { analyzeNames } from '../../src/registry/name-model.js';
import { comparePackageNames, damerauLevenshtein } from '../../src/registry/names.js';
import { buildNameFindings, deriveNameFacts } from '../../src/registry/name-findings.js';

describe('package-name intelligence', () => {
  it('reports exact independent signals for known lookalikes', () => {
    expect(comparePackageNames('lodash', '1odash', 'npm').signals).toEqual(['edit_distance']);
    expect(comparePackageNames('react', 'raect', 'npm').signals).toEqual(['edit_distance']);
    expect(comparePackageNames('request', 'requests', 'pypi').signals).toEqual([
      'edit_distance',
      'prefix_suffix_trick',
    ]);
    expect(comparePackageNames('pyyaml', 'PyYAML', 'pypi').signals).toEqual([]);
    expect(comparePackageNames('serde_json', 'serde-json', 'crates.io').signals).toEqual([
      'separator_variation',
    ]);
    expect(comparePackageNames('@types/node', 'node', 'npm').signals).toEqual(['scope_confusion']);
  });
  it('uses proper Damerau distance and limits keyboard adjacency to one substitution', () => {
    expect(damerauLevenshtein('ab', 'ba')).toBe(1);
    expect(damerauLevenshtein('react', 'raect')).toBe(1);
    expect(comparePackageNames('react', 'reavt', 'npm').signals).toEqual([
      'edit_distance',
      'keyboard_adjacency',
    ]);
    expect(comparePackageNames('chalk', 'chai', 'npm').signals).toEqual([]);
    expect(comparePackageNames('colors', 'colour', 'npm').signals).toEqual(['edit_distance']);
  });
  it('detects a Cyrillic homoglyph and suppresses legitimate rename/deprecation history', () => {
    expect(comparePackageNames('аbc', 'abc', 'npm').signals).toEqual(['homoglyph']);
    expect(
      comparePackageNames('old-name', 'new-name', 'npm', { sameRepositoryNames: ['new-name'] })
        .suppression_reason,
    ).toBe('same_repository_history');
    expect(
      comparePackageNames('old-name', 'new-name', 'npm', { deprecatedUse: 'new-name' })
        .suppression_reason,
    ).toBe('deprecated_use');
  });
  it('emits exact finding wording and withholds absence until all comparisons are complete', () => {
    const analyzed = analyzeNames(
      [{ name: 'react', ecosystem: 'npm', evidence: 'dep:react' }],
      [{ name: 'raect', ecosystem: 'npm' }],
    );
    expect(analyzed.signals[0]?.signals).toEqual(['edit_distance']);
    expect(deriveNameFacts(analyzed)[0]).toMatchObject({
      id: 'registry.deps.name_confusion_present',
      value: true,
    });
    expect(buildNameFindings(analyzed)[0]?.summary).toContain('possible package-name confusion');
    const empty = analyzeNames([{ name: 'react', ecosystem: 'npm' }], []);
    expect(deriveNameFacts(empty)[0]).toMatchObject({
      id: 'registry.deps.name_confusion_present',
      value: false,
    });
  });
});

describe('package-name intelligence: short names', () => {
  it('names under five characters get no edit-distance, prefix or keyboard noise', () => {
    expect(comparePackageNames('abc', 'abd', 'npm').signals).toEqual([]);
    expect(comparePackageNames('jest', 'jes', 'npm').signals).toEqual([]);
  });
});

describe('package-name intelligence: scope confusion needs the same base name', () => {
  it('does not report unrelated scoped and unscoped names (dogfood false positive: 197 findings)', () => {
    expect(comparePackageNames('openpgp', '@eslint/js', 'npm').signals).toEqual([]);
    expect(comparePackageNames('openpgp', '@types/node', 'npm').signals).toEqual([]);
    expect(comparePackageNames('@esbuild/aix-ppc64', '@esbuild/darwin-x64', 'npm').signals).toEqual(
      [],
    );
  });
  it('still reports the same base name under a different or missing scope', () => {
    expect(comparePackageNames('@types/node', 'node', 'npm').signals).toEqual(['scope_confusion']);
    expect(comparePackageNames('@a/widget', '@b/widget', 'npm').signals).toContain(
      'scope_confusion',
    );
  });
});
