/* global console, process */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { inspectArtifact } from '../dist/registry/artifacts/inspect.js';
import { extractStaticFacts } from '../dist/registry/artifacts/static.js';
import { compareDependencyArtifacts } from '../dist/registry/artifacts/delta.js';

const root = join(process.cwd(), 'tests', 'fixtures', 'artifacts');
const make = (file, version) => {
  const inspection = inspectArtifact(readFileSync(join(root, file)));
  const facts = extractStaticFacts(inspection, { name: 'npm-demo', version });
  return {
    registry: 'npm',
    package: 'npm-demo',
    version,
    url: null,
    state: inspection.state,
    entries: inspection.entries.length,
    total_size: inspection.totalSize,
    hooks: facts.hooks,
    domains: facts.domains,
    mismatches: facts.mismatches,
    reason: null,
    evidence: [],
  };
};
const before = make('npm-colors-1.4.0.tgz', '1.4.0');
const after = make('npm-esbuild-0.28.2.tgz', '0.28.2');
const start = performance.now();
const delta = compareDependencyArtifacts(before, after);
console.log(
  JSON.stringify(
    {
      before_state: before.state,
      after_state: after.state,
      behavior_events: delta.behavior.length,
      trust_boundary_events: delta.trust_boundary.length,
      not_available: delta.not_available,
      milliseconds: Number((performance.now() - start).toFixed(3)),
    },
    null,
    2,
  ),
);
