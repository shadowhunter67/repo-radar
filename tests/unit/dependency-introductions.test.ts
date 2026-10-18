import { describe, expect, it } from 'vitest';
import { parseLock } from '../../src/deps/lock.js';
import {
  buildDependencyIntroductions,
  deriveIntroductionFacts,
} from '../../src/deps/introductions.js';
import type { Dependency } from '../../src/deps/model.js';
import {
  GraphIndex,
  dependenciesIntroducedInRevision,
  transitiveChainsWithoutProvenance,
  youngDependencies,
} from '../../src/graph/query.js';
import type { TrustGraph } from '../../src/graph/trust.js';
import {
  EMPTY_DEP_REGISTRY_INTEL,
  type DependencyRegistryIntel,
} from '../../src/registry/dependency-model.js';

const dep = (name: string, direct: boolean, version: string): Dependency => ({
  id: `dep:npm:${name}`,
  package: { ecosystem: 'npm', name },
  relationship: 'runtime',
  direct,
  requested: { spec: `^${version}`, kind: 'range' },
  resolution: 'resolved',
  resolved: { version, source: 'lockfile', file: 'package-lock.json', confidence: 1 },
  other_versions: [],
  context: 'primary',
  lockfile_path: 'package-lock.json',
  vulnerability: { state: 'not_checked', advisory_ids: [] },
  derived_from: ['package-lock.json'],
  confidence: 1,
});

describe('dependency introduction intelligence', () => {
  it('bounds parent chains and withholds unknown introduction facts', () => {
    const lock = parseLock(
      'package-lock.json',
      JSON.stringify({
        packages: {
          'node_modules/root': { version: '1.0.0' },
          'node_modules/root/node_modules/child': { version: '2.0.0' },
        },
      }),
    );
    expect(lock).toBeDefined();
    const result = buildDependencyIntroductions(
      [dep('root', true, '1.0.0'), dep('child', false, '2.0.0')],
      lock ? [lock] : [],
      EMPTY_DEP_REGISTRY_INTEL,
      '2026-01-01T00:00:00Z',
    );
    expect(result.coverage).toEqual({
      considered: 2,
      with_known_introduction: 0,
      unknown: 2,
      capped: 0,
    });
    expect(result.entries[1]).toMatchObject({
      package: 'child',
      parent_chain: ['root'],
      introduction: 'unknown',
      introduced_in_revision: null,
    });
    expect(deriveIntroductionFacts(result)).toEqual([]);
  });

  it('rejects future registry timestamps for age facts', () => {
    const registry = {
      ...EMPTY_DEP_REGISTRY_INTEL,
      status: 'analyzed' as const,
      packages: [
        {
          registry: 'npm' as const,
          name: 'fresh',
          status: 'ok' as const,
          observed_at: '2026-01-01T00:00:00Z',
          latest_version: '1.0.0',
          versions: [
            {
              version: '1.0.0',
              published_at: '2027-01-01T00:00:00Z',
              publisher: null,
              maintainers: [],
              repository: null,
              has_install_script: false,
              has_provenance: false,
            },
          ],
          resolved_times: {},
          maintainers: { names: [], changed: false },
          repository: { raw: null, normalized: null, match: 'unknown' as const },
          signals: [],
          attestation_states: {},
          dependency_ids: ['dep:npm:fresh'],
          resolved_versions: ['1.0.0'],
          priority: { score: 0, reasons: [] },
          corroboration: { source: 'none' as const, repositories: [] },
        },
      ],
    };
    const result = buildDependencyIntroductions(
      [dep('fresh', true, '1.0.0')],
      [],
      registry as unknown as DependencyRegistryIntel,
      '2026-01-01T00:00:00Z',
    );
    expect(result.entries[0]).toMatchObject({
      package_first_published_at: null,
      release_age_days_min: null,
      young_package_present: null,
    });
  });

  it('answers graph queries from explicit evidence edges', () => {
    const graph: TrustGraph = {
      version: '1',
      nodes: [
        {
          id: 'dep:npm:a',
          kind: 'Dependency',
          name: 'a',
          attrs: { young_package_present: true, parent_provenance: 'none' },
        },
        {
          id: 'dep:npm:b',
          kind: 'Dependency',
          name: 'b',
          attrs: { young_package_present: false, parent_provenance: 'reported' },
        },
        { id: 'commit:abc', kind: 'Commit', name: 'abc', attrs: {} },
      ],
      edges: [
        {
          from: 'dep:npm:a',
          to: 'commit:abc',
          type: 'INTRODUCED_BY',
          evidence_ids: ['e:a'],
          confidence: 1,
          temporal_scope: 'revision',
          source: 'dependency_intel',
          at: null,
        },
        {
          from: 'dep:npm:b',
          to: 'dep:npm:a',
          type: 'TRANSITIVE_VIA',
          evidence_ids: ['e:b'],
          confidence: 1,
          temporal_scope: 'revision',
          source: 'dependency_intel',
          at: null,
        },
      ],
      truncated: false,
      dropped_without_evidence: 0,
      limits: {
        nodes_emitted: 3,
        nodes_skipped: 0,
        edges_emitted: 2,
        edges_skipped: 0,
        stopped_by: 'complete',
      },
      not_represented: [],
    };
    const index = new GraphIndex(graph);
    expect(dependenciesIntroducedInRevision(index, 'abc')).toEqual([
      { dependency: 'a', revision: 'abc', evidence: ['e:a'] },
    ]);
    expect(youngDependencies(index)).toEqual(['a']);
    expect(transitiveChainsWithoutProvenance(index)).toEqual(['b']);
  });
});
