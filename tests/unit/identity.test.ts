/* eslint-disable no-control-regex -- tests deliberately assert on control characters */
import { describe, expect, it } from 'vitest';
import type { RepoSnapshot } from '../../src/collectors/types.js';
import {
  HeuristicClassifier,
  loadDefaultTaxonomy,
  normalizeName,
} from '../../src/identity/index.js';
import { parseTaxonomy } from '../../src/identity/taxonomy.js';
import { parseManifest } from '../../src/collectors/manifests/parse.js';

const classifier = new HeuristicClassifier(loadDefaultTaxonomy());

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

describe('normalizeName', () => {
  it.each([
    ['xq⚡', 'xq', 'xq', true],
    ['FastAPIServer', 'fast-api-server', 'fast api server', false],
    ['my_cool.repo-name', 'my-cool-repo-name', 'my cool repo name', false],
    ['Café Déjà', 'café-déjà', 'cafe deja', false],
    ['ＦＵＬＬＷＩＤＴＨ', 'fullwidth', 'fullwidth', false],
    ['日本語リポジトリ', '日本語リポジトリ', '日本語リポジトリ', false],
    ['  --weird__  ', 'weird', 'weird', false],
  ])('%s', (input, normalized, search, lossy) => {
    const n = normalizeName(input);
    expect(n.display).toBe(input);
    expect(n.normalized).toBe(normalized);
    expect(n.searchForm).toBe(search);
    expect(n.lossy).toBe(lossy);
  });
  it('a name made only of emoji normalises to a safe placeholder and is flagged', () => {
    const n = normalizeName('🚀🔥');
    expect(n).toMatchObject({
      normalized: 'unnamed',
      searchForm: '',
      empty: true,
      lossy: true,
      tokens: [],
    });
  });
  it('is idempotent on its own output', () => {
    const once = normalizeName('Some⚡Name_X').normalized;
    expect(normalizeName(once).normalized).toBe(once);
  });
});

