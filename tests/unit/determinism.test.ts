/**
 * Same frozen evidence, same exact config -> the same canonical report and the same report_sha256, whatever order the
 * concurrent collectors happen to finish in. Every upstream is a mock; live sources are NOT claimed to be immutable.
 * A seeded PRNG gives each request a different artificial delay, so completion order is shuffled per iteration.
 */
import { describe, expect, it } from 'vitest';
import { analyzeRepository } from '../../src/analyze.js';
import type { FetchLike } from '../../src/util/http.js';
import { installerRepo } from '../helpers/code-scenarios.js';
import { fakeFetch, fixedClock, type FakeSpec } from '../helpers/fake-github.js';
import { goodRepo } from '../helpers/scenarios.js';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const shuffled =
  (inner: FetchLike, seed: number): FetchLike =>
  async (url, init) => {
    const rand = mulberry32(seed ^ [...url].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7));
    await new Promise((r) => setTimeout(r, Math.floor(rand() * 12)));
    const res = await inner(url, init);
    await new Promise((r) => setTimeout(r, Math.floor(rand() * 12)));
    return res;
  };

/** Many source files referring to the same few hosts, so that order ties are common. */
function domainHeavyRepo(): FakeSpec {
  const base = installerRepo();
  const files = { ...base.files };
  const hosts = [
    'api.acme-widgets.dev',
    'cdn.acme-widgets.net',
    'telemetry.acme-widgets.io',
    'registry.acme-widgets.app',
  ];
  for (let i = 0; i < 24; i++)
    files[`src/net/client${i}.js`] =
      `const a = fetch('https://${hosts[i % hosts.length]}/v1/x${i}');\nconst b = fetch('https://${hosts[(i + 1) % hosts.length]}/y');\n`;
  return { ...base, files };
}
const analyze = (spec: FakeSpec, seed: number, all = false) =>
  analyzeRepository(`${spec.owner}/${spec.repo}`, {
    fetch: shuffled(fakeFetch(spec), seed),
    clock: fixedClock,
    ...(all ? {} : { scorecard: false, osv: false, depsDev: false, registry: false }),
  });

async function divergence(spec: FakeSpec, all: boolean): Promise<string[]> {
  const first = await analyze(spec, 1, all);
  const diverged = new Set<string>();
  for (let seed = 2; seed <= 13; seed++) {
    const r = await analyze(spec, seed, all);
    for (const k of Object.keys(first) as Array<keyof typeof first>)
      if (k !== 'integrity' && JSON.stringify(r[k]) !== JSON.stringify(first[k])) diverged.add(k);
    if (r.integrity.report_sha256 !== first.integrity.report_sha256) diverged.add('report_sha256');
  }
  return [...diverged];
}

describe('report determinism under shuffled completion order (mocked sources)', () => {
  it('domain-heavy installer repository: identical report_sha256 on every iteration', async () => {
    const first = await analyze(domainHeavyRepo(), 1);
    expect(first.external_domains.domains.length).toBeGreaterThan(2);
    expect(await divergence(domainHeavyRepo(), false)).toEqual([]);
  }, 120_000);

  it('healthy repository with every mocked upstream enabled (releases, registry, OSV, scorecard)', async () => {
    expect(await divergence(goodRepo(), true)).toEqual([]);
  }, 120_000);

  it('installer repository with every mocked upstream enabled', async () => {
    expect(await divergence(domainHeavyRepo(), true)).toEqual([]);
  }, 120_000);
});
