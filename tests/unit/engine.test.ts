import { describe, expect, it } from 'vitest';
import { EvidenceStore } from '../../src/evidence/store.js';
import type { Evidence } from '../../src/evidence/types.js';
import { conditionHolds, evaluate, scoreValue } from '../../src/scoring/engine.js';
import { gradeFor } from '../../src/scoring/grade.js';
import { evaluatePolicy, parseMinimums } from '../../src/scoring/policy.js';
import { ProfileSchema, RuleSchema, type Rule, type Scoring } from '../../src/scoring/types.js';

function E(id: string, value: Evidence['value'], o: Partial<Evidence> = {}): Evidence {
  return {
    id,
    value,
    source: 'github',
    kind: 'fact',
    observed_at: '2026-01-01T00:00:00Z',
    confidence: 1,
    provenance: {},
    metadata: {},
    ...o,
  };
}
function R(o: Record<string, unknown>): Rule {
  return RuleSchema.parse({
    dimension: 'security',
    title: 'test rule',
    rationale: 'test rationale text',
    weight: 10,
    scoring: { type: 'map', values: { true: 10, false: 0 } },
    ...o,
  });
}
const P = (o: Record<string, unknown> = {}) =>
  ProfileSchema.parse({ id: 'test', version: '0', title: 't', description: 'd', ...o });
const store = (...es: Evidence[]) => new EvidenceStore(es);
const sec = (r: ReturnType<typeof evaluate>) =>
  r.dimensions.find((d) => d.dimension === 'security')!;

describe('scoreValue', () => {
  it('maps booleans, strings and defaults', () => {
    const s: Scoring = { type: 'map', values: { none: 0, MIT: 10 }, default: 7 };
    expect(scoreValue('none', s)).toBe(0);
    expect(scoreValue('Apache-2.0', s)).toBe(7);
    expect(scoreValue(true, { type: 'map', values: { true: 9 } })).toBe(9);
    expect(scoreValue(false, { type: 'map', values: { true: 9 } })).toBeUndefined();
  });
  it('thresholds are order-independent and first match from the top wins', () => {
    const a: Scoring = {
      type: 'thresholds',
      steps: [
        { gte: 1, score: 3 },
        { gte: 10, score: 9 },
      ],
      otherwise: 0,
    };
    expect(scoreValue(10, a)).toBe(9);
    expect(scoreValue(5, a)).toBe(3);
    expect(scoreValue(0, a)).toBe(0);
    expect(scoreValue('x', a)).toBeUndefined();
  });
  it('linear clamps and inverts', () => {
    const l: Extract<Scoring, { type: 'linear' }> = {
      type: 'linear',
      min: 0,
      max: 1,
      invert: false,
    };
    expect(scoreValue(0.5, l)).toBe(5);
    expect(scoreValue(7, l)).toBe(10);
    expect(scoreValue(-3, l)).toBe(0);
    expect(scoreValue(0.25, { ...l, invert: true })).toBe(7.5);
    expect(scoreValue(1, { type: 'linear', min: 1, max: 1, invert: false })).toBeUndefined();
  });
  it('arrays are scored by length', () => {
    expect(
      scoreValue(['a', 'b'], { type: 'thresholds', steps: [{ gte: 2, score: 8 }], otherwise: 1 }),
    ).toBe(8);
  });
});

