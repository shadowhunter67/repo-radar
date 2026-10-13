import type { TrustedKey } from './config.js';
import type { TrustRoot, Verification } from './model.js';

/**
 * OpenPGP detached-signature verification through the maintained `openpgp` library, against ONLY the keys the user
 * configured (see ./config.ts). No host keyring is read and no key is fetched. Weak hash algorithms (MD5, RIPEMD, SHA-1) are
 * rejected.
 *
 * Outcomes:
 *  - `verified`: a configured key made a valid signature over exactly these bytes.
 *  - `invalid`: a configured key is the signer and the signature does not match, is expired, or the key is revoked/expired.
 *  - `verification_unavailable`: no key is configured, or the signature was made by a key that is not configured. That is
 *    "cannot decide with this trust material", not a statement that the signature is forged.
 *  - `verification_failed`: the signature or key could not be parsed, or the library failed. No decision.
 *  - `verification_skipped_resource_limit`: signature or data over the limits; nothing was parsed.
 */
export const GPG_LIMITS = {
  maxSignatureBytes: 64 * 1024,
  maxDataBytes: 8 * 1024 * 1024,
  maxKeys: 16,
} as const;

type OpenPgp = typeof import('openpgp');
let lib: Promise<OpenPgp | undefined> | undefined;
export function loadOpenPgp(): Promise<OpenPgp | undefined> {
  lib ??= import('openpgp').then(
    (m) => m,
    () => undefined,
  );
  return lib;
}

const rootOf = (k: TrustedKey): TrustRoot =>
  k.origin === 'project_pinned' ? 'project_pinned_gpg_key' : 'user_supplied_gpg_key';
const safe = (s: string, n = 160): string => s.replace(/[^\x20-\x7e]/g, '?').slice(0, n);

const result = (
  state: Verification['state'],
  detail: string,
  subject: string | null,
  trust_root: TrustRoot = 'none',
  extra: Partial<Verification> = {},
): Verification => ({
  state,
  trust_root,
  verified_by: state === 'verified' || state === 'invalid' ? 'local' : 'none',
  engine: 'openpgp',
  subject: subject ? safe(subject, 300) : null,
  detail: detail.slice(0, 240),
  identity: null,
  ...extra,
});