describe('HeuristicClassifier', () => {
  it('classifies from topics + manifest + description and explains why', () => {
    const manifest = parseManifest(
      'package.json',
      JSON.stringify({
        name: 'xq',
        description: 'Distributed task queue for background jobs',
        dependencies: { bullmq: '5' },
        keywords: ['task-queue'],
      }),
    )!;
    const id = classifier.classify(
      snap({
        displayName: 'xq⚡',
        description: 'background job system',
        language: 'Python',
        topics: ['task-queue', 'workers'],
        manifests: [manifest],
      }),
    );
    expect(id.canonical_type).toBe('task-queue');
    expect(id.primary_function).toBe('background job execution');
    expect(id.confidence).toBeGreaterThan(0.8);
    expect(id.confidence).toBeLessThanOrEqual(0.95);
    expect(id.repository_name).toBe('xq⚡');
    expect(id.normalized_name).toBe('xq');
    expect(id.search_aliases).toContain('python task queue');
    expect(id.ecosystem).toEqual(['Python', 'npm']);
    expect(id.evidence.join(' ')).toMatch(/topic "task-queue"/);
    expect(id.evidence.join(' ')).toMatch(/depends on "bullmq"/);
    expect(id.declared_summary).toBe('Distributed task queue for background jobs');
  });

  it('does not rely on the repository name at all', () => {
    const base = {
      description: 'Vector database for similarity search over embeddings',
      topics: ['vector-database'],
    };
    const a = classifier.classify(snap({ ...base, displayName: 'vector-search' }));
    const b = classifier.classify(snap({ ...base, displayName: 'zorblax' }));
    expect(a.canonical_type).toBe('vector-database');
    expect(b.canonical_type).toBe('vector-database');
    expect(b.confidence).toBe(a.confidence);
    expect(b.name_purpose_divergence).toBe(1);
    expect(a.name_purpose_divergence).toBeLessThan(1);
  });

  it('returns unclassified with low confidence when nothing matches', () => {
    const id = classifier.classify(snap({ displayName: 'qwerty', description: 'misc stuff' }));
    expect(id.canonical_type).toBe('unclassified');
    expect(id.confidence).toBeLessThanOrEqual(0.2);
    expect(id.name_purpose_divergence).toBeNull();
    expect(id.search_aliases).toEqual([]);
  });

  it('empty snapshot (no description, no readme) is handled', () => {
    const id = classifier.classify(snap());
    expect(id.canonical_type).toBe('unclassified');
    expect(id.declared_summary).toBeNull();
    expect(id.primary_function).toBe('unknown');
  });

  it('confidence rises with corroborating sources and falls when types compete', () => {
    const weak = classifier.classify(snap({ readme: 'A message queue.' }));
    const strong = classifier.classify(
      snap({
        description: 'A message broker and event streaming platform',
        topics: ['kafka', 'pubsub'],
        readme: 'message broker, event streaming, pub/sub',
      }),
    );
    expect(strong.confidence).toBeGreaterThan(weak.confidence);
    const mixed = classifier.classify(
      snap({ description: 'A web framework and also a database engine', topics: [] }),
    );
    const clear = classifier.classify(
      snap({ description: 'A web framework for building http servers', topics: [] }),
    );
    expect(clear.confidence).toBeGreaterThan(mixed.confidence);
  });

  it('records secondary functions only when they are close to the winner', () => {
    const id = classifier.classify(
      snap({
        description: 'LLM agent framework with a vector database and vector search',
        topics: ['llm', 'agents', 'vector-database'],
      }),
    );
    expect(id.secondary_functions.length).toBeGreaterThan(0);
  });

  it('detects interfaces from structure and dependencies', () => {
    const cli = classifier.classify(
      snap({
        manifests: [parseManifest('package.json', '{"name":"t","bin":{"t":"x.js"}}')!],
        treePaths: ['cmd/t/main.go'],
      }),
    );
    expect(cli.interfaces).toEqual(expect.arrayContaining(['cli', 'library']));
    const server = classifier.classify(
      snap({
        hasDockerfile: true,
        manifests: [
          parseManifest(
            'package.json',
            '{"name":"s","private":true,"dependencies":{"express":"4"}}',
          )!,
        ],
      }),
    );
    expect(server.interfaces).toEqual(expect.arrayContaining(['server', 'container']));
    expect(server.interfaces).not.toContain('library');
    const action = classifier.classify(snap({ hasActionYml: true }));
    expect(action.interfaces).toContain('github-action');
  });

  it('sanitises declared text and keeps ANSI/control characters out of output', () => {
    const id = classifier.classify(
      snap({ description: 'Nice \u001b[31mred\u001b[0m tool\u0007 for task queue jobs' }),
    );
    expect(id.declared_summary).not.toMatch(/[\u0000-\u001f]/);
    expect(id.declared_summary).toContain('red');
  });

  it('is deterministic', () => {
    const s = snap({ description: 'A web framework', topics: ['framework'] });
    expect(JSON.stringify(classifier.classify(s))).toBe(JSON.stringify(classifier.classify(s)));
  });

  it('is replaceable behind the IdentityClassifier interface', async () => {
    const custom = {
      id: 'stub',
      classify: () => ({
        ...classifier.classify(snap()),
        classifier: 'stub',
        canonical_type: 'custom',
      }),
    };
    expect((await custom.classify()).canonical_type).toBe('custom');
  });
});

describe('taxonomy', () => {
  it('ships a valid taxonomy with unique ids', () => {
    const t = loadDefaultTaxonomy();
    expect(t.types.length).toBeGreaterThanOrEqual(25);
    expect(new Set(t.types.map((x) => x.id)).size).toBe(t.types.length);
    for (const e of t.types) expect(e.aliases.length, e.id).toBeGreaterThan(0);
  });
  it('rejects malformed taxonomies', () => {
    expect(() => parseTaxonomy('version: "1"\ntypes: []')).toThrow();
    expect(() =>
      parseTaxonomy(
        'version: "1"\ntypes:\n  - id: Bad Id\n    label: x\n    function: y\n    keywords: [aa]',
      ),
    ).toThrow();
  });
});
