import type { AnalyzeOptions } from './analyze.js';

/**
 * The ONE default analysis configuration. The CLI (`repo-radar analyze` with no flags), the Web Analyzer worker and a direct
 * library call all start from this object, so a default analysis means the same thing everywhere. Each field is spelled out
 * (even when the engine would treat `undefined` the same way) so that a test can prove the explicit defaults and the engine's
 * implicit ones agree.
 */
export function createDefaultAnalysisOptions(): AnalyzeOptions {
  return {
    mode: 'quick',
    profile: 'default',
    scorecard: true,
    osv: true,
    depsDev: true,
    sbom: true,
    compliance: true,
    targetedTree: true,
    releases: true,
    registry: true,
    dependencyRegistry: true,
    verifyCrypto: false,
    verifyAssets: false,
    codeScan: true,
    domains: true,
    inspectDependencyArtifacts: false,
    nameIntelligence: false,
  };
}
