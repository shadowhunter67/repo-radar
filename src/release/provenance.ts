import type { Provenance } from './model.js';

/**
 * Parse an in-toto statement (as carried by a Sigstore/GitHub attestation bundle's DSSE envelope) into a ProvenanceRecord.
 * The JSON is untrusted: sizes and depth are bounded and every field is type-checked. The envelope SIGNATURE is not verified
 * here, so the record always says `verification_unavailable` unless GitHub itself returned it from its attestation API with
 * verification (not currently requested). Parsing a statement is not a SLSA level.
 */
export const PROVENANCE_LIMITS = { maxBytes: 1024 * 1024, maxSubjects: 20 } as const;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {};
const s = (v: unknown, n = 300): string | null =>
  typeof v === 'string' && v.length > 0 ? v.slice(0, n) : null;

/** Safe base64 (standard or url) decode with a size cap; returns undefined on anything odd. */
export function decodeBase64Capped(
  b64: unknown,
  maxBytes = PROVENANCE_LIMITS.maxBytes,
): string | undefined {
  if (typeof b64 !== 'string' || b64.length > maxBytes * 2 || !/^[A-Za-z0-9+/_=-]*$/.test(b64))
    return undefined;
  try {
    const buf = Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    return buf.length > maxBytes ? undefined : buf.toString('utf8');
  } catch {
    return undefined;
  }
}

export function parseStatement(
  statement: unknown,
  origin: Provenance['origin'],
): Provenance | undefined {
  const st = obj(statement);
  const predicateType = s(st['predicateType'], 200);
  if (!predicateType) return undefined;
  const problems: string[] = [];
  const subjectsRaw = Array.isArray(st['subject']) ? st['subject'] : [];
  if (subjectsRaw.length > PROVENANCE_LIMITS.maxSubjects) problems.push('subject list truncated');
  const subject = subjectsRaw.slice(0, PROVENANCE_LIMITS.maxSubjects).flatMap((x) => {
    const o = obj(x);
    const d = obj(o['digest']);
    const alg = Object.keys(d).find((k) => typeof d[k] === 'string');
    return alg
      ? [
          {
            name: (s(o['name']) ?? '').slice(0, 300),
            algorithm: alg.slice(0, 20),
            digest: String(d[alg]).toLowerCase().slice(0, 200),
          },
        ]
      : [];
  });
  if (subject.length === 0) problems.push('no subject with a digest');
  const pred = obj(st['predicate']);
  const slsa = /^https:\/\/slsa\.dev\/provenance\//.test(predicateType);
  let builder: string | null = null;
  let buildType: string | null = null;
  let repo: string | null = null;
  let revision: string | null = null;
  let invocation: string | null = null;
  if (slsa) {
    if (/\/v1/.test(predicateType)) {
      // SLSA v1: runDetails.builder.id, buildDefinition.{buildType, externalParameters, resolvedDependencies}
      const rd = obj(pred['runDetails']);
      const bd = obj(pred['buildDefinition']);
      builder = s(obj(rd['builder'])['id']);
      buildType = s(bd['buildType']);
      const ext = obj(bd['externalParameters']);
      const wf = obj(ext['workflow']);
      repo = s(wf['repository']) ?? s(ext['source']);
      const deps = Array.isArray(bd['resolvedDependencies']) ? bd['resolvedDependencies'] : [];
      const first = obj(deps[0]);
      revision = s(obj(first['digest'])['gitCommit'], 100);
      repo = repo ?? s(first['uri']);
      invocation = s(obj(rd['metadata'])['invocationId']);
    } else {
      // SLSA v0.2
      builder = s(obj(pred['builder'])['id']);
      buildType = s(pred['buildType']);
      const mat = Array.isArray(pred['materials']) ? pred['materials'] : [];
      const first = obj(mat[0]);
      repo = s(first['uri']);
      revision = s(obj(first['digest'])['sha1'], 100);
      invocation = s(
        obj(pred['invocation'])['configSource']
          ? obj(obj(pred['invocation'])['configSource'])['uri']
          : null,
      );
    }
  } else problems.push('predicate is not SLSA provenance');
  // GitHub's release-attestation predicate is in-toto rather than SLSA. Its repository
  // claim is still useful for source binding, but it does not carry a commit revision.
  if (!slsa) repo = s(pred['repository']) ?? repo;
  if (revision && !/^[0-9a-f]{40}$/i.test(revision)) {
    problems.push('source revision is not a full commit sha');
    revision = null;
  }
  return {
    subject,
    predicate_type: predicateType,
    slsa,
    builder_id: builder,
    build_type: buildType,
    source_repository: repo,
    source_revision: revision ? revision.toLowerCase() : null,
    invocation,
    verification: 'present_unverified',
    verification_detail: null,
    origin,
    problems,
  };
}

/**
 * Extract statements from a GitHub attestation API response: `{attestations:[{bundle:{dsseEnvelope:{payload}}}]}`.
 * Unparseable bundles are counted, never trusted.
 */
export function provenanceFromAttestationResponse(body: unknown): {
  records: Provenance[];
  unreadable: number;
  /** Attestations the API listed, whether or not their bundle could be read here. */
  listed: number;
  /** The bundle objects of `records`, index-aligned, for an optional cryptographic verifier. */
  bundles: unknown[];
  /** Listed attestations whose bundle was not inlined (large bundles come as a `bundle_url` on another host, which is never fetched). */
  not_inlined: number;
} {
  const records: Provenance[] = [];
  const bundles: unknown[] = [];
  let unreadable = 0;
  let notInlined = 0;
  const list = Array.isArray(obj(body)['attestations'])
    ? (obj(body)['attestations'] as unknown[])
    : [];
  for (const a of list.slice(0, 10)) {
    if (obj(a)['bundle'] == null && typeof obj(a)['bundle_url'] === 'string') {
      notInlined++;
      continue;
    }
    const payload = obj(obj(obj(a)['bundle'])['dsseEnvelope'])['payload'];
    const text = decodeBase64Capped(payload);
    if (text === undefined) {
      unreadable++;
      continue;
    }
    try {
      const rec = parseStatement(JSON.parse(text) as unknown, 'github_attestation_api');
      if (rec) {
        records.push(rec);
        bundles.push(obj(a)['bundle']);
      } else unreadable++;
    } catch {
      unreadable++;
    }
  }
  return {
    records,
    bundles,
    unreadable,
    listed: Math.min(list.length, 10),
    not_inlined: notInlined,
  };
}
