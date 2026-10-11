import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { packageRoot } from '../util/paths.js';
import {
  ApplicabilitySchema,
  ConditionSchema,
  evaluateApplicability,
  evaluateCondition,
  safeRegExp,
  type ComplianceContext,
  type Condition,
} from './applicability.js';
import { INDICATOR_STATUSES, LEGAL_DETERMINATION, LEGAL_DISCLAIMER } from './disclaimer.js';
import { TechnicalIndicatorSchema } from './indicators.js';

/**
 * Versioned regulatory/readiness rule packs. A pack is DATA (standards/regulatory/<id>.yaml): when it is relevant, and
 * which technical indicators to look for. Nothing about any law is hard-coded in the engine, and no pack output is a
 * legal conclusion.
 */
export const PackIndicatorSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9.-]{2,60}$/),
    title: z.string().min(5).max(200),
    /** Indicative pointer into the instrument; a reading aid, not a legal mapping. */
    reference: z.string().min(3).max(300),
    rationale: z.string().min(10).max(600),
    observed_when: ConditionSchema,
    partial_when: ConditionSchema.optional(),
    limitations: z.string().max(600).default(''),
  })
  .strict();

export const PackSchema = z
  .object({
    pack: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    title: z.string().min(5).max(200),
    jurisdiction: z.string().max(60),
    /** The instrument this pack is inspired by (informational). */
    instrument: z.string().max(300),
    /** `indicative` always: the pack is a technical checklist, not an interpretation of the text. */
    status: z.literal('indicative'),
    methodology: z.string(),
    /** Context a repository cannot show but that decides legal applicability. */
    requires_context: z.array(z.string().max(200)).min(1),
    applies_when: ConditionSchema,
    indicators: z.array(PackIndicatorSchema).min(1).max(40),
  })
  .strict();
export type Pack = z.infer<typeof PackSchema>;

export interface LoadedPack {
  pack: Pack;
  digest: string;
  file: string;
}

/** Every regex in a pack must be safe to run against repository-controlled text. */
function assertSafePatterns(c: Condition, where: string): void {
  if ('all' in c) for (const x of c.all) assertSafePatterns(x, where);
  else if ('any' in c) for (const x of c.any) assertSafePatterns(x, where);
  else if ('not' in c) assertSafePatterns(c.not, where);
  else if ('path' in c && !safeRegExp(c.path))
    throw new Error(`${where}: unsafe or invalid path pattern ${c.path}`);
  else if ('dependency' in c && !safeRegExp(c.dependency.name))
    throw new Error(`${where}: unsafe or invalid dependency pattern ${c.dependency.name}`);
}

export function loadPacks(root: string = packageRoot(), methodology?: string): LoadedPack[] {
  const dir = join(root, 'standards', 'regulatory');
  let files: string[] = [];
  try {
    files = readdirSync(dir)
      .filter((f) => /\.ya?ml$/.test(f))
      .sort();
  } catch {
    return [];
  }
  const out: LoadedPack[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8');
    const parsed = PackSchema.parse(parseYaml(text, { schema: 'core', maxAliasCount: 10 }));
    if (methodology && parsed.methodology !== methodology)
      throw new Error(`${f}: pack methodology ${parsed.methodology} != engine ${methodology}`);
    if (seen.has(parsed.pack)) throw new Error(`${f}: duplicate pack id ${parsed.pack}`);
    seen.add(parsed.pack);
    assertSafePatterns(parsed.applies_when, `${f} applies_when`);
    for (const i of parsed.indicators) {
      assertSafePatterns(i.observed_when, `${f} ${i.id}`);
      if (i.partial_when) assertSafePatterns(i.partial_when, `${f} ${i.id}`);
    }
    const ids = new Set<string>();
    for (const i of parsed.indicators) {
      if (ids.has(i.id)) throw new Error(`${f}: duplicate indicator id ${i.id}`);
      ids.add(i.id);
    }
    out.push({ pack: parsed, digest: createHash('sha256').update(text).digest('hex'), file: f });
  }
  return out;
}

