/**
 * One default analysis configuration for the library, the CLI and the Web Analyzer, and a real pipeline comparison:
 * the same mocked upstreams analyzed through the CLI option builder and through the web job path must give the same report.
 */
import { parseArgs } from 'node:util';
import { describe, expect, it } from 'vitest';
import { analyzeRepository } from '../../src/analyze.js';
import { buildAnalyzeOptions, CLI_PARSE_OPTIONS } from '../../src/cli.js';
import { createDefaultAnalysisOptions } from '../../src/defaults.js';
import { loadWebConfig } from '../../src/web/config.js';
import {
  runWebAnalysis,
  WEB_ANALYSIS_OVERRIDES,
  webAnalysisOptions,
} from '../../src/web/analysis.js';
import { createWebServer } from '../../src/web/server.js';
import { fakeFetch, fixedClock, type FakeSpec } from '../helpers/fake-github.js';
import { goodRepo } from '../helpers/scenarios.js';
import { installerRepo } from '../helpers/code-scenarios.js';

const cliDefaults = () => {
  const { values } = parseArgs({
    args: ['analyze', 'acme/widget'],
    allowPositionals: true,
    options: CLI_PARSE_OPTIONS,
  });
  return buildAnalyzeOptions(values as Parameters<typeof buildAnalyzeOptions>[0], undefined, {});
};

describe('default analysis configuration', () => {
  it('the CLI with no flags resolves to the shared defaults (only the policy plumbing keys differ)', () => {
    const { minimums, enforcePolicy, ...rest } = cliDefaults();
    expect(minimums).toEqual({});
    expect(enforcePolicy).toBe(false);
    expect(rest).toEqual(createDefaultAnalysisOptions());
  });

  it('the web options for a repository without a ref are exactly the shared defaults', () => {
    expect(WEB_ANALYSIS_OVERRIDES).toEqual({});
    expect(webAnalysisOptions({})).toEqual(createDefaultAnalysisOptions());
  });

  it('the web adds only the token, ref, stage callback and test transport on top of the defaults', () => {
    const onStage = () => undefined;
    const o = webAnalysisOptions({ ref: 'v1.2.3' }, { token: 't', onStage });
    const { ref, token, onStage: stage, ...rest } = o;
    expect({ ref, token, stage }).toEqual({ ref: 'v1.2.3', token: 't', stage: onStage });
    expect(rest).toEqual(createDefaultAnalysisOptions());
  });

  it('an explicit default configuration and the engine implicit defaults produce the same report digest', async () => {
    const spec = goodRepo();
    const run = (o: Parameters<typeof analyzeRepository>[1]) =>
      analyzeRepository(`${spec.owner}/${spec.repo}`, {
        fetch: fakeFetch(spec),
        clock: fixedClock,
        ...o,
      });
    const implicit = await run({});
    const explicit = await run(createDefaultAnalysisOptions());
    expect(explicit.integrity.report_sha256).toBe(implicit.integrity.report_sha256);
    expect(explicit.methodology.config_digest).toBe(implicit.methodology.config_digest);
  });

  it('a flag that changes the analysis changes the configuration digest (the digest is not vacuous)', async () => {
    const spec = goodRepo();
    const run = (o: Parameters<typeof analyzeRepository>[1]) =>
      analyzeRepository(`${spec.owner}/${spec.repo}`, {
        fetch: fakeFetch(spec),
        clock: fixedClock,
        ...o,
      });
    const a = await run(createDefaultAnalysisOptions());
    const b = await run({ ...createDefaultAnalysisOptions(), codeScan: false });
    expect(b.methodology.config_digest).not.toBe(a.methodology.config_digest);
  });
});

async function webReport(spec: FakeSpec): Promise<unknown> {
  const server = createWebServer({
    config: loadWebConfig({ PORT: '0', NODE_ENV: 'development' }),
    runAnalysis: (repo, onStage) =>
      runWebAnalysis(repo, { fetch: fakeFetch(spec), clock: fixedClock, onStage }),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const started = await fetch(`${base}/api/v1/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repository: `${spec.owner}/${spec.repo}` }),
    });
    const { poll_url } = (await started.json()) as { poll_url: string };
    for (let i = 0; i < 200; i++) {
      const job = (await (await fetch(base + poll_url)).json()) as { state: string };
      if (!['queued', 'running'].includes(job.state)) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const res = await fetch(`${base}${poll_url}/report`);
    expect(res.status).toBe(200);
    return await res.json();
  } finally {
    await new Promise((r) => server.close(r));
  }
}

describe('CLI path and web job path produce the same report (mocked upstreams, same config)', () => {
  it.each([
    ['healthy repository', goodRepo],
    ['installer repository', installerRepo],
  ])(
    '%s',
    async (_name, make) => {
      const spec = make();
      const cli = await analyzeRepository(`${spec.owner}/${spec.repo}`, {
        ...cliDefaults(),
        fetch: fakeFetch(spec),
        clock: fixedClock,
      });
      const web = (await webReport(spec)) as typeof cli;
      expect(web).toEqual(JSON.parse(JSON.stringify(cli)));
      expect(web.integrity.report_sha256).toBe(cli.integrity.report_sha256);
    },
    60_000,
  );
});
