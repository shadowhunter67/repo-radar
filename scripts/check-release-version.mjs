import { readFileSync } from 'node:fs';
import process from 'node:process';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const ref = process.env.GITHUB_REF_NAME ?? '';
if (ref && ref.startsWith('v') && ref.slice(1) !== pkg.version)
  throw new Error(`tag ${ref} does not match package ${pkg.version}`);
const archive = process.argv[2];
if (archive && !archive.endsWith(`${pkg.name}-${pkg.version}.tgz`))
  throw new Error(`archive ${archive} does not match package ${pkg.name}-${pkg.version}`);
