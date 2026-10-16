/* global process, console */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { inspectArtifact } from '../dist/registry/artifacts/inspect.js';
import { extractStaticFacts } from '../dist/registry/artifacts/static.js';

const root = join(process.cwd(), 'tests', 'fixtures', 'artifacts');
const files = readdirSync(root)
  .filter((f) => /\.(tgz|crate|whl)$/.test(f))
  .sort();
const rows = [];
for (const file of files) {
  const bytes = readFileSync(join(root, file));
  const start = performance.now();
  const inspection = inspectArtifact(bytes);
  const facts =
    inspection.state === 'invalid'
      ? null
      : extractStaticFacts(inspection, { name: file, version: 'probe' });
  rows.push({
    file,
    compressed_bytes: bytes.length,
    state: inspection.state,
    entries: inspection.entries.length,
    metadata_bytes: inspection.totalSize,
    hooks: facts?.hooks?.map((x) => x.name) ?? [],
    milliseconds: Number((performance.now() - start).toFixed(3)),
  });
}
console.log(
  JSON.stringify({ node: process.version, fixture_count: rows.length, fixtures: rows }, null, 2),
);
