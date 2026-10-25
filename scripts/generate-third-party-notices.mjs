import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packages = ['openpgp', 'sigstore', 'smol-toml', 'yaml', 'zod'];
const sections = packages.map((name) => {
  const license = join(root, 'node_modules', name, 'LICENSE');
  if (!existsSync(license)) throw new Error(`missing license text for ${name}`);
  return `## ${name}\n\n${readFileSync(license, 'utf8').trim()}\n`;
});
writeFileSync(
  join(root, 'THIRD_PARTY_NOTICES.md'),
  `# Third-party notices\n\n${sections.join('\n')}`,
);
