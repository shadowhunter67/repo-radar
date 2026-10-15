import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assignIncidentSplit, loadIncidentCases } from '../../src/calibration/incidents.js';
import { packageRoot } from '../../src/util/paths.js';

const root = join(packageRoot(), 'calibration', 'incidents');
const cases = loadIncidentCases(root);

describe('incident calibration corpus', () => {
  it('has frozen valid cases and non-template windows', () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
    expect(
      new Set(cases.map((c) => `${c.incident_window.from}/${c.incident_window.to}`)).size,
    ).toBeGreaterThan(3);
    for (const c of cases) {
      expect(assignIncidentSplit(c.ecosystem, c.package)).toBe(c.split);
      expect(Date.parse(c.incident_window.from)).toBeLessThanOrEqual(
        Date.parse(c.incident_window.to),
      );
      expect(
        c.sources.length > 0 || ['unknown', 'insufficient_evidence'].includes(c.conclusion),
      ).toBe(true);
      expect(c.expected_events).toBeDefined();
    }
  });

  it('keeps raw-derived expectations independent and packets blind', () => {
    for (const c of cases) expect(readFileSync(join(root, c.raw_file), 'utf8')).toContain('{');
    for (const file of readdirSync(join(root, 'review', 'packets'))) {
      const packet = JSON.parse(readFileSync(join(root, 'review', 'packets', file), 'utf8'));
      expect(packet.label).toBe('');
      expect(packet.conclusion).toBe('');
      expect(packet.pattern_expectations).toBeUndefined();
    }
  });

  it('has incident and benign coverage in development and validation', () => {
    for (const split of ['development', 'validation']) {
      const part = cases.filter((c) => c.split === split);
      expect(part.some((c) => c.kind === 'incident')).toBe(true);
      expect(part.some((c) => c.kind !== 'incident')).toBe(true);
      for (const pattern of Object.keys(part[0]!.pattern_expectations))
        expect(
          part.some(
            (c) => c.kind !== 'incident' && c.pattern_expectations[pattern]!.should_fire === false,
          ),
        ).toBe(true);
    }
  });
});
