import { createHash } from 'node:crypto';

/**
 * Tamper-evidence digest of a report: SHA-256 over the deterministic JSON serialization of every field except `integrity`.
 * It detects accidental or unauthorised edits of a stored report; it is NOT a digital signature and proves nothing about who
 * produced it. Key order is the order the analyzer builds the report in, so hash the parsed JSON as read, not a re-ordered copy.
 */
export function canonicalReportHash(report: object): string {
  const { integrity: _integrity, ...rest } = report as Record<string, unknown>;
  void _integrity;
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}
