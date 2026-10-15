import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectArtifact } from '../../src/registry/artifacts/inspect.js';
import { extractStaticFacts } from '../../src/registry/artifacts/static.js';
import { artifactDomains, dependencyDomainEvents } from '../../src/registry/artifacts/domains.js';
import type { DependencyArtifact } from '../../src/registry/artifacts/model.js';

const root = join(process.cwd(), 'tests/fixtures/artifacts');
const artifact = (name: string, version: string): DependencyArtifact => {
  const i = inspectArtifact(readFileSync(join(root, name)));
  const f = extractStaticFacts(i, { name: 'fixture', version, hasInstallScript: true });
  return {
    registry: 'npm',
    package: 'fixture',
    version,
    url: null,
    state: i.state,
    entries: i.entries.length,
    total_size: i.totalSize,
    hooks: f.hooks,
    domains: f.domains,
    mismatches: f.mismatches,
    reason: null,
    evidence: [`artifact:fixture:${version}`],
  };
};

describe('dependency artifact external domains', () => {
  it('uses real esbuild and core-js tarballs as bounded inputs', () => {
    const esbuild = artifact('npm-esbuild-0.28.2.tgz', '0.28.2');
    expect(esbuild.hooks).toEqual([{ name: 'postinstall', text: 'node install.js' }]);
    expect(esbuild.domains).toContain('nodejs.org');
    const core = artifact('npm-core-js-3.37.0.tgz', '3.37.0');
    expect(core.hooks).toEqual([
      { name: 'postinstall', text: 'node -e "try{require(\'./postinstall\')}catch(e){}"' },
    ]);
    expect(core.domains).toContain('opencollective.com');
  });
  it('labels dependency install domains and reports an introduced domain between same-package versions', () => {
    const before = artifact('npm-colors-1.4.0.tgz', '1.4.0');
    const after: DependencyArtifact = {
      ...before,
      version: '1.4.1',
      hooks: [{ name: 'postinstall', text: 'node -e "fetch(\'https://new.vendor.io/install\')"' }],
      domains: ['new.vendor.io'],
      evidence: ['artifact:fixture:1.4.1'],
    };
    const d = artifactDomains(after);
    expect(d.status).toBe('analyzed');
    expect(d.domains.map((x) => x.hostname)).toEqual(['new.vendor.io']);
    expect(d.domains[0]?.strongest_context).toBe('dependency_install');
    const events = dependencyDomainEvents(before, after, '2026-01-02T00:00:00.000Z');
    expect(events).toEqual([
      {
        type: 'dependency_external_domain_introduced',
        at: '2026-01-02T00:00:00.000Z',
        entity: 'npm:fixture',
        package: 'fixture',
        version: '1.4.1',
        hostname: 'new.vendor.io',
        detail: 'new.vendor.io introduced by fixture@1.4.1',
        evidence: ['artifact:fixture:1.4.1'],
        confidence: 0.85,
      },
    ]);
  });
  it('does not emit events when the package identity changes or when only one version exists', () => {
    const a = artifact('npm-colors-1.4.0.tgz', '1.4.0');
    expect(dependencyDomainEvents(a, { ...a, package: 'other' }, null)).toEqual([]);
    expect(dependencyDomainEvents(a, a, null)).toEqual([]);
  });
});
