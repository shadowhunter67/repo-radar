import type { CodeAnalysis } from '../analysis/index.js';
import type { ScannedFile } from '../analysis/types.js';
import type { ParsedManifest } from '../collectors/manifests/parse.js';
import type { Dependency, DependencyIntel } from '../deps/model.js';
import type { EvidenceStore } from '../evidence/store.js';
import type { Fact } from '../facts/index.js';
import type { ComplianceContext } from './applicability.js';
import {
  AI_CATEGORIES,
  PRIVACY_CATEGORIES,
  detectIndicators,
  summarizeIndicators,
  type TechnicalIndicator,
} from './indicators.js';
import { evaluateRegulatory, type LoadedPack, type Regulatory } from './packs.js';

export { LEGAL_DISCLAIMER } from './disclaimer.js';
export { loadPacks, RegulatorySchema, type Regulatory } from './packs.js';
export { detectIndicators, type TechnicalIndicator } from './indicators.js';

export interface ComplianceInput {
  packs: LoadedPack[];
  identity: {
    artifact_type: string;
    artifact_confidence: number;
    domain: string;
    ecosystem: string[];
  };
  code: CodeAnalysis;
  intel: DependencyIntel;
  /** Complete in-memory dependency list (the report view of `intel` is capped). */
  allDependencies: Dependency[];
  manifests: ParsedManifest[];
  files: ScannedFile[];
  treePaths: string[];
  scanReliable: boolean;
}

/** Step 1: the technical indicators (privacy, AI). They become facts before scoring so they are traceable. */
export function collectIndicators(
  i: Pick<ComplianceInput, 'files' | 'treePaths' | 'allDependencies'>,
): TechnicalIndicator[] {
  return detectIndicators({
    files: i.files,
    treePaths: i.treePaths,
    dependencies: i.allDependencies,
  });
}

/** Facts `privacy.<category>.observed` / `ai.<category>.observed`; "not observed" is only stated when the scan was broad. */
export function deriveIndicatorFacts(
  indicators: TechnicalIndicator[],
  scanReliable: boolean,
  code: CodeAnalysis,
): Fact[] {
  const best = summarizeIndicators(indicators);
  const facts: Fact[] = [];
  const add = (
    family: 'privacy' | 'ai',
    cat: string,
    value: boolean,
    confidence: number,
    from: string[],
  ): void => {
    facts.push({
      id: `${family}.${cat}.observed`,
      value,
      confidence,
      scope: family === 'privacy' ? 'repo' : 'repo',
      derived_from: from.slice(0, 10),
      derived_by: 'technical-indicators@0.1',
    });
  };
  for (const cat of PRIVACY_CATEGORIES) {
    const ids = indicators
      .filter((x) => x.family === 'privacy' && x.category === cat)
      .map((x) => x.id);
    if (cat === 'credentials') {
      const cred = code.capabilities.summary.find((s) => s.capability === 'CREDENTIAL_ACCESS');
      if (cred?.observed)
        add('privacy', cat, true, cred.confidence, ['capability.credential_access.observed']);
      else if (scanReliable) add('privacy', cat, false, 0.5, []);
      continue;
    }
    const c = best.get(`privacy.${cat}`);
    if (c !== undefined) add('privacy', cat, true, c, ids);
    else if (scanReliable) add('privacy', cat, false, 0.5, []);
  }
  for (const cat of AI_CATEGORIES) {
    const c = best.get(`ai.${cat}`);
    const ids = indicators.filter((x) => x.family === 'ai' && x.category === cat).map((x) => x.id);
    if (c !== undefined) add('ai', cat, true, c, ids);
    else if (scanReliable) add('ai', cat, false, 0.5, []);
  }
  return facts;
}

/** The evaluation context shared by regulatory packs and policy blocks. */
export function buildComplianceContext(
  input: ComplianceInput,
  indicators: TechnicalIndicator[],
  store: EvidenceStore,
  findings?: ComplianceContext['findings'],
): ComplianceContext {
  return {
    ...(findings ? { findings } : {}),
    identity: input.identity,
    code: input.code,
    intel: input.intel,
    treePaths: input.treePaths,
    indicators,
    scanReliable: input.scanReliable,
    fact: (id) => {
      const e = store.get(id);
      return e ? { value: e.value, confidence: e.confidence } : undefined;
    },
    hasPrivateOnlyManifests:
      input.manifests.length > 0 && input.manifests.every((m) => m.isPrivate === true),
    releasesPresent: ((): boolean | undefined => {
      const v = store.get('github.releases.has_any')?.value;
      return typeof v === 'boolean' ? v : undefined;
    })(),
    dockerfilePresent: ((): boolean | undefined => {
      const v = store.get('github.file.dockerfile')?.value;
      return typeof v === 'boolean' ? v : undefined;
    })(),
  };
}

/** Step 2 (after scoring): applicability and indicator status for every pack. */
export function evaluateCompliance(
  input: ComplianceInput,
  indicators: TechnicalIndicator[],
  store: EvidenceStore,
): Regulatory {
  return evaluateRegulatory(input.packs, buildComplianceContext(input, indicators, store));
}