describe('applies_when', () => {
  it('evaluates each operator', () => {
    expect(conditionHolds({ evidence: 'a.b', equals: true }, true)).toBe(true);
    expect(conditionHolds({ evidence: 'a.b', equals: true }, 'true')).toBe(false);
    expect(conditionHolds({ evidence: 'a.b', gt: 0 }, 1)).toBe(true);
    expect(conditionHolds({ evidence: 'a.b', gt: 0 }, 0)).toBe(false);
    expect(conditionHolds({ evidence: 'a.b', gte: 2 }, ['x', 'y'])).toBe(true);
    expect(conditionHolds({ evidence: 'a.b', lt: 2 }, 'text')).toBe(false);
  });
  it('rejects a condition with zero or several operators', () => {
    expect(() =>
      R({ id: 'security.x', evidence: ['a.b'], applies_when: { evidence: 'a.c' } }),
    ).toThrow();
    expect(() =>
      R({ id: 'security.x', evidence: ['a.b'], applies_when: { evidence: 'a.c', gt: 1, lt: 3 } }),
    ).toThrow();
  });
  it('makes a rule not_applicable (excluded from score AND coverage) when the condition fails', () => {
    const rules = [
      R({ id: 'security.a', evidence: ['x.a'], weight: 5 }),
      R({ id: 'security.b', evidence: ['x.b'], weight: 5 }),
      R({
        id: 'security.c',
        evidence: ['x.c'],
        weight: 10,
        applies_when: { evidence: 'x.n', gt: 0 },
      }),
    ];
    const r = sec(evaluate(store(E('x.a', true), E('x.b', true), E('x.n', 0)), rules, P()));
    expect(r.rules.find((x) => x.rule_id === 'security.c')!.status).toBe('not_applicable');
    expect(r.coverage).toBe(1);
    expect(r.score).toBe(100);
  });
  it('keeps the rule applicable when the condition evidence itself is unobserved (conservative)', () => {
    const rules = [
      R({ id: 'security.a', evidence: ['x.a'] }),
      R({ id: 'security.c', evidence: ['x.c'], applies_when: { evidence: 'x.n', gt: 0 } }),
    ];
    const r = sec(evaluate(store(E('x.a', true)), rules, P()));
    expect(r.rules[1]!.status).toBe('not_observed');
    expect(r.coverage).toBe(0.5);
  });
});

describe('missing evidence', () => {
  it('never lowers the score, only the coverage/confidence', () => {
    const base = [
      R({ id: 'security.a', evidence: ['x.a'] }),
      R({ id: 'security.b', evidence: ['x.b'] }),
    ];
    const more = [...base, R({ id: 'security.c', evidence: ['x.c'], weight: 30 })];
    const s = store(E('x.a', true), E('x.b', true));
    const a = sec(evaluate(s, base, P()));
    const b = sec(evaluate(s, more, P()));
    expect(b.score).toBe(a.score);
    expect(b.coverage).toBeLessThan(a.coverage);
    expect(b.confidence).toBeLessThan(a.confidence);
  });
  it('classifies why a signal is missing', () => {
    const rules = [
      R({ id: 'security.a', evidence: ['github.contributors.count'] }),
      R({ id: 'security.b', evidence: ['scorecard.check.x'] }),
      R({ id: 'security.c', evidence: ['osv.vulnerable_ratio'] }),
      R({ id: 'security.d', evidence: ['github.file.zzz'] }),
    ];
    const d = sec(
      evaluate(store(), rules, P(), {
        unavailable: ['github.contributors.'],
        notCollected: ['scorecard.'],
      }),
    );
    expect(d.rules.map((r) => r.missing_reason)).toEqual([
      'unavailable',
      'not_collected',
      'not_reported',
      'not_reported',
    ]);
  });
});

describe('correlation groups', () => {
  const twins = [
    R({ id: 'security.local', evidence: ['x.local'], weight: 8, group: 'g' }),
    R({ id: 'security.twin', evidence: ['x.twin'], weight: 8, group: 'g' }),
    R({ id: 'security.other', evidence: ['x.other'], weight: 8 }),
  ];
  it('splits one budget between observed members', () => {
    const d = sec(
      evaluate(store(E('x.local', true), E('x.twin', false), E('x.other', true)), twins, P()),
    );
    const w = Object.fromEntries(d.rules.map((r) => [r.rule_id, r.effective_weight]));
    expect(w).toEqual({ 'security.local': 4, 'security.twin': 4, 'security.other': 8 });
    expect(d.score).toBe(75);
  });
  it('a lone observed member keeps its full weight', () => {
    const d = sec(evaluate(store(E('x.local', true), E('x.other', true)), twins, P()));
    expect(d.rules[0]!.effective_weight).toBe(8);
  });
  it('losing a twin signal does not reduce coverage when the fact is already observed', () => {
    const d = sec(evaluate(store(E('x.local', true), E('x.other', true)), twins, P()));
    expect(d.coverage).toBe(1);
  });
  it('many correlated signals cannot outvote one independent signal', () => {
    const rules = [
      ...[1, 2, 3, 4, 5].map((i) => R({ id: `security.c${i}`, evidence: [`x.c${i}`], group: 'g' })),
      R({ id: 'security.indep', evidence: ['x.i'] }),
    ];
    const s = store(...[1, 2, 3, 4, 5].map((i) => E(`x.c${i}`, true)), E('x.i', false));
    expect(sec(evaluate(s, rules, P())).score).toBe(50);
  });
});

