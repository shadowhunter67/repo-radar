import { z } from 'zod';
import type { CodeAnalysis } from '../analysis/index.js';
import { CAPABILITIES } from '../analysis/types.js';
import type { DependencyIntel } from '../deps/model.js';
import type { TechnicalIndicator } from './indicators.js';

/**
 * Applicability engine. A rule pack (or any rule) states WHEN it is relevant as a condition over repository facts;
 * the engine evaluates it with three-valued logic (true / false / unknown) and explains the answer.
 *
 * It never answers "this law applies to you": legal applicability also depends on deployment, role, jurisdiction and
 * distribution, none of which a repository shows. A condition that needs such context lists it in `requires_context`;
 * the best possible answer is then `potentially_applicable`.
 */

export const APPLICABILITY_STATES = [
  'applicable',
  'not_applicable',
  'potentially_applicable',
  'unknown',
] as const;
export type ApplicabilityState = (typeof APPLICABILITY_STATES)[number];

const strOrList = z.union([z.string(), z.array(z.string()).min(1)]);
const Num = z.number();

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { artifact_type: string | string[] }
  | { domain: string | string[] }
  | { ecosystem: string | string[] }
  | { capability: string | string[] }
  | { dependency: { name: string; relationship?: string } }
  | { execution: { stage?: string; trigger_kind?: string; repository_code?: boolean } }
  | { distribution: string | string[] }
  | { ai: true | string | string[] }
  | { privacy: string | string[] }
  | {
      fact: {
        id: string;
        equals?: string | number | boolean;
        gt?: number;
        gte?: number;
        lt?: number;
        lte?: number;
        exists?: boolean;
      };
    }
  | { path: string }
  | { context: string };

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(ConditionSchema).min(1) }).strict(),
    z.object({ any: z.array(ConditionSchema).min(1) }).strict(),
    z.object({ not: ConditionSchema }).strict(),
    z.object({ artifact_type: strOrList }).strict(),
    z.object({ domain: strOrList }).strict(),
    z.object({ ecosystem: strOrList }).strict(),
    z.object({ capability: strOrList }).strict(),
    z
      .object({
        dependency: z
          .object({ name: z.string().max(200), relationship: z.string().optional() })
          .strict(),
      })
      .strict(),
    z
      .object({
        execution: z
          .object({
            stage: z.string().optional(),
            trigger_kind: z.string().optional(),
            repository_code: z.boolean().optional(),
          })
          .strict(),
      })
      .strict(),
    z.object({ distribution: strOrList }).strict(),
    z.object({ ai: z.union([z.literal(true), strOrList]) }).strict(),
    z.object({ privacy: strOrList }).strict(),
    z
      .object({
        fact: z
          .object({
            id: z.string(),
            equals: z.union([z.string(), Num, z.boolean()]).optional(),
            gt: Num.optional(),
            gte: Num.optional(),
            lt: Num.optional(),
            lte: Num.optional(),
            exists: z.boolean().optional(),
          })
          .strict(),
      })
      .strict(),
    z.object({ path: z.string().max(300) }).strict(),
    z.object({ context: z.string().max(100) }).strict(),
  ]),
) as z.ZodType<Condition>;

export const ApplicabilitySchema = z.object({
  state: z.enum(APPLICABILITY_STATES),
  confidence: z.number().min(0).max(1),
  /** Human-readable reasons, one per decisive leaf. */
  reasons: z.array(z.string()),
  /** Fact ids, indicator ids and files the answer rests on. */
  facts: z.array(z.string()),
  /** Context a repository cannot show (deployment, role, jurisdiction, distribution) or evidence that was missing. */
  missing_context: z.array(z.string()),
});
export type Applicability = z.infer<typeof ApplicabilitySchema>;

/** Everything a condition may look at. Built once per analysis. */
export interface ComplianceContext {
  identity: {
    artifact_type: string;
    artifact_confidence: number;
    domain: string;
    ecosystem: string[];
  };
  code: CodeAnalysis;
  intel: DependencyIntel;
  treePaths: string[];
  indicators: TechnicalIndicator[];
  /** Whether "nothing found" results are meaningful (the static scan saw enough code). */
  scanReliable: boolean;
  /** Look up an evidence or fact value by id. */
  fact(id: string): { value: unknown; confidence: number } | undefined;
  hasPrivateOnlyManifests: boolean;
  releasesPresent: boolean | undefined;
  dockerfilePresent: boolean | undefined;
}

