import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
const from = resolve('web/public');
const to = resolve('dist/web/public');
await mkdir(dirname(to), { recursive: true });
await cp(from, to, { recursive: true });
