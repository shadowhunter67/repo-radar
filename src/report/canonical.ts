/**
 * Canonical JSON used for report integrity (`integrity.format = "canonical-json@1"`).
 *
 * - object keys are sorted by UTF-16 code unit (never locale-aware), at every depth;
 * - arrays keep their order (ordering that carries meaning is preserved; set-like collections are sorted where the report is
 *   built, not here);
 * - `undefined` members are omitted like `JSON.stringify` does, no whitespace is added.
 *
 * The digest therefore does not depend on object key insertion order, only on the content of the report.
 */
export const INTEGRITY_FORMAT = 'canonical-json@1';

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : canonicalize(v)));
  if (value && typeof value === 'object') {
    const toJson = (value as { toJSON?: () => unknown }).toJSON;
    if (typeof toJson === 'function') return canonicalize(toJson.call(value));
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareCodeUnits)) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

/** Locale-independent, code-unit string comparison (the same on every platform and Node version). */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
