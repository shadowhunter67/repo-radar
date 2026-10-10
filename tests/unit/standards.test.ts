import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeRepository } from '../../src/analyze.js';
import {
  listProfiles,
  parseProfile,
  validateProfileAgainstRules,
} from '../../src/profiles/load.js';
import { buildJsonSchemas } from '../../src/schemas.js';
import { buildRuleSet, loadRuleSet, parseRuleFile } from '../../src/scoring/rules.js';
import { DIMENSIONS } from '../../src/scoring/types.js';
import { packageRoot } from '../../src/util/paths.js';
import { fakeFetch, fixedClock } from '../helpers/fake-github.js';
import { goodRepo } from '../helpers/scenarios.js';

const rs = loadRuleSet();

describe('shipped standards', () => {
  it('load, validate and have unique ids', () => {
    expect(rs.rules.length).toBeGreaterThanOrEqual(60);
    expect(new Set(rs.rules.map((r) => r.id)).size).toBe(rs.rules.length);
    expect(rs.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('every dimension has enough scored rules and at least one rationale each', () => {
    for (const d of DIMENSIONS) {
      const own = rs.rules.filter((r) => r.dimension === d);
      expect(own.filter((r) => !r.informational).length, d).toBeGreaterThanOrEqual(5);
      for (const r of own) expect(r.rationale.length, r.id).toBeGreaterThan(20);
    }
  });

  it('informational rules have weight 0, scored rules have weight > 0', () => {
    for (const r of rs.rules) {
      if (r.informational) expect(r.weight, r.id).toBe(0);
      else expect(r.weight, r.id).toBeGreaterThan(0);
    }
  });

  it('every correlation group has at least two members (otherwise it does nothing)', () => {
    const groups = new Map<string, number>();
    for (const r of rs.rules)
      if (r.group)
        groups.set(`${r.dimension}/${r.group}`, (groups.get(`${r.dimension}/${r.group}`) ?? 0) + 1);
    for (const [g, n] of groups) expect(n, g).toBeGreaterThanOrEqual(2);
  });

  it('never penalise a repository name: no scored rule reads the name or its divergence', () => {
    for (const r of rs.rules.filter((x) => !x.informational)) {
      for (const e of r.evidence)
        expect(e, r.id).not.toMatch(/name_purpose_divergence|name_normalization/);
    }
  });

  it('never use stars/forks (popularity) as quality evidence', () => {
    for (const r of rs.rules)
      for (const e of [...r.evidence, r.applies_when?.evidence ?? ''])
        expect(e, r.id).not.toMatch(/\.(stars|forks)$/);
  });

  it('every evidence id a rule reads is actually produced by the collectors (guards against typos)', async () => {
    const spec = goodRepo();
    const report = await analyzeRepository('acme/widget', {
      fetch: fakeFetch(spec),
      clock: fixedClock,
    });
    const produced = new Set([
      ...report.evidence.map((e) => e.id),
      ...report.facts.map((f) => f.id),
    ]);
    const missing: string[] = [];
    for (const r of rs.rules) {
      for (const id of [...r.evidence, ...(r.applies_when ? [r.applies_when.evidence] : [])]) {
        if (!produced.has(id)) missing.push(`${r.id} -> ${id}`);
      }
      for (const m of r.warn?.message.matchAll(/\{([a-z0-9_.-]+)\}/g) ?? []) {
        if (!produced.has(m[1] as string)) missing.push(`${r.id} warn -> ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('digest changes when any rule changes and is stable otherwise', () => {
    const a = buildRuleSet(rs.rules);
    expect(a.digest).toBe(rs.digest);
    const changed = rs.rules.map((r, i) => (i === 0 ? { ...r, weight: r.weight + 1 } : r));
    expect(buildRuleSet(changed).digest).not.toBe(rs.digest);
    expect(buildRuleSet([...rs.rules].reverse()).digest).toBe(rs.digest);
  });

  it('rejects malformed rule files', () => {
    const ok = `methodology: '0.2'\nrules:\n  - id: security.x\n    dimension: security\n    title: "t t"\n    rationale: "long enough rationale"\n    evidence: [a.b]\n    weight: 1\n    scoring: {type: map, values: {'true': 1}}\n`;
    expect(parseRuleFile(ok, 'x')).toHaveLength(1);
    expect(() => parseRuleFile(ok.replace("'0.2'", "'9.9'"), 'x')).toThrow(/methodology/);
    expect(() => parseRuleFile(ok.replace('security.x', 'community.x'), 'x')).toThrow();
    expect(() => parseRuleFile(ok.replace('weight: 1', 'weight: -1'), 'x')).toThrow();
    expect(() => parseRuleFile(ok.replace("{'true': 1}", "{'true': 11}"), 'x')).toThrow();
    expect(() => parseRuleFile(ok.replace('evidence: [a.b]', 'evidence: [Bad Id]'), 'x')).toThrow();
    expect(() => buildRuleSet([...parseRuleFile(ok, 'x'), ...parseRuleFile(ok, 'x')])).toThrow(
      /duplicate/,
    );
  });

  it('YAML with custom tags or alias bombs in rule files is rejected, not executed', () => {
    expect(() =>
      parseRuleFile('methodology: !!js/function "function(){}"\nrules: []', 'x'),
    ).toThrow();
    const bomb =
      'a: &a [1,1,1,1]\n' +
      Array.from(
        { length: 14 },
        (_, i) =>
          `k${i}: &k${i} [${Array(10)
            .fill(i === 0 ? '*a' : `*k${i - 1}`)
            .join(',')}]`,
      ).join('\n');
    expect(() => parseRuleFile(bomb, 'x')).toThrow();
  });
});

describe('profiles', () => {
  const profiles = listProfiles();
  it('ships default, startup and enterprise', () => {
    expect(profiles.map((p) => p.id).sort()).toEqual(['default', 'enterprise', 'startup']);
  });
  it('only reference real rules and dimensions', () => {
    for (const p of profiles) {
      expect(() => validateProfileAgainstRules(p, rs.rules)).not.toThrow();
      for (const k of Object.keys(p.minimums)) expect([...DIMENSIONS, 'overall']).toContain(k);
    }
  });
  it('typos in rule_weights fail loudly', () => {
    const p = parseProfile(
      "id: t\nversion: '1'\ntitle: t\ndescription: d\nrule_weights:\n  security.nope: 3\n",
    );
    expect(() => validateProfileAgainstRules(p, rs.rules)).toThrow(/unknown rule/);
  });
  it('rejects bad dimension names and out-of-range weights', () => {
    expect(() =>
      parseProfile(
        "id: t\nversion: '1'\ntitle: t\ndescription: d\ndimension_weights:\n  speed: 1\n",
      ),
    ).toThrow();
    expect(() =>
      parseProfile("id: t\nversion: '1'\ntitle: t\ndescription: d\nminimums:\n  security: 140\n"),
    ).toThrow();
  });
  it('enterprise is stricter than default on supply chain', () => {
    const d = profiles.find((p) => p.id === 'default')!;
    const e = profiles.find((p) => p.id === 'enterprise')!;
    expect(e.dimension_weights['supply-chain']!).toBeGreaterThan(
      d.dimension_weights['supply-chain']!,
    );
    expect(Object.keys(e.minimums).length).toBeGreaterThan(Object.keys(d.minimums).length);
  });
});

describe('published JSON schemas', () => {
  it('schemas/*.json are in sync with the zod definitions (run `npm run schemas`)', () => {
    for (const [name, schema] of Object.entries(buildJsonSchemas())) {
      const onDisk = readFileSync(join(packageRoot(), 'schemas', name), 'utf8');
      expect(onDisk, name).toBe(JSON.stringify(schema, null, 2) + '\n');
    }
  });
});
