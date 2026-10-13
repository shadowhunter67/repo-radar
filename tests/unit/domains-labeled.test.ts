import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Hook } from '../../src/analysis/execution.js';
import type { Detection, ScannedFile } from '../../src/analysis/types.js';
import { domainDeltas } from '../../src/domains/diff.js';
import { extractDomains } from '../../src/domains/extract.js';

interface Case {
  id: string;
  path: string;
  role: ScannedFile['role'];
  content: string;
  installFile?: boolean;
  expect: { host: string; context: string }[];
  filtered?: string[];
  known_limitation?: string;
}
interface HistoryFile {
  path: string;
  role: ScannedFile['role'];
  content: string;
  installFile?: boolean;
}
interface HistoryCase {
  id: string;
  before: HistoryFile[];
  after: HistoryFile[];
  expect: { kind: string; host: string; significance: string }[];
}
const data = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '..', '..', 'calibration', 'domains-synthetic.json'),
    'utf8',
  ),
) as { cases: Case[]; history: HistoryCase[] };

const hookFor = (files: string[]): Hook =>
  ({
    id: 'HOOK-1',
    ecosystem: 'npm',
    name: 'postinstall',
    trigger: 'on install',
    runs_for_dependents: true,
    context: 'install',
    risk: 'none',
    confidence: 0.8,
    analyzed: true,
    capabilities: [],
    chain_ids: [],
    unanalyzed_commands: 0,
    node_ids: [],
    files,
  }) as unknown as Hook;
const extract = (files: HistoryFile[]) =>
  extractDomains({
    files: files.map((f) => ({
      path: f.path,
      content: f.content,
      size: f.content.length,
      role: f.role,
    })) as ScannedFile[],
    hooks: files.some((f) => f.installFile)
      ? [hookFor(files.filter((f) => f.installFile).map((f) => f.path))]
      : [],
    detections: [] as Detection[],
  });

describe('labeled synthetic cases for external domain extraction', () => {
  const rows = data.cases.map((c) => {
    const r = extract([c]);
    const got = r.domains.map((d) => `${d.hostname}|${d.strongest_context}`);
    const want = c.expect.map((e) => `${e.host}|${e.context}`);
    return { c, r, got, want };
  });

  it('every case that is not a documented limitation is labeled exactly', () => {
    for (const { c, got, want, r } of rows) {
      if (c.known_limitation) continue;
      expect([...got].sort(), c.id).toEqual([...want].sort());
      for (const cat of c.filtered ?? [])
        expect(r.filtered[cat], `${c.id} filtered ${cat}`).toBeGreaterThan(0);
    }
  });

  it('known limitations stay known: they are still missed or mislabeled, and stay documented', () => {
    const limited = rows.filter((x) => x.c.known_limitation);
    expect(limited.length).toBeGreaterThan(0);
    for (const { c, got, want } of limited) {
      expect([...got].sort(), c.id).not.toEqual([...want].sort());
      expect(c.known_limitation?.length ?? 0).toBeGreaterThan(10);
    }
  });

  it('precision and recall over all labels, limitations included, are what the documentation quotes', () => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const { got, want } of rows) {
      const g = new Set(got);
      const w = new Set(want);
      for (const x of g) {
        if (w.has(x)) tp++;
        else fp++;
      }
      for (const x of w) if (!g.has(x)) fn++;
    }
    const precision = tp / (tp + fp);
    const recall = tp / (tp + fn);
    // quoted in docs/domains.md: update the doc together with these bounds
    expect(precision).toBeGreaterThanOrEqual(0.95);
    expect(recall).toBeGreaterThanOrEqual(0.9);
    expect(tp + fp + fn).toBeGreaterThan(20);
  });
});

describe('labeled synthetic revision pairs', () => {
  for (const h of data.history)
    it(`${h.id}`, () => {
      const deltas = domainDeltas(extract(h.before), extract(h.after), false);
      expect(deltas.map((d) => `${d.kind}|${d.hostname}|${d.significance}`).sort()).toEqual(
        h.expect.map((e) => `${e.kind}|${e.host}|${e.significance}`).sort(),
      );
    });
});
