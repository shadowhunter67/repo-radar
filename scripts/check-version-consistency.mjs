/* global URL, console, process */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('..', import.meta.url)));
const read = (file) => readFileSync(join(root, file), 'utf8');
const pkg = JSON.parse(read('package.json'));
const schema = read('src/report/schema.ts').match(/REPORT_SCHEMA_VERSION\s*=\s*'([^']+)'/)?.[1];
const ci = read('.github/workflows/ci.yml').match(/r\.schema_version\s*===\s*'([^']+)'/)?.[1];
const supported = read('SECURITY.md').match(/currently\s+(\d+\.\d+)\.x/)?.[1];
const packageMinor = pkg.version?.match(/^\d+\.\d+/)?.[0];
const problems = [];
if (!schema) problems.push('REPORT_SCHEMA_VERSION not found');
if (!ci) problems.push('CI schema assertion not found');
if (!supported) problems.push('SECURITY.md supported version not found');
if (schema && ci && schema !== ci) problems.push(`schema ${schema} differs from CI ${ci}`);
if (schema && packageMinor !== schema)
  problems.push(`package ${packageMinor} differs from schema ${schema}`);
if (supported && packageMinor !== supported)
  problems.push(`package ${packageMinor} differs from SECURITY.md ${supported}`);
if (problems.length) {
  console.error(`version consistency failed:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(
  `version consistency: package ${pkg.version}, schema ${schema}, supported ${supported}.x`,
);
