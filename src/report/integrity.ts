import { createHash } from 'node:crypto';
import { canonicalStringify, INTEGRITY_FORMAT } from './canonical.js';

/**
 * Tamper-evidence digest of a report: SHA-256 over the serialization of every field except `integrity`.
 * It detects accidental or unauthorised edits of a stored report; it is NOT a digital signature, proves nothing about who
 * produced it, and says nothing about whether the content is trustworthy.
 *
 * Reports carrying `integrity.format = "canonical-json@1"` are hashed over canonical JSON (keys sorted by code unit, so the
 * digest does not depend on key insertion order). Reports without `format` were written before that format existed and are
 * verified with the legacy rule (plain `JSON.stringify`, key order as the analyzer built it), so old stored snapshots still verify.
 */
export function canonicalReportHash(report: object): string {
  const { integrity, ...rest } = report as Record<string, unknown>;
  const format = (integrity as { format?: unknown } | undefined)?.format;
  const body = format === INTEGRITY_FORMAT ? canonicalStringify(rest) : JSON.stringify(rest);
  return createHash('sha256').update(body).digest('hex');
}

/** Digest for a freshly built report (always the current format). */
export function digestNewReport(rest: object): string {
  return createHash('sha256').update(canonicalStringify(rest)).digest('hex');
}
