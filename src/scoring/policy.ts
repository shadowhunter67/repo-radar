import { evaluateCondition, type ComplianceContext } from '../compliance/applicability.js';
import { correlate } from '../events/correlate.js';
import type { Timeline } from '../events/model.js';
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

type Block = Profile['block'][number];

/** Explicit `block` rules plus the ones `require:` compiles into. Deterministic and order-stable. */
export function effectiveBlocks(profile: Pick<Profile, 'block' | 'require'>): Block[] {
  const out: Block[] = [...profile.block];
  const r = profile.require;
  const mk = (
    key:
      | 'sbom'
      | 'signed_release'
      | 'provenance'
      | 'checksums'
      | 'verified_provenance'
      | 'verified_source_binding'
      | 'registry_repository_match'
      | 'publisher_stability',
    description: string,
    when: Block['when'],
  ): void => {
    const v = r[key];
    if (v === undefined || v === false) return;
    out.push({
      id: `require-${key.replace(/_/g, '-')}`,
      description,
      when,
      on_unknown: v === 'strict' ? 'block' : 'ignore',
    });
  };
  mk('sbom', 'A parsable SBOM is required but none is committed', {
    fact: { id: 'deps.sbom.present', equals: false },
  });
  mk(
    'signed_release',
    'A signed release is required: the latest release tag is not GitHub-verified and no signature asset is published',
    {
      all: [
        { fact: { id: 'release.tag.signature_verified', equals: false } },
        { fact: { id: 'release.signature_assets.present', equals: false } },
      ],
    } as Block['when'],
  );
  mk('provenance', 'Release provenance is required but none was found for the latest release', {
    fact: { id: 'release.provenance.present', equals: false },
  });
  mk(
    'checksums',
    'Published checksums are required but the latest release has none covering its assets',
    { fact: { id: 'release.checksums.published', equals: false } },
  );
  mk(
    'verified_provenance',
    'A cryptographically verified release attestation is required but none was verified',
    {
      fact: { id: 'release.provenance.verified', equals: false },
    },
  );
  mk(
    'verified_source_binding',
    'A verified attestation binding the release artifact to this repository and tag commit is required',
    {
      fact: { id: 'release.source_binding_verified', equals: false },
    },
  );
  mk('registry_repository_match', 'A published package does not point back to this repository', {
    any: [
      { fact: { id: 'registry.repository_match', equals: 'conflicting' } },
      { fact: { id: 'registry.repository_match', equals: 'missing' } },
    ],
  } as Block['when']);
  mk(
    'publisher_stability',
    'A recent version was published by an account new to the sampled publish history',
    {
      fact: { id: 'registry.publisher_stable', equals: false },
    },
  );
  return out;
}

/** Evaluate `temporal_block` rules against a timeline. A pattern that cannot be evaluated never blocks. */
export function evaluateTemporalBlocks(
  blocks: Profile['temporal_block'],
  timeline: Timeline,
): BlockViolation[] {
  const out: BlockViolation[] = [];
  for (const b of blocks) {
    const hits =
      typeof b.pattern === 'string'
        ? timeline.correlations.filter((c) => c.pattern_id === b.pattern)
        : correlate(timeline.events, [b.pattern]);
    const first = hits[0];
    if (first)
      out.push({
        id: b.id,
        description: b.description,
        reason: 'condition_true',
        evidence: first.event_ids,
        missing: [],
      });
  }
  return out;
}

export interface HistoryViolation {
  id: string;
  description: string;
  kind: string;
  /** Dependency / hook / capability names that triggered the rule. */
  subjects: string[];
}

/** Evaluate `history_block` rules on a historical diff. Only observed (not inconclusive) additions can trigger a rule. */
export function evaluateHistoryBlocks(
  rules: Profile['history_block'],
  diff: {
    dependencies: { kind: string; package: string; certainty: string }[];
    execution: {
      change: string;
      hook: string;
      for_dependents: boolean;
      path: string;
      risk: string;
      certainty: string;
    }[];
    capabilities: {
      capability: string;
      change: string;
      after: { risk: string } | null;
      certainty: string;
    }[];
    governance: { takeover_indicators_after: boolean };
  },
): HistoryViolation[] {
  const out: HistoryViolation[] = [];
  const newHooks = diff.execution.filter(
    (e) => e.change === 'new' && e.for_dependents && e.certainty === 'observed',
  );
  for (const r of rules) {
    let subjects: string[] = [];
    switch (r.kind) {
      case 'new_vulnerability':
        subjects = diff.dependencies
          .filter((d) => d.kind === 'new_vulnerability')
          .map((d) => d.package);
        break;
      case 'new_install_hook':
        subjects = newHooks.map((h) => h.hook);
        break;
      case 'new_install_time_remote_execution':
        subjects = newHooks.filter((h) => /download|piped|remote/.test(h.path)).map((h) => h.hook);
        break;
      case 'new_capability':
        subjects = diff.capabilities
          .filter(
            (c) =>
              c.change === 'new' &&
              c.certainty === 'observed' &&
              (r.capability
                ? c.capability === r.capability
                : c.after?.risk === 'medium' || c.after?.risk === 'high'),
          )
          .map((c) => c.capability);
        break;
      case 'new_git_or_path_dependency':
        subjects = diff.dependencies
          .filter((d) => d.kind === 'new_git_or_path_dependency')
          .map((d) => d.package);
        break;
      case 'takeover_indicators_with_new_install_hook':
        subjects = diff.governance.takeover_indicators_after ? newHooks.map((h) => h.hook) : [];
        break;
    }
    if (subjects.length > 0)
      out.push({
        id: r.id,
        description: r.description,
        kind: r.kind,
        subjects: [...new Set(subjects)].slice(0, 10),
      });
  }
  return out;
}
