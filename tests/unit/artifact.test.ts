import { describe, expect, it } from 'vitest';
import type { RepoSnapshot } from '../../src/collectors/types.js';
import { parseManifest } from '../../src/collectors/manifests/parse.js';
import { HeuristicClassifier, loadDefaultTaxonomy } from '../../src/identity/index.js';

const classifier = new HeuristicClassifier(loadDefaultTaxonomy());
const pkg = (file: string, extra: Record<string, unknown> = {}) =>
  parseManifest(file, JSON.stringify({ name: file.replace(/\W/g, '-'), ...extra }))!;

function snap(over: Partial<RepoSnapshot> = {}): RepoSnapshot {
  return {
    owner: 'o',
    repo: 'r',
    displayName: 'r',
    topics: [],
    treePaths: [],
    manifests: [],
    hasDockerfile: false,
    hasActionYml: false,
    defaultBranch: 'main',
    htmlUrl: 'https://github.com/o/r',
    ...over,
  };
}

describe('artifact classification', () => {
  it('sample manifests under examples/ and tests/ do not make a monorepo (flask-like layout)', () => {
    const id = classifier.classify(
      snap({
        description: 'A simple framework for building complex web applications.',
        topics: ['web-framework', 'http-server'],
        manifests: [
          pkg('package.json'),
          pkg('examples/celery/package.json'),
          pkg('examples/javascript/package.json'),
          pkg('examples/tutorial/package.json'),
          pkg('tests/test_apps/package.json'),
        ],
      }),
    );
    expect(id.canonical_type).toBe('web-framework');
    expect(id.artifact_type).toBe('framework');
    expect(id.domain).toBe('web');
  });

  it('real workspace packages do make a monorepo, with the alternative exposed', () => {
    const id = classifier.classify(
      snap({
        description: 'Tooling',
        manifests: ['a', 'b', 'c'].map((n) => pkg(`packages/${n}/package.json`)),
      }),
    );
    expect(id.artifact_type).toBe('monorepo');
    expect(id.artifact_alternatives).toContain('library');
  });

  it('a taxonomy hint outranks a small number of nested packages, a large workspace outranks the hint', () => {
    const few = classifier.classify(
      snap({
        description: 'A web framework for http servers',
        manifests: ['a', 'b', 'c'].map((n) => pkg(`packages/${n}/package.json`)),
      }),
    );
    expect(few.artifact_type).toBe('framework');
    const many = classifier.classify(
      snap({
        description: 'A web framework for http servers',
        manifests: ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => pkg(`packages/${n}/package.json`)),
      }),
    );
    expect(many.artifact_type).toBe('monorepo');
  });

  it('a publishable root that ships a CLI stays a CLI with a workspace layout; a private root is a monorepo', () => {
    const nested = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => pkg(`crates/${n}/package.json`));
    const shipping = classifier.classify(
      snap({
        description: 'Search tool',
        manifests: [pkg('package.json', { bin: { rg: 'rg.js' } }), ...nested],
      }),
    );
    expect(shipping.artifact_type).toBe('cli');
    expect(shipping.artifact_alternatives).toContain('monorepo');
    const priv = classifier.classify(
      snap({
        description: 'Search tool',
        manifests: [pkg('package.json', { bin: { rg: 'rg.js' }, private: true }), ...nested],
      }),
    );
    expect(priv.artifact_type).toBe('monorepo');
  });

  it('exposes runner-up domains with shares instead of a single forced label', () => {
    const id = classifier.classify(
      snap({
        description: 'LLM agent framework with a vector database',
        topics: ['llm', 'agents', 'vector-database'],
      }),
    );
    expect(id.alternatives.length).toBeGreaterThanOrEqual(2);
    expect(id.alternatives.reduce((a, c) => a + c.share, 0)).toBeGreaterThan(0.95);
  });

  it('a package with "command-line" wording but no bin entry is a library, not a CLI (execa-like)', () => {
    const id = classifier.classify(
      snap({
        description: 'Process execution for humans: a command-line friendly child process library',
        manifests: [pkg('package.json', { description: 'Process execution for humans' })],
      }),
    );
    expect(id.interfaces).toEqual(['library']);
    expect(id.artifact_type).toBe('library');
    expect(id.artifact_alternatives).toContain('cli');
  });

  it('a package with a bin entry and CLI wording stays a CLI', () => {
    const id = classifier.classify(
      snap({
        description: 'A command-line tool for fuzzy finding',
        manifests: [pkg('package.json', { bin: { ff: 'cli.js' } })],
      }),
    );
    expect(id.artifact_type).toBe('cli');
  });

  it('action repositories are plugins; container-only repositories are containers', () => {
    expect(classifier.classify(snap({ hasActionYml: true })).artifact_type).toBe('plugin');
    expect(classifier.classify(snap({ hasDockerfile: true })).artifact_type).toBe('container');
  });
});
