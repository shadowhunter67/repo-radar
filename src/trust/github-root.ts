import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { TrustedRoot } from '@sigstore/protobuf-specs';
import type { TrustRoot } from './model.js';

export interface TrustedRootDocument {
  label: Extract<TrustRoot, 'sigstore_public_good' | 'github_attestation_instance'>;
  root: ReturnType<typeof TrustedRoot.fromJSON>;
  source: 'user_supplied' | 'project_pinned';
}

const MAX_ROOT_BYTES = 8 * 1024 * 1024;
const labelFor = (value: unknown): TrustedRootDocument['label'] | null => {
  const text = JSON.stringify(value);
  if (/fulcio\.githubapp\.com|timestamp\.githubapp\.com/i.test(text))
    return 'github_attestation_instance';
  if (/fulcio\.sigstore\.dev|rekor\.sigstore\.dev/i.test(text)) return 'sigstore_public_good';
  return null;
};

export function parseTrustedRootLines(
  text: string,
  source: TrustedRootDocument['source'] = 'user_supplied',
): TrustedRootDocument[] {
  if (Buffer.byteLength(text) > MAX_ROOT_BYTES)
    throw new Error('trusted root file exceeds the size limit');
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const raw = JSON.parse(line) as unknown;
        const label = labelFor(raw);
        if (!label) return [];
        return [{ label, root: TrustedRoot.fromJSON(raw), source }];
      } catch {
        return [];
      }
    });
}

export function loadTrustedRoots(
  path: string,
  source: TrustedRootDocument['source'] = 'user_supplied',
): TrustedRootDocument[] {
  const abs = resolve(path);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error('trusted root file not found');
  return parseTrustedRootLines(readFileSync(abs, 'utf8'), source);
}