interface Tri {
  v: boolean | null;
  conf: number;
  reasons: string[];
  facts: string[];
  missing: string[];
}
const t = (
  v: boolean | null,
  conf: number,
  reason: string,
  facts: string[] = [],
  missing: string[] = [],
): Tri => ({ v, conf, reasons: [reason], facts, missing });
const list = (x: string | string[]): string[] => (Array.isArray(x) ? x : [x]);

const MAX_MATCH_INPUT = 300;

/**
 * Compile a pack-authored pattern, refusing the ones that can backtrack catastrophically. Patterns come from pack files
 * (reviewed data), but they are matched against repository-controlled text, so a careless pack must not be able to hang
 * the analyzer: nested quantifiers such as `(a+)+` or `(.*)*` and very long patterns are rejected.
 */
export function safeRegExp(source: string): RegExp | undefined {
  if (source.length > 300) return undefined;
  // a quantified group that itself contains a quantifier, or alternation inside a quantified group with a quantifier
  if (/\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*[+*{]/.test(source)) return undefined;
  if (
    /\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)\s*[+*{]/.test(source) &&
    /[+*]/.test(source.replace(/\)\s*[+*{]/, ''))
  )
    return undefined;
  try {
    return new RegExp(source, 'i');
  } catch {
    return undefined;
  }
}

function evalLeaf(c: Condition, ctx: ComplianceContext): Tri {
  if ('artifact_type' in c) {
    const want = list(c.artifact_type);
    const have = ctx.identity.artifact_type;
    if (have === 'unknown')
      return t(null, 0.2, 'artifact type is unknown', ['artifact.type'], ['artifact type']);
    return t(
      want.includes(have),
      ctx.identity.artifact_confidence,
      `artifact type is ${have} (wanted ${want.join('|')})`,
      ['artifact.type'],
    );
  }
  if ('domain' in c) {
    const want = list(c.domain);
    const have = ctx.identity.domain;
    if (have === 'unknown') return t(null, 0.2, 'domain is unknown', [], ['domain']);
    return t(want.includes(have), 0.6, `domain is ${have} (wanted ${want.join('|')})`);
  }
  if ('ecosystem' in c) {
    const have = ctx.identity.ecosystem.map((e) => e.toLowerCase());
    if (have.length === 0) return t(null, 0.2, 'no ecosystem detected', [], ['ecosystem']);
    const hit = list(c.ecosystem).some((w) => have.some((h) => h.includes(w.toLowerCase())));
    return t(hit, 0.9, `ecosystems: ${have.join(', ')}`);
  }
  if ('capability' in c) {
    const want = list(c.capability).filter((w) => (CAPABILITIES as readonly string[]).includes(w));
    const hits = ctx.code.capabilities.summary.filter(
      (s) => want.includes(s.capability) && s.observed && s.mode !== 'POSSIBLE',
    );
    if (hits.length > 0)
      return t(
        true,
        Math.max(...hits.map((h) => h.confidence)),
        `capability observed: ${hits.map((h) => h.capability).join(', ')}`,
        hits.map((h) => `capability.${h.capability.toLowerCase()}.observed`),
      );
    if (!ctx.code.scan.performed || !ctx.scanReliable)
      return t(
        null,
        0.3,
        'capability not observed, but the scan was not broad enough to rely on that',
        [],
        ['broader code scan'],
      );
    return t(false, 0.6, `capability not observed in the scanned sample: ${want.join(', ')}`);
  }
  if ('dependency' in c) {
    const re = safeRegExp(c.dependency.name);
    if (!re) return t(null, 0, 'invalid or unsafe dependency pattern');
    const hits = ctx.intel.dependencies.filter(
      (d) =>
        re.test(d.package.name.slice(0, MAX_MATCH_INPUT)) &&
        (!c.dependency.relationship || d.relationship === c.dependency.relationship),
    );
    if (hits.length > 0)
      return t(
        true,
        0.9,
        `dependency present: ${hits
          .slice(0, 3)
          .map((h) => h.package.name)
          .join(', ')}`,
        hits.slice(0, 3).map((h) => h.id),
      );
    if (ctx.intel.summary.discovered === 0)
      return t(null, 0.3, 'no dependencies were discovered', [], ['dependency manifests']);
    return t(false, 0.7, `no dependency matches ${c.dependency.name}`);
  }
  if ('execution' in c) {
    const e = c.execution;
    const hooks = ctx.code.execution.hooks.filter(
      (h) =>
        (e.stage ? h.stage === e.stage : true) &&
        (e.trigger_kind ? h.trigger_kind === e.trigger_kind : true),
    );
    const projectCode =
      e.repository_code === undefined
        ? undefined
        : ctx.code.execution.projects.some((p) => p.repository_code_runs) === e.repository_code;
    const v =
      e.repository_code !== undefined && !e.stage && !e.trigger_kind
        ? projectCode === true
        : hooks.length > 0 && projectCode !== false;
    return t(
      v,
      0.8,
      `execution model: ${hooks.length} matching hook(s)`,
      hooks.slice(0, 3).map((h) => h.id),
    );
  }
  if ('distribution' in c) {
    const want = list(c.distribution);
    const parts: Tri[] = [];
    for (const w of want) {
      if (w === 'published_package')
        parts.push(
          ctx.hasPrivateOnlyManifests
            ? t(false, 0.7, 'only private packages are declared')
            : ctx.intel.summary.discovered + ctx.identity.ecosystem.length === 0
              ? t(null, 0.3, 'no package manifest', [], ['distribution channel'])
              : t(true, 0.5, 'a non-private package manifest exists (publication not verified)'),
        );
      else if (w === 'container_image')
        parts.push(
          ctx.dockerfilePresent === undefined
            ? t(null, 0.3, 'Dockerfile presence unknown')
            : t(
                ctx.dockerfilePresent,
                0.7,
                ctx.dockerfilePresent ? 'a Dockerfile exists' : 'no Dockerfile',
              ),
        );
      else if (w === 'release_assets')
        parts.push(
          ctx.releasesPresent === undefined
            ? t(null, 0.3, 'releases unknown')
            : t(ctx.releasesPresent, 0.7, ctx.releasesPresent ? 'releases exist' : 'no releases'),
        );
      else parts.push(t(null, 0.2, `unknown distribution kind ${w}`, [], ['distribution']));
    }
    return (
      parts.find((p) => p.v === true) ??
      parts.find((p) => p.v === null) ??
      parts[0] ??
      t(null, 0, 'no distribution given')
    );
  }
  if ('ai' in c) {
    const cats = c.ai === true ? undefined : list(c.ai);
    const hits = ctx.indicators.filter(
      (i) => i.family === 'ai' && (!cats || cats.includes(i.category)),
    );
    if (hits.length > 0)
      return t(
        true,
        Math.max(...hits.map((h) => h.confidence)),
        `AI indicators: ${[...new Set(hits.map((h) => h.category))].join(', ')}`,
        hits.slice(0, 5).map((h) => h.id),
      );
    if (!ctx.scanReliable)
      return t(
        null,
        0.3,
        'no AI indicator observed, but the scan was not broad enough to rely on that',
        [],
        ['broader code scan'],
      );
    return t(false, 0.6, 'no AI/ML indicator found');
  }
  if ('privacy' in c) {
    const hits = ctx.indicators.filter(
      (i) => i.family === 'privacy' && list(c.privacy).includes(i.category),
    );
    if (hits.length > 0)
      return t(
        true,
        Math.max(...hits.map((h) => h.confidence)),
        `privacy indicator: ${[...new Set(hits.map((h) => h.category))].join(', ')}`,
        hits.slice(0, 5).map((h) => h.id),
      );
    if (!ctx.scanReliable)
      return t(
        null,
        0.3,
        'not observed, but the scan was not broad enough to rely on that',
        [],
        ['broader code scan'],
      );
    return t(false, 0.55, 'privacy indicator not found');
  }
  if ('fact' in c) {
    const f = ctx.fact(c.fact.id);
    if (!f) return t(null, 0, `fact ${c.fact.id} is not available`, [], [c.fact.id]);
    const v = f.value;
    let ok = true;
    if (c.fact.exists !== undefined) ok = c.fact.exists;
    if (c.fact.equals !== undefined) ok = ok && v === c.fact.equals;
    if (typeof v === 'number') {
      if (c.fact.gt !== undefined) ok = ok && v > c.fact.gt;
      if (c.fact.gte !== undefined) ok = ok && v >= c.fact.gte;
      if (c.fact.lt !== undefined) ok = ok && v < c.fact.lt;
      if (c.fact.lte !== undefined) ok = ok && v <= c.fact.lte;
    } else if (
      c.fact.gt !== undefined ||
      c.fact.gte !== undefined ||
      c.fact.lt !== undefined ||
      c.fact.lte !== undefined
    )
      ok = false;
    return t(ok, f.confidence, `${c.fact.id} = ${JSON.stringify(v)}`, [c.fact.id]);
  }
  if ('path' in c) {
    const re = safeRegExp(c.path);
    if (!re) return t(null, 0, 'invalid or unsafe path pattern');
    // Paths are repository-controlled: bound their length before matching.
    const hit = ctx.treePaths.find((p) =>
      re.test(p.length > MAX_MATCH_INPUT ? p.slice(0, MAX_MATCH_INPUT) : p),
    );
    if (hit) return t(true, 0.9, `file present: ${hit.slice(0, 80)}`, [hit]);
    return t(false, 0.7, `no file matches ${c.path}`);
  }
  if ('context' in c)
    return t(null, 0, `needs context the repository cannot show: ${c.context}`, [], [c.context]);
  return t(null, 0, 'unsupported condition');
}

function evalCondition(c: Condition, ctx: ComplianceContext): Tri {
  if ('all' in c) {
    const rs = c.all.map((x) => evalCondition(x, ctx));
    const merged = merge(rs);
    const f = rs.find((r) => r.v === false);
    if (f) return { ...merged, v: false, conf: f.conf };
    if (rs.some((r) => r.v === null))
      return { ...merged, v: null, conf: Math.min(...rs.map((r) => r.conf)) };
    return { ...merged, v: true, conf: Math.min(...rs.map((r) => r.conf)) };
  }
  if ('any' in c) {
    const rs = c.any.map((x) => evalCondition(x, ctx));
    const merged = merge(rs);
    const tr = rs.filter((r) => r.v === true);
    if (tr.length > 0) return { ...merged, v: true, conf: Math.max(...tr.map((r) => r.conf)) };
    if (rs.some((r) => r.v === null))
      return { ...merged, v: null, conf: Math.min(...rs.map((r) => r.conf)) };
    return { ...merged, v: false, conf: Math.min(...rs.map((r) => r.conf)) };
  }
  if ('not' in c) {
    const r = evalCondition(c.not, ctx);
    return { ...r, v: r.v === null ? null : !r.v, reasons: r.reasons.map((x) => `not (${x})`) };
  }
  return evalLeaf(c, ctx);
}

function merge(rs: Tri[]): Omit<Tri, 'v' | 'conf'> {
  return {
    reasons: rs.flatMap((r) => r.reasons).slice(0, 12),
    facts: [...new Set(rs.flatMap((r) => r.facts))].slice(0, 20),
    missing: [...new Set(rs.flatMap((r) => r.missing))],
  };
}

/** Public evaluation: maps the three-valued answer onto the four reported states. */
export function evaluateApplicability(
  condition: Condition | undefined,
  ctx: ComplianceContext,
  requiresContext: string[] = [],
): Applicability {
  const r = condition
    ? evalCondition(condition, ctx)
    : t(true, 0.5, 'no condition: relevant by default');
  const missing = [...new Set([...r.missing, ...requiresContext])];
  let state: ApplicabilityState;
  if (r.v === false) state = 'not_applicable';
  else if (r.v === null) state = 'unknown';
  else if (requiresContext.length > 0 || r.conf < 0.6) state = 'potentially_applicable';
  else state = 'applicable';
  return {
    state,
    confidence: Math.round(Math.max(0, Math.min(1, r.conf)) * 100) / 100,
    reasons: r.reasons.slice(0, 12),
    facts: r.facts.slice(0, 20),
    missing_context: missing,
  };
}

/** Evaluate a condition to its raw three-valued answer (used by indicator rules). */
export function evaluateCondition(
  condition: Condition,
  ctx: ComplianceContext,
): {
  value: boolean | null;
  confidence: number;
  facts: string[];
  missing: string[];
  reasons: string[];
} {
  const r = evalCondition(condition, ctx);
  return { value: r.v, confidence: r.conf, facts: r.facts, missing: r.missing, reasons: r.reasons };
}
