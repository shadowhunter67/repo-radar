import { createHash } from 'node:crypto';
import type { SignerIdentity, Verification } from './model.js';
import { bundleFromJSON } from '@sigstore/bundle';
import { toSignedEntity, toTrustMaterial, Verifier } from '@sigstore/verify';
import type { TrustedRootDocument } from './github-root.js';

/**
 * Sigstore bundle verification through the maintained `sigstore` library (no custom cryptography). The library checks the
 * certificate chain against the Sigstore public-good trust root (fetched through its TUF client from the Sigstore TUF
 * repository), the signature (over a DSSE envelope for attestations, or over the artifact digest for blob signatures) and the
 * transparency-log evidence embedded in the bundle. This module adds only: resource limits, a timeout, an artifact-digest
 * pre-check, error classification, and the comparison of the signer identity with an EXPECTED identity when the user
 * configured one.
 *
 * Verification is opt-in (`verifyCrypto`) because the TUF client reaches `tuf-repo-cdn.sigstore.dev`, a host outside the
 * normal allowlist; nothing else is contacted (Rekor evidence is inside the bundle).
 */
export interface BundleVerifier {
  readonly trustRoot: 'sigstore_public_good';
  /** `data` is the signed artifact for blob (message-signature) bundles. */
  verify(
    bundle: unknown,
    data?: Buffer,
  ): Promise<
    { identity?: { extensions?: { issuer?: string }; subjectAlternativeName?: string } } | undefined
  >;
}

export const SIGSTORE_LIMITS = {
  maxBundleBytes: 256 * 1024,
  /** Certificates in the chain a bundle may carry. A normal keyless bundle has one to three. */
  maxCertificates: 8,
  /** Transparency-log entries. A normal bundle has one. */
  maxTlogEntries: 4,
  /** Subjects of an attestation statement. */
  maxSubjects: 64,
  timeoutMs: 20_000,
} as const;
export const GITHUB_ACTIONS_ISSUER = 'https://token.actions.githubusercontent.com';

/** Loads the library lazily; undefined when it is not installed or cannot start. */
export async function loadSigstoreVerifier(): Promise<BundleVerifier | undefined> {
  try {
    const mod = (await import('sigstore')) as unknown as {
      createVerifier: (
        o: Record<string, unknown>,
      ) => Promise<{ verify: (b: unknown, d?: Buffer) => Promise<unknown> }>;
    };
    const v = await mod.createVerifier({});
    return {
      trustRoot: 'sigstore_public_good',
      verify: (b, d) => (d ? v.verify(b, d) : v.verify(b)) as ReturnType<BundleVerifier['verify']>,
    };
  } catch {
    return undefined;
  }
}

const clean = (x: string | null | undefined, n: number): string | null =>
  typeof x === 'string' && x.length > 0
    ? [...x]
        .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
        .join('')
        .slice(0, n)
    : null;

/** `https://github.com/owner/repo/.github/workflows/x.yml@refs/tags/v1` -> owner/repo + workflow ref. */
export function parseWorkflowIdentity(
  san: string | undefined | null,
  issuer: string | undefined | null,
): SignerIdentity {
  const s = clean(san, 400);
  const m = s
    ? /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(\.github\/workflows\/[^@]+@.+)$/.exec(s)
    : null;
  return {
    issuer: clean(issuer, 200),
    subject_alternative_name: s,
    source_repository: m ? (m[1] as string).toLowerCase() : null,
    workflow_ref: m ? (m[2] as string).slice(0, 300) : null,
    commit: null,
    ref: null,
    runner_build_identity: null,
    binding: {
      issuer: 'cryptographically_bound',
      subject_alternative_name: 'cryptographically_bound',
      source_repository: m ? 'cryptographically_bound' : 'claimed',
      workflow_ref: m ? 'cryptographically_bound' : 'claimed',
    },
  };
}

/**
 * The identity a user EXPECTS the signer to have. It comes from the user's own configuration (command line or trust file),
 * never from the analyzed repository.
 */
