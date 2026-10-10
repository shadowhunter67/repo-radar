import type { EvidenceStore } from '../evidence/store.js';
import { SOURCE_RELIABILITY, type Evidence } from '../evidence/types.js';
import { round } from '../util/text.js';
import { gradeFor } from './grade.js';
import {
  DIMENSIONS,
  DIMENSION_LABELS,
  type Condition,
  type Dimension,
  type Profile,
  type Rule,
  type Scoring,
} from './types.js';

export type RuleStatus =
  'scored' | 'not_observed' | 'not_applicable' | 'informational' | 'disabled';
export type Sufficiency = 'sufficient' | 'low' | 'insufficient';

/** Below this share of applicable rule weight being observed, a dimension is not graded. */
export const MIN_COVERAGE = 0.3;
export const MIN_SCORED_RULES = 2;
export const LOW_CONFIDENCE = 0.5;

export interface RuleResult {
  rule_id: string;
  title: string;
  status: RuleStatus;
  /** 0-10, or null when the rule was not scored. */
  score: number | null;
  max_score: 10;
  declared_weight: number;
  profile_weight: number;
  /** Weight actually used after correlation-group budgeting. */
  effective_weight: number;
  /** Points this rule added to the dimension score (0-100 scale). */
  contribution: number | null;
  group: string | null;
  inputs: {
    evidence_id: string;
    value: Evidence['value'];
    confidence: number;
    source: string;
    kind: string;
  }[];
  evidence_ids: string[];
  /** Evidence confidence x source reliability for the evidence actually used. */
  confidence: number | null;
  /**
   * Why a rule has no score: `unavailable` (a collector failed or was rate limited),
   * `not_collected` (source disabled by the user), `not_reported` (source answered, signal absent).
   */
  missing_reason: 'unavailable' | 'not_collected' | 'not_reported' | null;
  explanation: string;
}

/** Evidence-id prefixes whose collection failed / was skipped, so a missing signal can be explained. */
export interface ScoringContext {
  unavailable?: string[];
  notCollected?: string[];
}

export interface DimensionResult {
  dimension: Dimension;
  label: string;
  score: number | null;
  /** [pessimistic, optimistic]: the score if every unobserved rule had scored 0 / 10. */
  score_range: [number, number] | null;
  grade: string;
  confidence: number;
  coverage: number;
  evidence_quality: number;
  sufficiency: Sufficiency;
  scored_rules: number;
  applicable_rules: number;
  rules: RuleResult[];
}

export interface OverallResult {
  score: number | null;
  grade: string;
  confidence: number;
  sufficiency: Sufficiency;
  /** Share of total dimension weight that contributed to the score. */
  weight_covered: number;
  dimension_weights: Record<string, number>;
}

export interface Warning {
  rule_id: string | null;
  dimension: Dimension | null;
  message: string;
  evidence_ids: string[];
}

export interface ScoringResult {
  dimensions: DimensionResult[];
  overall: OverallResult;
  warnings: Warning[];
}

export function scoreValue(value: Evidence['value'], scoring: Scoring): number | undefined {
  const v = Array.isArray(value) ? value.length : value;
  switch (scoring.type) {
    case 'map': {
      const hit = scoring.values[String(v)];
      return hit ?? scoring.default;
    }
    case 'thresholds': {
      if (typeof v !== 'number') return undefined;
      const steps = [...scoring.steps].sort((a, b) => b.gte - a.gte);
      for (const s of steps) if (v >= s.gte) return s.score;
      return scoring.otherwise;
    }
    case 'linear': {
      if (typeof v !== 'number' || scoring.max === scoring.min) return undefined;
      const t = Math.max(0, Math.min(1, (v - scoring.min) / (scoring.max - scoring.min)));
      return 10 * (scoring.invert ? 1 - t : t);
    }
  }
}

export function conditionHolds(c: Condition, value: Evidence['value']): boolean {
  if (c.equals !== undefined) return value === c.equals;
  const n = Array.isArray(value) ? value.length : typeof value === 'number' ? value : NaN;
  if (Number.isNaN(n)) return false;
  if (c.gt !== undefined) return n > c.gt;
  if (c.gte !== undefined) return n >= c.gte;
  if (c.lt !== undefined) return n < c.lt;
  if (c.lte !== undefined) return n <= c.lte;
  return false;
}

const effConfidence = (e: Evidence): number => e.confidence * SOURCE_RELIABILITY[e.source];

