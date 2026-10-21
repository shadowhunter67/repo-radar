import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type IncidentCase = {
  review_status: string;
  source: string;
  split: string;
  ecosystem: string;
  package: string;
  version_before: string;
  version_after: string;
  digest_before: string;
  digest_after: string;
  label: string;
};
type Pair = { package: string; before: { v: string; integrity: string }; after: { v: string; integrity: string } };
const cases = JSON.parse(readFileSync('calibration/incidents-v3/cases.json', 'utf8')) as IncidentCase[];
const pairs = JSON.parse(readFileSync('tests/fixtures/pairs/pairs.json', 'utf8')) as Pair[];
const split = (ecosystem: string, pkg: string): string => {
  const n = createHash('sha256').update(`${ecosystem}:${pkg}`).digest()[0]! % 10;
  return n < 6 ? 'development' : n < 8 ? 'validation' : 'holdout';
};

describe('incident corpus v3', () => {
  it('has valid review state, no split drift, and exact pinned digests', () => {
    for (const c of cases) {
      expect(c.review_status).toBe('ai_assisted_unreviewed');
      if (c.source === 'real_artifact_pair') {
        expect(c.split).toBe(split(c.ecosystem, c.package));
        const pair = pairs.find((p) => p.package === c.package && p.before.v === c.version_before && p.after.v === c.version_after);
        if (!pair) throw new Error(`missing pinned pair for ${c.package}`);
        expect(c.digest_before).toBe(pair.before.integrity);
        expect(c.digest_after).toBe(pair.after.integrity);
      }
    }
  });

  it('does not leak AI labels into the blind-review corpus contract', () => {
    const index = JSON.parse(readFileSync('calibration/incidents-v3/review/index.json', 'utf8')) as { packets: { packet: string }[] };
    expect(index.packets).toHaveLength(cases.length);
    for (const entry of index.packets) {
      const packet = readFileSync(`calibration/incidents-v3/review/${entry.packet}`, 'utf8');
      expect(packet).not.toContain('known_incident');
      expect(packet).not.toContain('known_benign');
      expect(packet).not.toContain('insufficient_evidence');
      expect(packet).toContain('blind');
    }
  });

  it('keeps synthetic plumbing cases out of fresh holdout accounting', () => {
    const synthetic = cases.filter((c) => c.source === 'synthetic_from_real');
    expect(synthetic.length).toBeGreaterThan(0);
    expect(synthetic.every((c) => c.label === 'insufficient_evidence')).toBe(true);
    expect(synthetic.every((c) => c.split !== 'holdout')).toBe(true);
  });
});
