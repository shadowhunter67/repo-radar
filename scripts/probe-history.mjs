import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import process from 'node:process';

const lock = JSON.parse(readFileSync('package.json', 'utf8'));
const dependencyCount = Object.keys(lock.dependencies ?? {}).length;
process.stdout.write(
  JSON.stringify(
    {
      probe: 'dependency-history',
      fixture: 'package.json',
      candidates: dependencyCount,
      requests: 0,
      commits: 0,
      bytes: Buffer.byteLength(JSON.stringify(lock)),
      note: 'offline probe; network history collection requires the caller-provided fake GitHub responses',
    },
    null,
    2,
  ) + '\n',
);