describe('combine modes', () => {
  const ev = store(E('x.a', true), E('x.b', false));
  const mk = (combine: string) => [R({ id: 'security.m', evidence: ['x.a', 'x.b'], combine })];
  it.each([
    ['first', 10],
    ['min', 0],
    ['max', 10],
    ['mean', 5],
  ])('%s', (mode, expected) => {
    expect(sec(evaluate(ev, mk(mode), P())).rules[0]!.score).toBe(expected);
  });
  it('first falls through to the next evidence when the first is unobserved', () => {
    const r = sec(evaluate(store(E('x.b', false)), mk('first'), P())).rules[0]!;
    expect(r.evidence_ids).toEqual(['x.b']);
  });
});

describe('informational rules and profiles', () => {
  it('informational rules are shown but carry no weight', () => {
    const rules = [
      R({ id: 'security.a', evidence: ['x.a'] }),
      R({ id: 'security.i', evidence: ['x.i'], informational: true, weight: 50 }),
    ];
    const d = sec(evaluate(store(E('x.a', true), E('x.i', false)), rules, P()));
    expect(d.rules[1]!.status).toBe('informational');
    expect(d.rules[1]!.effective_weight).toBe(0);
    expect(d.score).toBe(100);
    expect(d.applicable_rules).toBe(1);
  });
  it('informational rules can still raise warnings', () => {
    const rules = [
      R({
        id: 'security.i',
        evidence: ['x.i'],
        informational: true,
        warn: { below: 5, message: 'bad {x.i}' },
      }),
    ];
    const r = evaluate(store(E('x.i', false)), rules, P());
    expect(r.warnings[0]!.message).toBe('bad false');
  });
  it('profile weight 0 disables a rule; other weights replace declared ones', () => {
    const rules = [
      R({ id: 'security.a', evidence: ['x.a'], weight: 5 }),
      R({ id: 'security.b', evidence: ['x.b'], weight: 5 }),
    ];
    const s = store(E('x.a', true), E('x.b', false));
    expect(sec(evaluate(s, rules, P())).score).toBe(50);
    const dis = sec(evaluate(s, rules, P({ rule_weights: { 'security.b': 0 } })));
    expect(dis.rules[1]!.status).toBe('disabled');
    expect(dis.score).toBe(100);
    expect(sec(evaluate(s, rules, P({ rule_weights: { 'security.b': 15 } }))).score).toBe(25);
  });
  it('dimension weights change only the overall result', () => {
    const rules = [
      R({ id: 'security.a', evidence: ['x.a'] }),
      R({ id: 'security.b', evidence: ['x.b'] }),
      R({ id: 'documentation.a', dimension: 'documentation', evidence: ['x.c'] }),
      R({ id: 'documentation.b', dimension: 'documentation', evidence: ['x.d'] }),
    ];
    const s = store(E('x.a', true), E('x.b', true), E('x.c', false), E('x.d', false));
    const only = (w: Record<string, number>) =>
      evaluate(
        s,
        rules,
        P({
          dimension_weights: {
            security: 1,
            documentation: 1,
            maintenance: 0,
            'code-quality': 0,
            'supply-chain': 0,
            community: 0,
            'semantic-clarity': 0,
            ...w,
          },
        }),
      );
    expect(only({}).overall.score).toBe(50);
    expect(only({ security: 3 }).overall.score).toBe(75);
    expect(only({}).dimensions.find((d) => d.dimension === 'security')!.score).toBe(100);
  });
});

