import { analyzeRepository, type AnalyzeOptions } from '../analyze.js';
import { createDefaultAnalysisOptions } from '../defaults.js';
import type { Report } from '../report/schema.js';
import type { WebRepo } from './validate.js';

/**
 * Web-only differences from the shared default analysis. Every entry must be explained in docs/web-analyzer.md and is
 * asserted by tests/unit/defaults-parity.test.ts. Today there are none: history analysis is not an analysis default (it is
 * off in the engine and the CLI too), so the web does not need to switch it off here. Resource limits (timeout, memory,
 * report size) are enforced around the analysis by the server, not inside it, so they cannot change the report.
 */
export const WEB_ANALYSIS_OVERRIDES: Readonly<AnalyzeOptions> = Object.freeze({});

export function webAnalysisOptions(
  repo: Pick<WebRepo, 'ref'>,
  extra: Pick<AnalyzeOptions, 'token' | 'onStage' | 'fetch' | 'clock'> = {},
): AnalyzeOptions {
  return {
    ...createDefaultAnalysisOptions(),
    ...WEB_ANALYSIS_OVERRIDES,
    ...(repo.ref ? { ref: repo.ref } : {}),
    ...(extra.token ? { token: extra.token } : {}),
    ...(extra.onStage ? { onStage: extra.onStage } : {}),
    ...(extra.fetch ? { fetch: extra.fetch } : {}),
    ...(extra.clock ? { clock: extra.clock } : {}),
  };
}

/** The single function both the worker thread and the in-process tests call. */
export function runWebAnalysis(
  repo: WebRepo,
  extra: Pick<AnalyzeOptions, 'token' | 'onStage' | 'fetch' | 'clock'> = {},
): Promise<Report> {
  return analyzeRepository(`${repo.owner}/${repo.repo}`, webAnalysisOptions(repo, extra));
}