export async function verifyGpgDetached(opts: {
  /** ASCII-armored or binary detached signature. */
  signature: string | Buffer;
  /** The exact bytes that were signed. */
  data: Buffer;
  keys: TrustedKey[];
  subject: string;
}): Promise<Verification> {
  const { subject } = opts;
  const gpgKeys = opts.keys.filter((k) => k.kind === 'gpg').slice(0, GPG_LIMITS.maxKeys);
  if (gpgKeys.length === 0)
    return result(
      'verification_unavailable',
      'no trusted GPG key was supplied (--trust-gpg-key or a trust file)',
      subject,
    );
  const sigBytes =
    typeof opts.signature === 'string' ? Buffer.from(opts.signature) : opts.signature;
  if (sigBytes.length === 0 || sigBytes.length > GPG_LIMITS.maxSignatureBytes)
    return result(
      sigBytes.length === 0 ? 'verification_failed' : 'verification_skipped_resource_limit',
      sigBytes.length === 0
        ? 'the signature is empty'
        : `the signature is larger than ${GPG_LIMITS.maxSignatureBytes} bytes; not parsed`,
      subject,
    );
  if (opts.data.length > GPG_LIMITS.maxDataBytes)
    return result(
      'verification_skipped_resource_limit',
      `the signed data is larger than ${GPG_LIMITS.maxDataBytes} bytes; not verified`,
      subject,
    );
  const pgp = await loadOpenPgp();
  if (!pgp)
    return result('verification_unavailable', 'the OpenPGP library is not available', subject);
  try {
    const isArmor = sigBytes.subarray(0, 40).toString('latin1').includes('-----BEGIN PGP');
    let signature;
    try {
      signature = isArmor
        ? await pgp.readSignature({ armoredSignature: sigBytes.toString('utf8') })
        : await pgp.readSignature({ binarySignature: new Uint8Array(sigBytes) });
    } catch {
      return result('verification_failed', 'the signature could not be parsed as OpenPGP', subject);
    }
    // Load the configured keys; a key that cannot be read or fails its fingerprint pin is skipped and counted.
    const loaded: { key: Awaited<ReturnType<OpenPgp['readKey']>>; cfg: TrustedKey }[] = [];
    let rejected = 0;
    for (const cfg of gpgKeys) {
      try {
        // a published key file often carries more than one key (an old and a new one): every key in it is a candidate
        // (a file may also hold several armor blocks one after another: each is read on its own)
        const blocks = cfg.material
          .split(/(?=-----BEGIN PGP PUBLIC KEY BLOCK-----)/)
          .filter((b) => b.includes('BEGIN PGP PUBLIC KEY BLOCK'))
          .slice(0, 8);
        const keys = (await Promise.all(blocks.map((b) => pgp.readKeys({ armoredKeys: b }))))
          .flat()
          .slice(0, 8);
        let accepted = 0;
        for (const key of keys) {
          // the pin names the PRIMARY key; a key that does not have it is not trusted
          if (
            cfg.fingerprint &&
            key.getFingerprint().toUpperCase() !== cfg.fingerprint.toUpperCase()
          )
            continue;
          loaded.push({ key, cfg });
          accepted++;
        }
        if (accepted === 0) rejected++;
      } catch {
        rejected++;
      }
    }
    if (loaded.length === 0)
      return result(
        'verification_failed',
        `none of the ${gpgKeys.length} configured GPG key(s) could be used (${rejected} unreadable or failed the fingerprint pin)`,
        subject,
      );
    // Which configured key claims to have signed? Match the issuer key id / fingerprint of the signature packets.
    const issuers = signature.packets
      .map((p) => (p as unknown as { issuerKeyID?: { toHex(): string } }).issuerKeyID?.toHex())
      .filter((x): x is string => !!x);
    const match = loaded.filter(({ key }) => {
      const ids = new Set(key.getKeyIDs().map((k) => k.toHex()));
      return issuers.some((id) => ids.has(id));
    });
    if (match.length === 0)
      return result(
        'verification_unavailable',
        `signed by key ${safe(issuers[0] ?? 'unknown', 20)}, which is not among the ${loaded.length} trusted key(s)`,
        subject,
      );
    // A trusted key must be valid NOW. A signature carries a creation time the signer chose, so a signature made "while the
    // key was valid" proves nothing about a key that has since expired or been revoked.
    const live: typeof match = [];
    let stale = '';
    for (const m of match) {
      const expires = await m.key.getExpirationTime();
      if (await m.key.isRevoked()) stale = 'the trusted key has been revoked';
      else if (expires instanceof Date && expires.getTime() < Date.now())
        stale = 'the trusted key has expired';
      else live.push(m);
    }
    if (live.length === 0)
      return result(
        'invalid',
        `${stale}; a signature date chosen by the signer cannot prove it was made earlier`,
        subject,
        rootOf((match[0] as (typeof match)[number]).cfg),
      );
    match.length = 0;
    match.push(...live);
    const first = match[0] as (typeof match)[number];
    const verification = await pgp.verify({
      message: await pgp.createMessage({ binary: new Uint8Array(opts.data) }),
      signature,
      verificationKeys: match.map((m) => m.key),
      format: 'binary',
      config: {
        rejectHashAlgorithms: new Set([
          pgp.enums.hash.md5,
          pgp.enums.hash.ripemd,
          pgp.enums.hash.sha1,
        ]),
      },
    });
    const sig = verification.signatures[0];
    if (!sig) return result('verification_failed', 'the library returned no signature', subject);
    try {
      await sig.verified;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'failed';
      const definite =
        /did not match|digest|expired|revoked|not valid|bad signature|invalid/i.test(msg) &&
        !/Could not find signing key/i.test(msg);
      return result(
        definite ? 'invalid' : 'verification_failed',
        safe(msg),
        subject,
        rootOf(first.cfg),
      );
    }
    return result(
      'verified',
      `valid signature by trusted key ${safe(first.key.getFingerprint().slice(-16).toUpperCase(), 20)}`,
      subject,
      rootOf(first.cfg),
    );
  } catch (e) {
    return result(
      'verification_failed',
      safe(e instanceof Error ? e.message : 'verification failed'),
      subject,
    );
  }
}
