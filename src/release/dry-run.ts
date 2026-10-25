import { createHash } from 'node:crypto';

export const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
export const buildMetadata = (input: {
  version: string;
  node: string;
  npm: string;
  commit: string;
  commands: string[];
}) => ({ name: 'repo-radar', ...input });
export const inspectPackageEntries = (entries: string[]) => {
  const forbidden =
    /^(?:package\/)?(?:calibration|tests|scripts|node_modules|snapshots|tmp)(?:\/|$)|(?:^|\/)(?:\.env[^/]*|.*\.log)$/i;
  const bad = entries.filter((entry) => forbidden.test(entry));
  if (bad.length) throw new Error(`forbidden package entries: ${bad.slice(0, 5).join(', ')}`);
  for (const required of [
    'package/dist/',
    'package/README.md',
    'package/LICENSE',
    'package/SECURITY.md',
  ])
    if (!entries.some((entry) => entry === required || entry.startsWith(required)))
      throw new Error(`missing package entry: ${required}`);
  return { entries: entries.length, forbidden: bad };
};