function evaluateRule(
  rule: Rule,
  store: EvidenceStore,
  profile: Profile,
  ctx: ScoringContext,
): RuleResult {
  const declared = rule.weight;
  const pw = profile.rule_weights[rule.id] ?? declared;
  const base: RuleResult = {
    rule_id: rule.id,
    title: rule.title,
    status: 'not_observed',
    score: null,
    max_score: 10,
    declared_weight: declared,
    profile_weight: pw,
    effective_weight: 0,
    contribution: null,
    group: rule.group ?? null,
    inputs: [],
    evidence_ids: [],
    confidence: null,
    missing_reason: null,
    explanation: '',
  };

  if (!rule.informational && pw === 0) {
    return { ...base, status: 'disabled', explanation: 'disabled by profile (weight 0)' };
  }
  if (rule.applies_when) {
    const ev = store.get(rule.applies_when.evidence);
    if (ev && !conditionHolds(rule.applies_when, ev.value)) {
      return {
        ...base,
        status: 'not_applicable',
        explanation: `not applicable: ${ev.id}=${JSON.stringify(ev.value)} does not satisfy the rule's applies_when`,
      };
    }
  }

  const used: { ev: Evidence; score: number }[] = [];
  for (const id of rule.evidence) {
    const ev = store.get(id);
    if (!ev) continue;
    const s = scoreValue(ev.value, rule.scoring);
    if (s === undefined) continue;
    used.push({ ev, score: s });
    if (rule.combine === 'first') break;
  }
  if (used.length === 0) {
    const matches = (prefixes: string[] | undefined): boolean =>
      !!prefixes?.some((p) => rule.evidence.some((id) => id.startsWith(p)));
    const reason = matches(ctx.unavailable)
      ? 'unavailable'
      : matches(ctx.notCollected)
        ? 'not_collected'
        : 'not_reported';
    return {
      ...base,
      status: rule.informational ? 'informational' : 'not_observed',
      missing_reason: reason,
      explanation: `no usable evidence (${reason.replace('_', ' ')}; looked for: ${rule.evidence.join(', ')})`,
    };
  }

  const score =
    rule.combine === 'min'
      ? Math.min(...used.map((u) => u.score))
      : rule.combine === 'max'
        ? Math.max(...used.map((u) => u.score))
        : rule.combine === 'mean'
          ? used.reduce((a, u) => a + u.score, 0) / used.length
          : (used[0] as { score: number }).score;
  const conf = used.reduce((a, u) => a + effConfidence(u.ev), 0) / used.length;
  const inputs = used.map(({ ev }) => ({
    evidence_id: ev.id,
    value: ev.value,
    confidence: round(ev.confidence, 3),
    source: ev.source,
    kind: ev.kind,
  }));
  const how = used
    .map((u) => `${u.ev.id}=${JSON.stringify(u.ev.value)} -> ${round(u.score, 2)}`)
    .join('; ');
  return {
    ...base,
    status: rule.informational ? 'informational' : 'scored',
    score: round(score, 2),
    inputs,
    evidence_ids: used.map((u) => u.ev.id),
    confidence: round(conf, 3),
    explanation: `${how} (${rule.scoring.type}${rule.combine !== 'first' ? `, combine=${rule.combine}` : ''})`,
  };
}

function aggregateDimension(
  dim: Dimension,
  rules: Rule[],
  store: EvidenceStore,
  profile: Profile,
  ctx: ScoringContext,
): DimensionResult {
  const results = rules.map((r) => evaluateRule(r, store, profile, ctx));

  // Correlation budgeting: signals in one group share the weight of their heaviest member.
  const byGroup = new Map<string, RuleResult[]>();
  for (const r of results) {
    if (r.status === 'scored' && r.group)
      byGroup.set(r.group, [...(byGroup.get(r.group) ?? []), r]);
  }
  for (const r of results) {
    if (r.status !== 'scored') continue;
    let scale = 1;
    if (r.group) {
      const g = byGroup.get(r.group) as RuleResult[];
      const sum = g.reduce((a, x) => a + x.profile_weight, 0);
      const max = Math.max(...g.map((x) => x.profile_weight));
      scale = sum > max ? max / sum : 1;
    }
    r.effective_weight = round(r.profile_weight * scale, 4);
  }

  const scored = results.filter((r) => r.status === 'scored');
  const applicable = results.filter((r) => r.status === 'scored' || r.status === 'not_observed');
  // Coverage counts a correlation group once (its heaviest member): losing a "twin" signal
  // (e.g. Scorecard's version of a fact we already observed locally) must not lower coverage.
  const unitWeight = (rs: RuleResult[]): number => {
    const ungrouped = rs.filter((r) => !r.group).reduce((a, r) => a + r.profile_weight, 0);
    const groups = new Map<string, number>();
    for (const r of rs) {
      if (r.group) groups.set(r.group, Math.max(groups.get(r.group) ?? 0, r.profile_weight));
    }
    return ungrouped + [...groups.values()].reduce((a, w) => a + w, 0);
  };
  const applicableWeight = unitWeight(applicable);
  const scoredWeight = unitWeight(scored);
  const coverage = applicableWeight > 0 ? Math.min(1, scoredWeight / applicableWeight) : 0;
  const effSum = scored.reduce((a, r) => a + r.effective_weight, 0);
  // Weight that is still unobserved, with the same group budgeting, for the pessimistic/optimistic range.
  const scoredGroups = new Set(scored.map((r) => r.group).filter((g): g is string => !!g));
  const unobserved = applicable.filter(
    (r) => r.status === 'not_observed' && !(r.group && scoredGroups.has(r.group)),
  );
  const unobservedWeight = unitWeight(unobserved);

  let score: number | null = null;
  let quality = 0;
  if (effSum > 0) {
    score =
      (scored.reduce((a, r) => a + r.effective_weight * (r.score as number), 0) / effSum) * 10;
    quality =
      scored.reduce((a, r) => a + r.effective_weight * (r.confidence as number), 0) / effSum;
    for (const r of scored)
      r.contribution = round((r.effective_weight * (r.score as number) * 10) / effSum, 2);
  }
  const confidence = coverage * quality;
  let scoreRange: [number, number] | null = null;
  if (effSum > 0) {
    const weighted = scored.reduce((a, r) => a + r.effective_weight * (r.score as number), 0);
    const denom = effSum + unobservedWeight;
    scoreRange = [
      round((weighted / denom) * 10, 1),
      round(((weighted + 10 * unobservedWeight) / denom) * 10, 1),
    ];
  }
  let sufficiency: Sufficiency = 'sufficient';
  if (score === null || scored.length < MIN_SCORED_RULES || coverage < MIN_COVERAGE)
    sufficiency = 'insufficient';
  else if (confidence < LOW_CONFIDENCE) sufficiency = 'low';

  return {
    dimension: dim,
    label: DIMENSION_LABELS[dim],
    score: score === null ? null : round(score, 1),
    score_range: scoreRange,
    grade: score === null || sufficiency === 'insufficient' ? 'N/A' : gradeFor(score),
    confidence: round(confidence, 3),
    coverage: round(coverage, 3),
    evidence_quality: round(quality, 3),
    sufficiency,
    scored_rules: scored.length,
    applicable_rules: applicable.length,
    rules: results,
  };
}

