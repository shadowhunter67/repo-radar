import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalStringify, compareCodeUnits } from '../../src/report/canonical.js';
import { canonicalReportHash, digestNewReport } from '../../src/report/integrity.js';

describe('canonical JSON for report integrity', () => {
  it('does not depend on key insertion order at any depth, and keeps array order', () => {
    const a = { b: 1, a: { y: [3, 2, 1], x: 'é' } };
    const b = { a: { x: 'é', y: [3, 2, 1] }, b: 1 };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
    expect(canonicalStringify(a)).toBe('{"a":{"x":"é","y":[3,2,1]},"b":1}');
    expect(canonicalStringify({ list: [2, 1] })).not.toBe(canonicalStringify({ list: [1, 2] }));
  });
  it('sorts by UTF-16 code unit, never by locale', () => {
    const keys = ['b', 'B', 'a', 'é', 'Z', '10', '9', '_'];
    expect([...keys].sort(compareCodeUnits)).toEqual(['10', '9', 'B', 'Z', '_', 'a', 'b', 'é']);
    // object keys follow the same order (integer-like keys are ordered numerically by the language itself, identically everywhere)
    expect(canonicalStringify({ b: 1, B: 1, é: 1, a: 1, Z: 1 })).toBe(
      '{"B":1,"Z":1,"a":1,"b":1,"é":1}',
    );
  });
  it('omits undefined members like JSON.stringify and nulls array holes', () => {
    expect(canonicalStringify({ a: undefined, b: [undefined, 1] })).toBe('{"b":[null,1]}');
  });
  it('a new report verifies, a changed one does not, and flipping the format changes the rule', () => {
    const rest = { z: 1, a: { m: 2, k: 1 } };
    const sha = digestNewReport(rest);
    const stored = { ...rest, integrity: { report_sha256: sha, format: 'canonical-json@1' } };
    expect(canonicalReportHash(stored)).toBe(sha);
    expect(canonicalReportHash({ ...stored, z: 2 })).not.toBe(sha);
    // the same digest reached through different key order still verifies
    expect(canonicalReportHash({ integrity: stored.integrity, a: { k: 1, m: 2 }, z: 1 })).toBe(sha);
  });
  it('a report without format keeps the legacy rule (plain JSON.stringify, key order as stored)', () => {
    const rest = { z: 1, a: 2 };
    const legacy = createHash('sha256').update(JSON.stringify(rest)).digest('hex');
    expect(canonicalReportHash({ ...rest, integrity: { report_sha256: legacy } })).toBe(legacy);
    // legacy is order-sensitive, which is exactly why new reports use the canonical format
    expect(canonicalReportHash({ a: 2, z: 1, integrity: { report_sha256: legacy } })).not.toBe(
      legacy,
    );
  });
});