describe('confidence model', () => {
  it('confidence = coverage x weighted evidence confidence x source reliability', () => {
    const rules = [
      R({ id: 'security.a', evidence: ['x.a'], weight: 10 }),
      R({ id: 'security.b', evidence: ['x.b'], weight: 10 }),
      R({ id: 'security.c', evidence: ['x.c'], weight: 20 }),
    ];
    const s = store(
      E('x.a', true, { source: 'github', confidence: 1 }),
      E('x.b', true, { source: 'heuristic', confidence: 0.5 }),
    );
    const d = sec(evaluate(s, rules, P()));
    // coverage 20/40 = 0.5 ; quality = (1.0*1 + 0.5*0.6)/2 = 0.65 ; confidence 0.325
    expect(d.coverage).toBe(0.5);
    expect(d.evidence_quality).toBe(0.65);
    expect(d.confidence).toBe(0.325);
  });
  it('ten weak signals do not beat two authoritative ones', () => {
    const weak = Array.from({ length: 10 }, (_, i) =>
      R({ id: `security.w${i}`, evidence: [`x.w${i}`], weight: 1 }),
    );
    const strong = [
      R({ id: 'security.s1', evidence: ['x.s1'], weight: 5 }),
      R({ id: 'security.s2', evidence: ['x.s2'], weight: 5 }),
    ];
    const weakStore = store(
      ...weak.map((_, i) => E(`x.w${i}`, true, { source: 'heuristic', confidence: 0.4 })),
    );
    const strongStore = store(E('x.s1', true), E('x.s2', true));
    expect(sec(evaluate(weakStore, weak, P())).confidence).toBeLessThan(
      sec(evaluate(strongStore, strong, P())).confidence,
    );
  });
  it('score_range brackets the score with unobserved rules at 0 and 10', () => {
    const rules = [
      R({ id: 'security.a', evidence: ['x.a'], weight: 10 }),
      R({ id: 'security.b', evidence: ['x.b'], weight: 10 }),
      R({ id: 'security.c', evidence: ['x.c'], weight: 20 }),
    ];
    const d = sec(evaluate(store(E('x.a', true), E('x.b', false)), rules, P()));
    expect(d.score).toBe(50);
    expect(d.score_range).toEqual([25, 75]);
  });
});

describe('sufficiency', () => {
  it('a single observed rule is never graded', () => {
    const d = sec(
      evaluate(
        store(E('x.a', true)),
        [
          R({ id: 'security.a', evidence: ['x.a'] }),
          R({ id: 'security.b', evidence: ['x.b'], weight: 1 }),
        ],
        P(),
      ),
    );
    expect(d.sufficiency).toBe('insufficient');
    expect(d.grade).toBe('N/A');
    expect(d.score).toBe(100);
  });
  it('low coverage is insufficient even with two rules', () => {
    const rules = [
      R({ id: 'security.a', evidence: ['x.a'], weight: 1 }),
      R({ id: 'security.b', evidence: ['x.b'], weight: 1 }),
      R({ id: 'security.c', evidence: ['x.c'], weight: 20 }),
    ];
    expect(sec(evaluate(store(E('x.a', true), E('x.b', true)), rules, P())).sufficiency).toBe(
      'insufficient',
    );
  });
  it('low confidence is flagged but graded', () => {
    const rules = [
      R({ id: 'security.a', evidence: ['x.a'] }),
      R({ id: 'security.b', evidence: ['x.b'] }),
    ];
    const d = sec(
      evaluate(
        store(E('x.a', true, { confidence: 0.3 }), E('x.b', true, { confidence: 0.3 })),
        rules,
        P(),
      ),
    );
    expect(d.sufficiency).toBe('low');
    expect(d.grade).not.toBe('N/A');
  });
  it('overall renormalises over graded dimensions and charges missing ones to confidence', () => {
    const rules = [
      R({ id: 'security.a', evidence: ['x.a'] }),
      R({ id: 'security.b', evidence: ['x.b'] }),
      R({ id: 'documentation.a', dimension: 'documentation', evidence: ['x.z'] }),
    ];
    const r = evaluate(
      store(E('x.a', true), E('x.b', true)),
      rules,
      P({
        dimension_weights: {
          security: 1,
          documentation: 1,
          maintenance: 0,
          'code-quality': 0,
          'supply-chain': 0,
          community: 0,
          'semantic-clarity': 0,
        },
      }),
    );
    expect(r.overall.score).toBe(100);
    expect(r.overall.weight_covered).toBe(0.5);
    expect(r.overall.confidence).toBe(0.5);
    expect(r.overall.sufficiency).toBe('sufficient');
  });
  it('overall is N/A when most of the weight lacks evidence', () => {
    const r = evaluate(store(), [R({ id: 'security.a', evidence: ['x.a'] })], P());
    expect(r.overall.score).toBeNull();
    expect(r.overall.grade).toBe('N/A');
  });
});

