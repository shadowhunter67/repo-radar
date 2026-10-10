// Regenerates schemas/*.json from the zod definitions. Run `npm run schemas` (builds first).
import { mkdirSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildJsonSchemas } from '../dist/schemas.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');
mkdirSync(dir, { recursive: true });
for (const [name, schema] of Object.entries(buildJsonSchemas())) {
  writeFileSync(join(dir, name), JSON.stringify(schema, null, 2) + '\n');
  process.stdout.write(`wrote schemas/${name}\n`);
}
