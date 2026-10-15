import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import type { ExpectedIdentity } from './sigstore.js';
import { loadTrustedRoots, type TrustedRootDocument } from './github-root.js';

/**
 * Trust configuration: the ONLY place a public key becomes trusted.
 *
 * Keys and identities come from the person running repo-radar (command line flags or a trust file they maintain), never from
 * the analyzed repository. A public key committed in a repository is evidence (`key_present_in_repository`) and nothing
 * more: nothing in this tool turns repository content into a trusted key. There is no host keyring lookup either, so the
 * result of a verification does not depend on whatever keys happen to exist on the machine.
 *
 * `origin` records where the user got the key:
 *  - `user_supplied`: given for this run (flag or API).
 *  - `project_pinned`: written into a trust file the user keeps for a project, outside the analyzed repository.
 */
export interface TrustedKey {
  kind: 'gpg' | 'minisign';
  origin: 'user_supplied' | 'project_pinned';
  /** ASCII-armored OpenPGP public key, or the minisign public key text. PUBLIC key material only. */
  material: string;
  /** Optional pin: the OpenPGP fingerprint (hex, no spaces) the key must have. */
  fingerprint?: string;
  label?: string;
}

export interface TrustConfig {
  keys: TrustedKey[];
  trustedRoots?: TrustedRootDocument[];
  expectedIdentity?: ExpectedIdentity;
}
export const EMPTY_TRUST: TrustConfig = { keys: [] };

export const TRUST_LIMITS = {
  maxKeys: 16,
  maxKeyBytes: 1024 * 1024,
  maxConfigBytes: 4 * 1024 * 1024,
} as const;

const PRIVATE_KEY = /-----BEGIN PGP PRIVATE KEY BLOCK-----|untrusted comment: .*secret key/i;

export class TrustConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrustConfigError';
  }
}

/**
 * A private key must never be accepted, stored or echoed: verification needs public keys only. Refusing it here keeps a
 * private key out of reports, snapshots and the graph.
 */
export function assertPublicKeyMaterial(material: string): void {
  if (PRIVATE_KEY.test(material))
    throw new TrustConfigError(
      'private key material was supplied; repo-radar verifies with public keys only and refuses it',
    );
  if (Buffer.byteLength(material) > TRUST_LIMITS.maxKeyBytes)
    throw new TrustConfigError('key material is larger than the limit');
}

export function readKeyFile(path: string): string {
  const abs = resolve(path);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new TrustConfigError(`key file not found`);
  if (statSync(abs).size > TRUST_LIMITS.maxKeyBytes)
    throw new TrustConfigError('key file is larger than the limit');
  const text = readFileSync(abs, 'utf8');
  assertPublicKeyMaterial(text);
  return text;
}

export function gpgKey(
  material: string,
  origin: TrustedKey['origin'] = 'user_supplied',
  fingerprint?: string,
): TrustedKey {
  assertPublicKeyMaterial(material);
  return { kind: 'gpg', origin, material, ...(fingerprint ? { fingerprint } : {}) };
}
export function minisignKey(
  material: string,
  origin: TrustedKey['origin'] = 'user_supplied',
): TrustedKey {
  assertPublicKeyMaterial(material);
  return { kind: 'minisign', origin, material };
}

const KeyEntry = z
  .object({
    kind: z.enum(['gpg', 'minisign']),
    /** Path (relative to the trust file) of a public key file, or ... */
    file: z.string().max(500).optional(),
    /** ... the public key text itself. */
    material: z.string().max(TRUST_LIMITS.maxKeyBytes).optional(),
    fingerprint: z
      .string()
      .regex(/^[0-9A-Fa-f ]{16,100}$/)
      .optional(),
    label: z.string().max(100).optional(),
  })
  .strict();
const IdentityEntry = z
  .object({
    source_repository: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/)
      .optional(),
    san: z.string().max(400).optional(),
    issuer: z.string().max(200).optional(),
  })
  .strict();
const TrustFile = z
  .object({
    keys: z.array(KeyEntry).max(TRUST_LIMITS.maxKeys).default([]),
    expected_identity: IdentityEntry.optional(),
    trusted_roots: z.array(z.string().max(500)).max(8).optional(),
  })
  .strict();

/** Load a trust file the user maintains. Keys it lists are `project_pinned`. */
export function loadTrustFile(path: string): TrustConfig {
  const abs = resolve(path);
  if (!existsSync(abs) || !statSync(abs).isFile())
    throw new TrustConfigError('trust file not found');
  if (statSync(abs).size > TRUST_LIMITS.maxConfigBytes)
    throw new TrustConfigError('trust file is larger than the limit');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(abs, 'utf8'));
  } catch {
    throw new TrustConfigError('trust file is not valid JSON');
  }
  const parsed = TrustFile.safeParse(raw);
  if (!parsed.success) throw new TrustConfigError('trust file does not match the expected shape');
  const keys: TrustedKey[] = parsed.data.keys.map((k) => {
    if (!!k.file === !!k.material)
      throw new TrustConfigError('each key needs exactly one of "file" or "material"');
    let material = k.material ?? '';
    if (k.file) {
      const p = isAbsolute(k.file) ? k.file : resolve(dirname(abs), k.file);
      material = readKeyFile(p);
    }
    assertPublicKeyMaterial(material);
    return {
      kind: k.kind,
      origin: 'project_pinned' as const,
      material,
      ...(k.fingerprint ? { fingerprint: k.fingerprint.replace(/\s/g, '').toUpperCase() } : {}),
      ...(k.label ? { label: k.label } : {}),
    };
  });
  const id = parsed.data.expected_identity;
  const roots = parsed.data.trusted_roots?.flatMap((p) => {
    try {
      // Imported lazily to keep key-only users from loading protobuf code.
      return loadTrustedRoots(resolve(dirname(abs), p), 'project_pinned');
    } catch {
      return [];
    }
  });
  return {
    keys,
    ...(roots && roots.length > 0 ? { trustedRoots: roots } : {}),
    ...(id
      ? {
          expectedIdentity: {
            ...(id.source_repository ? { sourceRepository: id.source_repository } : {}),
            ...(id.san ? { san: id.san } : {}),
            ...(id.issuer ? { issuer: id.issuer } : {}),
          },
        }
      : {}),
  };
}

export function mergeTrust(a: TrustConfig, b: TrustConfig): TrustConfig {
  const keys = [...a.keys, ...b.keys].slice(0, TRUST_LIMITS.maxKeys);
  const expectedIdentity = { ...(a.expectedIdentity ?? {}), ...(b.expectedIdentity ?? {}) };
  return {
    keys,
    ...(a.trustedRoots || b.trustedRoots
      ? { trustedRoots: [...(a.trustedRoots ?? []), ...(b.trustedRoots ?? [])].slice(0, 8) }
      : {}),
    ...(Object.keys(expectedIdentity).length > 0 ? { expectedIdentity } : {}),
  };
}