export function evaluate(
  store: EvidenceStore,
  rules: Rule[],
  profile: Profile,
  ctx: ScoringContext = {},
): ScoringResult {
  const dimensions = DIMENSIONS.map((d) =>
    aggregateDimension(
      d,
      rules.filter((r) => r.dimension === d),
      store,
      profile,
      ctx,
    ),
  );

  const weights: Record<string, number> = {};
  for (const d of DIMENSIONS) weights[d] = profile.dimension_weights[d] ?? 1;
  const totalW = Object.values(weights).reduce((a, b) => a + b, 0);
  const contributing = dimensions.filter(
    (d) => d.sufficiency !== 'insufficient' && d.score !== null,
  );
  const contribW = contributing.reduce((a, d) => a + (weights[d.dimension] as number), 0);
  const weightCovered = totalW > 0 ? contribW / totalW : 0;
  const overallScore =
    contribW > 0
      ? contributing.reduce(
          (a, d) => a + (weights[d.dimension] as number) * (d.score as number),
          0,
        ) / contribW
      : null;
  const overallConf =
    totalW > 0
      ? dimensions.reduce((a, d) => a + (weights[d.dimension] as number) * d.confidence, 0) / totalW
      : 0;
  let sufficiency: Sufficiency = 'sufficient';
  if (overallScore === null || weightCovered < 0.5) sufficiency = 'insufficient';
  else if (overallConf < LOW_CONFIDENCE) sufficiency = 'low';

  const warnings: Warning[] = [];
  const ruleById = new Map(rules.map((r) => [r.id, r]));
  for (const d of dimensions) {
    for (const r of d.rules) {
      const def = ruleById.get(r.rule_id);
      if (
        def?.warn &&
        (r.status === 'scored' || r.status === 'informational') &&
        r.score !== null &&
        r.score < def.warn.below
      ) {
        const message = def.warn.message.replace(/\{([a-z0-9_.-]+)\}/g, (_m, id: string) => {
          const v = store.get(id)?.value;
          return v === undefined ? '?' : Array.isArray(v) ? String(v.length) : String(v);
        });
        warnings.push({
          rule_id: r.rule_id,
          dimension: d.dimension,
          message,
          evidence_ids: r.evidence_ids,
        });
      }
    }
    if (d.sufficiency === 'insufficient') {
      warnings.push({
        rule_id: null,
        dimension: d.dimension,
        message: `Insufficient evidence to grade ${d.label} (${d.scored_rules} rule(s) observed, ${Math.round(d.coverage * 100)}% coverage).`,
        evidence_ids: [],
      });
    }
  }

  return {
    dimensions,
    overall: {
      score: overallScore === null ? null : round(overallScore, 1),
      grade:
        overallScore === null || sufficiency === 'insufficient' ? 'N/A' : gradeFor(overallScore),
      confidence: round(overallConf, 3),
      sufficiency,
      weight_covered: round(weightCovered, 3),
      dimension_weights: weights,
    },
    warnings,
  };
}