export const IndicatorResultSchema = z.object({
  id: z.string(),
  title: z.string(),
  reference: z.string(),
  status: z.enum(INDICATOR_STATUSES),
  confidence: z.number().min(0).max(1),
  /** Fact ids / files the status rests on. */
  facts: z.array(z.string()),
  /** Why the status is what it is (one line per decisive observation). */
  reasons: z.array(z.string()),
  /** Evidence that was missing and would change the status. */
  missing: z.array(z.string()),
  limitations: z.string(),
});

export const PackResultSchema = z.object({
  pack: z.string(),
  version: z.string(),
  digest: z.string(),
  title: z.string(),
  jurisdiction: z.string(),
  instrument: z.string(),
  status: z.literal('indicative'),
  applicability: ApplicabilitySchema,
  /** Indicators are only evaluated when the pack is applicable or potentially applicable. */
  evaluated: z.boolean(),
  indicators: z.array(IndicatorResultSchema),
  summary: z.object({
    observed: z.number(),
    partial: z.number(),
    not_observed: z.number(),
    unknown: z.number(),
  }),
  legal_determination: z.literal(LEGAL_DETERMINATION),
});
export type PackResult = z.infer<typeof PackResultSchema>;

export const RegulatorySchema = z.object({
  engine_version: z.string(),
  disclaimer: z.string(),
  packs: z.array(PackResultSchema),
  /** Technical indicators (privacy, AI) the packs and future packs read. Facts, not conclusions. */
  indicators: z.array(TechnicalIndicatorSchema),
});
export type Regulatory = z.infer<typeof RegulatorySchema>;
export const REGULATORY_ENGINE_VERSION = '0.1';

export function evaluatePack(lp: LoadedPack, ctx: ComplianceContext): PackResult {
  const p = lp.pack;
  const applicability = evaluateApplicability(p.applies_when, ctx, p.requires_context);
  const evaluated =
    applicability.state === 'applicable' || applicability.state === 'potentially_applicable';
  const indicators = evaluated
    ? p.indicators.map((ind) => {
        const obs = evaluateCondition(ind.observed_when, ctx);
        const part = ind.partial_when ? evaluateCondition(ind.partial_when, ctx) : undefined;
        let status: (typeof INDICATOR_STATUSES)[number];
        if (obs.value === true) status = 'observed';
        else if (part?.value === true) status = 'partial';
        else if (obs.value === null && (part === undefined || part.value === null))
          status = 'unknown';
        else status = 'not_observed';
        const decisive = status === 'partial' && part ? part : obs;
        return {
          id: ind.id,
          title: ind.title,
          reference: ind.reference,
          status,
          confidence: Math.round(Math.max(0, Math.min(1, decisive.confidence)) * 100) / 100,
          facts: [...new Set([...obs.facts, ...(part?.facts ?? [])])].slice(0, 12),
          reasons: [...new Set([...obs.reasons, ...(part?.reasons ?? [])])].slice(0, 6),
          missing: [...new Set([...obs.missing, ...(part?.missing ?? [])])].slice(0, 6),
          limitations: ind.limitations,
        };
      })
    : [];
  const count = (s: (typeof INDICATOR_STATUSES)[number]): number =>
    indicators.filter((i) => i.status === s).length;
  return {
    pack: p.pack,
    version: p.version,
    digest: lp.digest,
    title: p.title,
    jurisdiction: p.jurisdiction,
    instrument: p.instrument,
    status: p.status,
    applicability,
    evaluated,
    indicators,
    summary: {
      observed: count('observed'),
      partial: count('partial'),
      not_observed: count('not_observed'),
      unknown: count('unknown'),
    },
    legal_determination: LEGAL_DETERMINATION,
  };
}

export function evaluateRegulatory(packs: LoadedPack[], ctx: ComplianceContext): Regulatory {
  return {
    engine_version: REGULATORY_ENGINE_VERSION,
    disclaimer: LEGAL_DISCLAIMER,
    packs: packs.map((p) => evaluatePack(p, ctx)),
    indicators: ctx.indicators.slice(0, 200),
  };
}
