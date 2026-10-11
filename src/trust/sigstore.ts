import type { SignerIdentity, Verification } from './model.js';

/**
 * Sigstore bundle verification through the maintained `sigstore` library (no custom cryptography). The library checks the
 * certificate chain against the Sigstore public-good trust root (fetched through its TUF client from the Sigstore TUF
 * repository), the signature over the DSSE envelope and the transparency-log evidence embedded in the bundle. This module
 * adds only: input limits, a timeout, error classification and parsing of the signer identity.
 *
 * Verification is opt-in (`verifyCrypto`) because the TUF client reaches `tuf-repo-cdn.sigstore.dev`, a host outside the
 * normal allowlist; nothing else is contacted (Rekor evidence is inside the bundle).
 */
export interface BundleVerifier {
  readonly trustRoot: 'sigstore_public_good';
  verify(
    bundle: unknown,
  ): Promise<
    { identity?: { extensions?: { issuer?: string }; subjectAlternativeName?: string } } | undefined
  >;
}

export const SIGSTORE_LIMITS = { maxBundleBytes: 256 * 1024, timeoutMs: 20_000 } as const;
export const GITHUB_ACTIONS_ISSUER = 'https://token.actions.githubusercontent.com';

/** Loads the library lazily; undefined when it is not installed or cannot start. */
export async function loadSigstoreVerifier(): Promise<BundleVerifier | undefined> {
  try {
    const mod = (await import('sigstore')) as unknown as {
      createVerifier: (
        o: Record<string, unknown>,
      ) => Promise<{ verify: (b: unknown) => Promise<unknown> }>;
    };
    const v = await mod.createVerifier({});
    return {
      trustRoot: 'sigstore_public_good',
      verify: (b) => v.verify(b) as ReturnType<BundleVerifier['verify']>,
    };
  } catch {
    return undefined;
  }
}

/** `https://github.com/owner/repo/.github/workflows/x.yml@refs/tags/v1` -> owner/repo + workflow ref. */
export function parseWorkflowIdentity(
  san: string | undefined | null,
  issuer: string | undefined | null,
): SignerIdentity {
  const clean = (x: string | null | undefined, n: number): string | null =>
    typeof x === 'string' && x.length > 0
      ? [...x]
          .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
          .join('')
          .slice(0, n)
      : null;
  const s = clean(san, 400);
  const m = s
    ? /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(\.github\/workflows\/[^@]+@.+)$/.exec(s)
    : null;
  return {
    issuer: clean(issuer, 200),
    subject_alternative_name: s,
    source_repository: m ? (m[1] as string).toLowerCase() : null,
    workflow_ref: m ? (m[2] as string).slice(0, 300) : null,
  };
}

/**
 * A rejection (`invalid`) means the verifier inspected the bundle and the signature, certificate chain or identity is
 * wrong. Errors that say the verifier LACKED trust material for some part of the bundle (a timestamp authority or
 * transparency-log key outside the configured trust root, a different Sigstore instance) are `verification_failed`: no
 * decision was reached, which is neither a pass nor evidence of forgery.
 */
const NO_DECISION =
  /timestamp|trusted root|trust root|authority|tlog|transparency|no matching|unsupported|bundle type|mediaType/i;
const classify = (e: unknown): 'invalid' | 'verification_failed' => {
  const name = e instanceof Error ? e.name : '';
  const msg = e instanceof Error ? e.message : '';
  if (!/^(?:VerificationError|PolicyError|ValidationError)$/.test(name))
    return 'verification_failed';
  return NO_DECISION.test(msg) ? 'verification_failed' : 'invalid';
};

/** Verify one bundle. Never throws; the result always names the trust root and who verified. */
export async function verifyBundle(
  verifier: BundleVerifier | undefined,
  bundle: unknown,
): Promise<Verification> {
  if (!verifier)
    return {
      state: 'verification_unavailable',
      trust_root: 'none',
      verified_by: 'none',
      detail: 'the sigstore verifier is not available',
      identity: null,
    };
  let size = 0;
  try {
    size = JSON.stringify(bundle)?.length ?? 0;
  } catch {
    size = Infinity;
  }
  if (!(size > 0) || size > SIGSTORE_LIMITS.maxBundleBytes)
    return {
      state: 'verification_failed',
      trust_root: verifier.trustRoot,
      verified_by: 'none',
      detail:
        size > 0
          ? 'bundle exceeds the size limit and was not passed to the verifier'
          : 'bundle is empty or unreadable',
      identity: null,
    };
  let timer: NodeJS.Timeout | undefined;
  try {
    const r = await Promise.race([
      verifier.verify(bundle),
      new Promise<never>((_, rej) => {
        timer = setTimeout(
          () => rej(Object.assign(new Error('verification timed out'), { name: 'TimeoutError' })),
          SIGSTORE_LIMITS.timeoutMs,
        );
      }),
    ]);
    const id = parseWorkflowIdentity(
      r?.identity?.subjectAlternativeName,
      r?.identity?.extensions?.issuer,
    );
    return {
      state: 'verified',
      trust_root: verifier.trustRoot,
      verified_by: 'local',
      detail: 'certificate chain, signature and transparency-log evidence accepted',
      identity: id,
    };
  } catch (e) {
    const state = classify(e);
    const msg = (e instanceof Error ? e.message : 'failed')
      .replace(/[^\x20-\x7e]/g, '?')
      .slice(0, 160);
    return {
      state,
      trust_root: verifier.trustRoot,
      verified_by: 'local',
      detail: msg,
      identity: null,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
