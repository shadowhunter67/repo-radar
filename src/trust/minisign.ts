import { createHash, createPublicKey, verify as edVerify, type KeyObject } from 'node:crypto';
import type { TrustedKey } from './config.js';
import type { TrustRoot, Verification } from './model.js';

/**
 * minisign verification. minisign is a thin container around Ed25519: this module
 * parses the documented file formats and hands the signature check to the platform's Ed25519 implementation
 * (`node:crypto`). It implements no cryptographic primitive.
 *
 * Trust rule: a `.minisig` file is NOT trust. It names the id of the key that signed it, and it is accepted only if a key
 * the USER configured (see ./config.ts) has that id and the signature verifies against that key.
 *
 *   public key (base64, 42 bytes):  "Ed" | key id (8) | Ed25519 public key (32)
 *   signature file:
 *     untrusted comment: <text>
 *     base64(sig algorithm "Ed" or "ED" (2) | key id (8) | Ed25519 signature (64))
 *     trusted comment: <text>
 *     base64(global signature (64))   over  signature(64) || trusted comment bytes
 *   "Ed" signs the data directly; "ED" signs BLAKE2b-512(data) (the pre-hashed mode).
 */
export const MINISIGN_LIMITS = {
  maxSignatureFileBytes: 4096,
  maxDataBytes: 8 * 1024 * 1024,
} as const;

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const safe = (s: string, n = 160): string => s.replace(/[^\x20-\x7e]/g, '?').slice(0, n);
const rootOf = (k: TrustedKey): TrustRoot =>
  k.origin === 'project_pinned' ? 'project_pinned_minisign_key' : 'user_supplied_minisign_key';

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export interface MinisignPublicKey {
  keyId: string;
  key: KeyObject;
}

/** Accepts the bare base64 line ("RW...") or the two-line file with an "untrusted comment:" first line. */
export function parseMinisignPublicKey(text: string): MinisignPublicKey | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('untrusted comment:'));
  const b64 = lines[0];
  if (!b64 || b64.length > 200 || !BASE64.test(b64)) return undefined;
  const raw = Buffer.from(b64, 'base64');
  if (raw.length !== 42 || raw.subarray(0, 2).toString('latin1') !== 'Ed') return undefined;
  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, raw.subarray(10)]),
      format: 'der',
      type: 'spki',
    });
    return { keyId: raw.subarray(2, 10).toString('hex'), key };
  } catch {
    return undefined;
  }
}

export interface ParsedMinisignSignature {
  algorithm: 'Ed' | 'ED';
  keyId: string;
  signature: Buffer;
  trustedComment: Buffer;
  globalSignature: Buffer;
}

export function parseMinisignSignature(text: string): ParsedMinisignSignature | undefined {
  if (text.length > MINISIGN_LIMITS.maxSignatureFileBytes) return undefined;
  const lines = text.split(/\r?\n/);
  if (lines.length < 4 || !lines[0]?.startsWith('untrusted comment:')) return undefined;
  const sigLine = (lines[1] ?? '').trim();
  const tc = lines[2] ?? '';
  const globalLine = (lines[3] ?? '').trim();
  if (!tc.startsWith('trusted comment:') || !BASE64.test(sigLine) || !BASE64.test(globalLine))
    return undefined;
  const raw = Buffer.from(sigLine, 'base64');
  const global = Buffer.from(globalLine, 'base64');
  const alg = raw.subarray(0, 2).toString('latin1');
  if (raw.length !== 74 || (alg !== 'Ed' && alg !== 'ED') || global.length !== 64) return undefined;
  return {
    algorithm: alg,
    keyId: raw.subarray(2, 10).toString('hex'),
    signature: raw.subarray(10),
    // the comment text after "trusted comment: " (a single space is part of the prefix), without the line ending
    trustedComment: Buffer.from(tc.slice('trusted comment: '.length)),
    globalSignature: global,
  };
}

const result = (
  state: Verification['state'],
  detail: string,
  subject: string,
  trust_root: TrustRoot = 'none',
): Verification => ({
  state,
  trust_root,
  verified_by: state === 'verified' || state === 'invalid' ? 'local' : 'none',
  engine: 'minisign',
  subject: safe(subject, 300),
  detail: detail.slice(0, 240),
  identity: null,
});

export function verifyMinisign(opts: {
  signatureText: string;
  data: Buffer;
  keys: TrustedKey[];
  subject: string;
}): Verification {
  const { subject } = opts;
  const keys = opts.keys.filter((k) => k.kind === 'minisign');
  if (keys.length === 0)
    return result(
      'verification_unavailable',
      'no trusted minisign key was supplied (--trust-minisign-key or a trust file); a .minisig file alone is not trust',
      subject,
    );
  if (opts.signatureText.length > MINISIGN_LIMITS.maxSignatureFileBytes)
    return result(
      'verification_skipped_resource_limit',
      `the signature file is larger than ${MINISIGN_LIMITS.maxSignatureFileBytes} bytes; not parsed`,
      subject,
    );
  if (opts.data.length > MINISIGN_LIMITS.maxDataBytes)
    return result(
      'verification_skipped_resource_limit',
      `the signed data is larger than ${MINISIGN_LIMITS.maxDataBytes} bytes; not verified`,
      subject,
    );
  const sig = parseMinisignSignature(opts.signatureText);
  if (!sig)
    return result('verification_failed', 'the minisign signature file is malformed', subject);
  const parsed = keys.flatMap((cfg) => {
    const k = parseMinisignPublicKey(cfg.material);
    return k ? [{ cfg, k }] : [];
  });
  if (parsed.length === 0)
    return result(
      'verification_failed',
      'none of the configured minisign keys could be read',
      subject,
    );
  const hit = parsed.find((p) => p.k.keyId === sig.keyId);
  if (!hit)
    return result(
      'verification_unavailable',
      `signed by key ${sig.keyId}, which is not among the ${parsed.length} trusted minisign key(s)`,
      subject,
    );
  const root = rootOf(hit.cfg);
  try {
    const message =
      sig.algorithm === 'ED' ? createHash('blake2b512').update(opts.data).digest() : opts.data;
    if (!edVerify(null, message, hit.k.key, sig.signature))
      return result('invalid', 'the signature does not match the data', subject, root);
    // the trusted comment is covered by the global signature, so it cannot be swapped without the key
    if (
      !edVerify(
        null,
        Buffer.concat([sig.signature, sig.trustedComment]),
        hit.k.key,
        sig.globalSignature,
      )
    )
      return result(
        'invalid',
        'the trusted comment is not covered by a valid global signature',
        subject,
        root,
      );
    return result(
      'verified',
      `valid signature by trusted minisign key ${hit.k.keyId}`,
      subject,
      root,
    );
  } catch (e) {
    return result('verification_failed', safe(e instanceof Error ? e.message : 'failed'), subject);
  }
}
