import { describe, expect, it } from 'vitest';
import { inspectArtifact } from '../../src/registry/artifacts/inspect.js';
import { artifactDomains } from '../../src/registry/artifacts/domains.js';
import { comparePackageNames } from '../../src/registry/names.js';
import { correlate } from '../../src/events/correlate.js';
import { analyzeRepository } from '../../src/analyze.js';
import { fixedClock, fakeFetch } from '../helpers/fake-github.js';
import { goodRepo } from '../helpers/scenarios.js';

describe('v0.9 cross-subsystem invariants', () => {
  it('skipped artifact inspection cannot create install-hook or domain absence claims', () => {
    const artifact = {
      registry: 'npm' as const,
      package: 'x',
      version: '1.0.0',
      url: null,
      state: 'skipped' as const,
      entries: 0,
      total_size: 0,
      hooks: [],
      domains: [],
      mismatches: [],
      reason: 'budget_bytes',
      evidence: [],
    };
    expect(artifact.hooks).toEqual([]);
    expect(artifactDomains(artifact).domains).toEqual([]);
    expect(artifact.state).not.toBe('verified');
  });

  it('digest mismatch is invalid and has no entries or trusted facts', () => {
    const result = inspectArtifact(new Uint8Array([1, 2, 3]), {
      expectedDigest: 'sha256-' + '0'.repeat(64),
    });
    expect(result.state).toBe('invalid');
    expect(result.entries).toEqual([]);
    expect(result.diagnostics).toEqual(['digest_mismatch']);
  });

  it('known-time correlation requires the same entity and excludes unknown timestamps', () => {
    const events = [
      {
        id: 'a',
        type: 'dependency_publisher_changed' as const,
        at: '2026-01-01T00:00:00.000Z',
        subject: 'a',
        source: 'dependency_registry' as const,
        detail: 'a',
        confidence: 1,
        evidence: ['e-a'],
        entity: 'npm:a',
      },
      {
        id: 'b',
        type: 'dependency_install_hook_introduced' as const,
        at: '2026-01-02T00:00:00.000Z',
        subject: 'b',
        source: 'dependency_registry' as const,
        detail: 'b',
        confidence: 1,
        evidence: ['e-b'],
        entity: 'npm:b',
      },
      {
        id: 'c',
        type: 'dependency_install_hook_introduced' as const,
        at: null,
        subject: 'a',
        source: 'dependency_registry' as const,
        detail: 'c',
        confidence: 1,
        evidence: ['e-c'],
        entity: 'npm:a',
      },
    ];
    expect(
      correlate(events, [
        {
          id: 'p',
          description: 'same entity',
          within_days: 10,
          same_entity: true,
          steps: [
            { any_of: ['dependency_publisher_changed'] },
            { any_of: ['dependency_install_hook_introduced'] },
          ],
        },
      ]),
    ).toEqual([]);
  });

  it('name confusion wording remains a possible signal and ecosystem normalization is bounded', () => {
    const c = comparePackageNames('Requests_Plus', 'requests-plus', 'pypi');
    expect(c.normalized_left).toBe(c.normalized_right);
    expect(c.signals).toEqual(['separator_variation']);
    expect(comparePackageNames('rеquests', 'requests', 'pypi').signals).toContain('homoglyph');
  });

  it('fixed inputs and clock produce byte-identical reports', async () => {
    const spec = goodRepo();
    const options = {
      fetch: fakeFetch(spec),
      clock: fixedClock,
      scorecard: false,
      osv: false,
      depsDev: false,
    };
    const a = await analyzeRepository('acme/widget', options);
    const b = await analyzeRepository('acme/widget', { ...options, fetch: fakeFetch(spec) });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