export interface ExpectedIdentity {
  /** `owner/repo` of the GitHub Actions workflow that must have signed. */
  sourceRepository?: string;
  /** Exact certificate subject alternative name. */
  san?: string;
  /** Exact OIDC issuer. */
  issuer?: string;
}

function identityMatches(id: SignerIdentity, want: ExpectedIdentity): string | null {
  if (want.sourceRepository && id.source_repository !== want.sourceRepository.toLowerCase())
    return `signed by ${id.source_repository ?? 'an identity that is not a GitHub workflow'}, expected ${want.sourceRepository.toLowerCase()}`;
  if (want.san && id.subject_alternative_name !== want.san)
    return 'the certificate subject is not the expected one';
  if (want.issuer && id.issuer !== want.issuer) return 'the OIDC issuer is not the expected one';
  return null;
}

/**
 * A rejection (`invalid`) means the verifier inspected the bundle and the signature, certificate chain or identity is
 * wrong. Errors that say the verifier LACKED trust material for some part of the bundle (a timestamp authority or
 * transparency-log key outside the configured trust root, a different Sigstore instance) are `verification_failed`: no
 * decision was reached, which is neither a pass nor evidence of forgery.
 */
const NO_DECISION =
  /timestamp|trusted root|trust root|authority|tlog|transparency|no matching|unsupported|bundle type|mediaType/i;
/** Messages that describe evidence the verifier INSPECTED and found wrong, even when they mention the log. */
const REJECTED =
  /inclusion proof|root hash|signature (?:verification failed|mismatch)|digest mismatch|expired|not valid or expired|no trusted certificate path|failed to verify certificate chain/i;
/** The library's own error codes (BaseError.code). A code is more reliable than the wording of its message. */
const REJECTED_CODES = new Set([
  'SIGNATURE_ERROR',
  'TLOG_INCLUSION_PROOF_ERROR',
  'TLOG_INCLUSION_PROMISE_ERROR',
  'TLOG_BODY_ERROR',
  'UNTRUSTED_SIGNER_ERROR',
  'CERTIFICATE_ERROR',
]);
const NO_DECISION_CODES = new Set(['PUBLIC_KEY_ERROR', 'TIMESTAMP_ERROR', 'TLOG_ERROR']);
const classify = (e: unknown): 'invalid' | 'verification_failed' => {
  const name = e instanceof Error ? e.name : '';
  const msg = e instanceof Error ? e.message : '';
  const code = (e as { code?: unknown } | null)?.code;
  if (!/^(?:VerificationError|PolicyError|ValidationError)$/.test(name))
    return 'verification_failed';
  if (typeof code === 'string') {
    if (REJECTED_CODES.has(code)) return 'invalid';
    if (NO_DECISION_CODES.has(code)) return 'verification_failed';
  }
  if (REJECTED.test(msg)) return 'invalid';
  return NO_DECISION.test(msg) ? 'verification_failed' : 'invalid';
};

export type BundleShape =
  | { kind: 'unknown' }
  | {
      kind: 'blob' | 'attestation';
      certificates: number;
      tlogEntries: number;
      subjects: number;
      digestHex: string | null;
    };

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {};

/**
 * Structural summary of a bundle used for the resource limits and the digest pre-check. It reads counts only; trust
 * decisions stay with the library.
 */
export function inspectBundle(bundle: unknown): BundleShape {
  const b = obj(bundle);
  const vm = obj(b['verificationMaterial']);
  const chain = obj(vm['x509CertificateChain'])['certificates'];
  const certificates = Array.isArray(chain) ? chain.length : vm['certificate'] ? 1 : 0;
  const tl = vm['tlogEntries'];
  const tlogEntries = Array.isArray(tl) ? tl.length : 0;
  const ms = obj(b['messageSignature']);
  if (Object.keys(ms).length > 0) {
    const d = obj(ms['messageDigest'])['digest'];
    let hex: string | null = null;
    if (typeof d === 'string' && d.length <= 200) {
      try {
        hex = Buffer.from(d, 'base64').toString('hex');
      } catch {
        hex = null;
      }
    }
    return { kind: 'blob', certificates, tlogEntries, subjects: 1, digestHex: hex };
  }
  const env = obj(b['dsseEnvelope']);
  if (Object.keys(env).length > 0) {
    let subjects = 0;
    const payload = env['payload'];
    if (typeof payload === 'string' && payload.length <= SIGSTORE_LIMITS.maxBundleBytes) {
      try {
        const st = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as Json;
        subjects = Array.isArray(st['subject']) ? st['subject'].length : 0;
      } catch {
        subjects = 0;
      }
    }
    return { kind: 'attestation', certificates, tlogEntries, subjects, digestHex: null };
  }
  return { kind: 'unknown' };
}