describe('scoring invariants (deterministic pseudo-random)', () => {
  function rng(seed: number): () => number {
    return () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function scenario(seed: number) {
    const rand = rng(seed);
    const n = 3 + Math.floor(rand() * 10);
    const rules: Rule[] = [];
    const evs: Evidence[] = [];
    for (let i = 0; i < n; i++) {
      const group = rand() < 0.4 ? `g${Math.floor(rand() * 3)}` : undefined;
      rules.push(
        R({
          id: `security.r${i}`,
          evidence: [`x.e${i}`],
          weight: 1 + Math.floor(rand() * 10),
          ...(group ? { group } : {}),
          informational: rand() < 0.1,
        }),
      );
      if (rand() < 0.7)
        evs.push(
          E(`x.e${i}`, rand() < 0.5, {
            confidence: 0.2 + rand() * 0.8,
            source: rand() < 0.3 ? 'heuristic' : 'github',
          }),
        );
    }
    return { rules, evs };
  }
  it('bounds: 0<=score<=100, confidence in [0,1], range brackets score', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const { rules, evs } = scenario(seed);
      const d = sec(evaluate(new EvidenceStore(evs), rules, P()));
      expect(d.confidence).toBeGreaterThanOrEqual(0);
      expect(d.confidence).toBeLessThanOrEqual(1);
      if (d.score !== null) {
        expect(d.score).toBeGreaterThanOrEqual(0);
        expect(d.score).toBeLessThanOrEqual(100);
        expect(d.score_range![0]).toBeLessThanOrEqual(d.score + 0.11);
        expect(d.score_range![1]).toBeGreaterThanOrEqual(d.score - 0.11);
      }
    }
  });
  it('rule order does not change the result', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const { rules, evs } = scenario(seed);
      const a = sec(evaluate(new EvidenceStore(evs), rules, P()));
      const b = sec(evaluate(new EvidenceStore(evs), [...rules].reverse(), P()));
      expect([b.score, b.confidence, b.coverage]).toEqual([a.score, a.confidence, a.coverage]);
    }
  });
  it('adding a rule with no evidence never changes the score', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const { rules, evs } = scenario(seed);
      const a = sec(evaluate(new EvidenceStore(evs), rules, P()));
      const b = sec(
        evaluate(
          new EvidenceStore(evs),
          [...rules, R({ id: 'security.extra', evidence: ['x.never'], weight: 50 })],
          P(),
        ),
      );
      expect(b.score).toBe(a.score);
      expect(b.confidence).toBeLessThanOrEqual(a.confidence + 1e-9);
    }
  });
  it('improving one observed boolean never lowers the score', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const { rules, evs } = scenario(seed);
      const target = evs.find((e) => e.value === false);
      if (!target) continue;
      const before = sec(evaluate(new EvidenceStore(evs), rules, P())).score;
      const improved = evs.map((e) => (e === target ? { ...e, value: true } : e));
      const after = sec(evaluate(new EvidenceStore(improved), rules, P())).score;
      if (before !== null && after !== null) expect(after).toBeGreaterThanOrEqual(before - 1e-9);
    }
  });
});

describe('grades and policy', () => {
  it.each([
    [100, 'A+'],
    [95, 'A+'],
    [94.9, 'A'],
    [90, 'A'],
    [85, 'A-'],
    [80, 'B+'],
    [75, 'B'],
    [70, 'B-'],
    [65, 'C+'],
    [60, 'C'],
    [55, 'C-'],
    [45, 'D'],
    [44.9, 'F'],
    [0, 'F'],
  ])('%s -> %s', (n, g) => expect(gradeFor(n)).toBe(g));

  it('parseMinimums validates input', () => {
    expect(parseMinimums(['security=70', 'overall=65.5'])).toEqual({ security: 70, overall: 65.5 });
    for (const bad of ['security', 'security=101', 'security=-1', 'security=abc', '=5', 'a=b=c']) {
      expect(() => parseMinimums([bad]), bad).toThrow(/invalid --min/);
    }
  });
  it('evaluatePolicy flags below-minimum and unverifiable floors, ignores unknown keys', () => {
    const rules = [
      R({ id: 'security.a', evidence: ['x.a'] }),
      R({ id: 'security.b', evidence: ['x.b'] }),
    ];
    const r = evaluate(store(E('x.a', true), E('x.b', false)), rules, P());
    const v = evaluatePolicy(r, { security: 60, documentation: 10, nonsense: 99 });
    expect(v).toEqual([
      { key: 'documentation', minimum: 10, actual: null, reason: 'insufficient_evidence' },
      { key: 'security', minimum: 60, actual: 50, reason: 'below_minimum' },
    ]);
  });
});
