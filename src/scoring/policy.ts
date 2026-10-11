import { evaluateCondition, type ComplianceContext } from '../compliance/applicability.js';
import type { Profile } from './types.js';
import type { ScoringResult } from './engine.js';

export interface PolicyViolation {
  key: string;
  minimum: number;
  actual: number | null;
  /** `insufficient_evidence`: the floor cannot be verified, which is treated as a failure. */
  reason: 'below_minimum' | 'insufficient_evidence';
}

export function evaluatePolicy(
  result: ScoringResult,
  minimums: Record<string, number>,
): PolicyViolation[] {
  const out: PolicyViolation[] = [];
  for (const [key, minimum] of Object.entries(minimums).sort()) {
    const target =
      key === 'overall' ? result.overall : result.dimensions.find((d) => d.dimension === key);
    if (!target) continue;
    if (target.sufficiency === 'insufficient' || target.score === null) {
      out.push({ key, minimum, actual: target.score, reason: 'insufficient_evidence' });
    } else if (target.score < minimum) {
      out.push({ key, minimum, actual: target.score, reason: 'below_minimum' });
    }
  }
  return out;
}

/** Parse repeated `--min dimension=score` flags. */
export function parseMinimums(flags: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of flags) {
    const m = /^([a-z-]+)=(\d{1,3}(?:\.\d+)?)$/.exec(f);
    const n = m ? Number(m[2]) : NaN;
    if (!m || !(n >= 0 && n <= 100))
      throw new Error(`invalid --min "${f.slice(0, 40)}"; expected <dimension|overall>=<0-100>`);
    out[m[1] as string] = n;
  }
  return out;
}

export interface BlockViolation {
  id: string;
  description: string;
  /** `condition_true`: the blocking condition holds; `undecidable`: it could not be decided and the block asks to block anyway. */
  reason: 'condition_true' | 'undecidable';
  /** Fact, finding or file ids the decision rests on. */
  evidence: string[];
  /** Evidence that was missing (for `undecidable`). */
  missing: string[];
}

/**
 * Policy-as-code: every `block` of the profile is a condition over the report. A block fires when its condition is
 * true; when the condition cannot be decided it fires only if the block says `on_unknown: block`.
 */
export function evaluateBlocks(blocks: Profile['block'], ctx: ComplianceContext): BlockViolation[] {
  const out: BlockViolation[] = [];
  for (const b of blocks) {
    const r = evaluateCondition(b.when, ctx);
    if (r.value === true)
      out.push({
        id: b.id,
        description: b.description,
        reason: 'condition_true',
        evidence: r.facts,
        missing: [],
      });
    else if (r.value === null && b.on_unknown === 'block')
      out.push({
        id: b.id,
        description: b.description,
        reason: 'undecidable',
        evidence: r.facts,
        missing: r.missing,
      });
  }
  return out;
}