export interface VerifyBundleOptions {
  /** The signed artifact, required for a blob (message-signature) bundle. */
  data?: Buffer;
  /** Identity the user expects; a mismatch is `invalid`. */
  expectedIdentity?: ExpectedIdentity;
  /** What is being verified (asset name or digest), recorded in the result. */
  subject?: string;
  expectedSubjectDigest?: string;
}

const subjectOf = (o: VerifyBundleOptions): string | null =>
  o.subject ? o.subject.replace(/[^\x20-\x7e]/g, '?').slice(0, 300) : null;

/** Verify one bundle. Never throws; the result always names the trust root, the engine and who verified. */
export async function verifyBundle(
  verifier: BundleVerifier | undefined,
  bundle: unknown,
  options: VerifyBundleOptions = {},
): Promise<Verification> {
  const subject = subjectOf(options);
  const base = {
    verified_by: 'none' as const,
    engine: 'sigstore' as const,
    subject,
    identity: null,
  };
  if (!verifier)
    return {
      ...base,
      state: 'verification_unavailable',
      trust_root: 'none',
      engine: 'none',
      detail: 'the sigstore verifier is not available',
    };
  const trustRoot = verifier.trustRoot;
  let size = 0;
  try {
    size = JSON.stringify(bundle)?.length ?? 0;
  } catch {
    size = Infinity;
  }
  if (!(size > 0))
    return {
      ...base,
      state: 'verification_failed',
      trust_root: trustRoot,
      detail: 'bundle is empty or unreadable',
    };
  if (size > SIGSTORE_LIMITS.maxBundleBytes)
    return {
      ...base,
      state: 'verification_skipped_resource_limit',
      trust_root: trustRoot,
      detail: `bundle exceeds the size limit (${SIGSTORE_LIMITS.maxBundleBytes} bytes) and was not passed to the verifier`,
    };
  const shape = inspectBundle(bundle);
  // An unrecognized shape is passed on: the library validates bundles and its answer is what gets classified.
  const over =
    shape.kind === 'unknown'
      ? null
      : shape.certificates > SIGSTORE_LIMITS.maxCertificates
        ? `${shape.certificates} certificates (limit ${SIGSTORE_LIMITS.maxCertificates})`
        : shape.tlogEntries > SIGSTORE_LIMITS.maxTlogEntries
          ? `${shape.tlogEntries} transparency-log entries (limit ${SIGSTORE_LIMITS.maxTlogEntries})`
          : shape.subjects > SIGSTORE_LIMITS.maxSubjects
            ? `${shape.subjects} subjects (limit ${SIGSTORE_LIMITS.maxSubjects})`
            : null;
  if (over)
    return {
      ...base,
      state: 'verification_skipped_resource_limit',
      trust_root: trustRoot,
      detail: `bundle carries ${over}; not passed to the verifier`,
    };
  let data: Buffer | undefined;
  if (shape.kind === 'blob') {
    if (!options.data)
      return {
        ...base,
        state: 'verification_unavailable',
        trust_root: trustRoot,
        detail: 'a blob signature bundle needs the signed artifact bytes, which were not available',
      };
    data = options.data;
    // The digest in the bundle is what the signature covers; a different artifact can never verify, whatever the chain says.
    if (shape.digestHex && createHash('sha256').update(data).digest('hex') !== shape.digestHex)
      return {
        ...base,
        state: 'invalid',
        trust_root: trustRoot,
        verified_by: 'local',
        detail: 'the artifact digest does not match the digest the bundle signs',
      };
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    const r = await Promise.race([
      verifier.verify(bundle, data),
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
    if (options.expectedIdentity) {
      const mismatch = identityMatches(id, options.expectedIdentity);
      if (mismatch)
        return {
          ...base,
          state: 'invalid',
          trust_root: trustRoot,
          verified_by: 'local',
          detail: `valid signature, but ${mismatch}`.slice(0, 240),
          identity: id,
        };
    }
    return {
      ...base,
      state: 'verified',
      trust_root: trustRoot,
      verified_by: 'local',
      detail:
        shape.kind === 'blob'
          ? 'certificate chain, signature over the artifact digest and transparency-log evidence accepted'
          : 'certificate chain, signature and transparency-log evidence accepted',
      identity: id,
    };
  } catch (e) {
    const state = classify(e);
    const msg = (e instanceof Error ? e.message : 'failed')
      .replace(/[^\x20-\x7e]/g, '?')
      .slice(0, 160);
    return { ...base, state, trust_root: trustRoot, verified_by: 'local', detail: msg };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Verify against one explicitly supplied root. No TUF/network access occurs here. */
export function verifyBundleWithRoot(
  bundle: unknown,
  root: TrustedRootDocument,
  options: VerifyBundleOptions = {},
): Verification {
  const subject = subjectOf(options);
  const base = {
    verified_by: 'local' as const,
    engine: 'sigstore' as const,
    subject,
    identity: null,
  };
  try {
    const raw = JSON.stringify(bundle);
    if (!raw || Buffer.byteLength(raw) > SIGSTORE_LIMITS.maxBundleBytes)
      return {
        ...base,
        state: 'verification_skipped_resource_limit',
        trust_root: root.label,
        detail: 'bundle exceeds the size limit',
      };
    const parsed = bundleFromJSON(bundle as Parameters<typeof bundleFromJSON>[0]);
    const shape = inspectBundle(bundle);
    if (shape.kind === 'blob' && !options.data)
      return {
        ...base,
        state: 'verification_unavailable',
        trust_root: root.label,
        detail: 'blob verification needs artifact bytes',
      };
    const signer = new Verifier(toTrustMaterial(root.root)).verify(
      toSignedEntity(parsed, options.data),
    );
    const id = parseWorkflowIdentity(
      signer.identity?.subjectAlternativeName,
      signer.identity?.extensions?.issuer,
    );
    if (options.expectedIdentity) {
      const mismatch = identityMatches(id, options.expectedIdentity);
      if (mismatch)
        return {
          ...base,
          state: 'identity_mismatch',
          trust_root: root.label,
          detail: mismatch,
          identity: id,
        };
    }
    if (options.expectedSubjectDigest && shape.kind === 'attestation') {
      const payload = (bundle as { dsseEnvelope?: { payload?: string } }).dsseEnvelope?.payload;
      const statement = payload
        ? (JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as {
            subject?: Array<{ digest?: Record<string, string> }>;
          })
        : {};
      const digests = (statement.subject ?? []).flatMap((s) => Object.values(s.digest ?? {}));
      if (!digests.some((d) => d.toLowerCase() === options.expectedSubjectDigest?.toLowerCase()))
        return {
          ...base,
          state: 'verified_digest_only',
          trust_root: root.label,
          detail: 'signature verified but subject digest did not match',
          identity: id,
        };
    }
    return {
      ...base,
      state:
        root.label === 'github_attestation_instance' ? 'verified_github_attestation' : 'verified',
      trust_root: root.label,
      detail: 'certificate chain, signature and transparency-log evidence accepted',
      identity: id,
    };
  } catch (e) {
    return {
      ...base,
      state: 'verification_failed',
      trust_root: root.label,
      detail: (e instanceof Error ? e.message : 'verification failed').slice(0, 240),
    };
  }
}
