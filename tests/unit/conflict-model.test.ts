import { describe, expect, it } from 'vitest';
import {
  ConflictSchema,
  observation,
  PRECEDENCE,
  resolveConflict,
  SOURCE_IDS,
  SOURCE_QUALITY,
} from '../../src/evidence/conflict.js';

describe('source quality', () => {
  it('declares a quality for every source and distinguishes revision-bound from current data', () => {
    for (const s of SOURCE_IDS) expect(SOURCE_QUALITY[s]).toBeDefined();
    expect(SOURCE_QUALITY.lockfile.temporal).toBe('revision_bound');
    expect(SOURCE_QUALITY.registry).toMatchObject({
      temporal: 'current',
      mutability: 'mutable',
      provenance: 'third_party',
    });
    expect(SOURCE_QUALITY.advisory_db.temporal).toBe('current');
  });
});

describe('resolveConflict', () => {
  const base = {
    id: 'CONF-001',
    subject: 'npm:qs',
    field: 'exact_version',
    confidence: 0.9,
    severity: 'low' as const,
    evidenceIds: ['DEP-0001'],
  };

  it('keeps every observation, prefers by the named question and explains why', () => {
    const c = resolveConflict({
      ...base,
      question: 'exact_version',
      observations: [
        observation('sbom', 'sbom.json', '6.11.2'),
        observation('manifest_pin', 'package.json', '6.10.0'),
        observation('lockfile', 'package-lock.json', '6.14.2'),
      ],
    });
    expect(c.observations).toHaveLength(3);
    expect(c.preferred).toBe('lockfile');
    expect(c.resolution_reason).toContain('lockfile > sbom > manifest_pin');
    expect(c.resolution_reason).toContain('bound to the analyzed revision');
    expect(ConflictSchema.safeParse(c).success).toBe(true);
  });

  it('has no preference when the policy has no opinion for the question', () => {
    const c = resolveConflict({
      ...base,
      question: 'unknown_question',
      observations: [observation('registry', 'deps.dev', '1'), observation('lockfile', 'x', '2')],
    });
    expect(c.preferred).toBeUndefined();
    expect(c.resolution_reason).toBeUndefined();
    expect(PRECEDENCE['exact_version']).toEqual(['lockfile', 'sbom', 'manifest_pin']);
  });

  it('a registry value is never preferred for the exact installed version', () => {
    const c = resolveConflict({
      ...base,
      question: 'exact_version',
      observations: [
        observation('registry', 'deps.dev', '9.9.9'),
        observation('manifest_pin', 'package.json', '1.0.0'),
      ],
    });
    expect(c.preferred).toBe('manifest_pin');
  });
});
