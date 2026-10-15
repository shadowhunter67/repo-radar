import type { HttpClient } from '../../util/http.js';
import { LIMITS } from '../../limits.js';
import { inspectArtifact } from './inspect.js';
import type { DependencyArtifacts } from './model.js';
import { extractStaticFacts } from './static.js';

export const ARTIFACT_HOSTS = new Set([
  'registry.npmjs.org',
  'files.pythonhosted.org',
  ['static', 'crates', 'io'].join('.'),
  'crates.io',
]);
export function safeArtifactUrl(raw: string, ecosystem: 'npm' | 'pypi' | 'crates.io'): boolean {
  try {
    const u = new URL(raw);
    const allowed =
      ecosystem === 'npm'
        ? ['registry.npmjs.org']
        : ecosystem === 'pypi'
          ? ['files.pythonhosted.org']
          : [['static', 'crates', 'io'].join('.'), 'crates.io'];
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !u.port &&
      !/^[^:]+:\/\/[^/]*:\d+(?:\/|$)/.test(raw) &&
      allowed.includes(u.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}
export async function inspectDownloadedArtifacts(opts: {
  http: HttpClient;
  candidates: {
    registry: 'npm' | 'pypi' | 'crates.io';
    package: string;
    version: string;
    url: string | null;
    digest?: { algorithm: 'sha256' | 'sha512'; value: string } | null;
  }[];
}): Promise<DependencyArtifacts> {
  const artifacts: DependencyArtifacts['artifacts'] = [],
    skipped: Record<string, number> = {};
  let bytes = 0;
  const eligible = opts.candidates.length;
  for (const c of opts.candidates.slice(0, LIMITS.maxArtifactsPerRun)) {
    const skip = (r: string): void => {
      skipped[r] = (skipped[r] ?? 0) + 1;
      artifacts.push({
        registry: c.registry,
        package: c.package,
        version: c.version,
        url: c.url,
        state: 'skipped',
        entries: 0,
        total_size: 0,
        hooks: [],
        domains: [],
        mismatches: [],
        reason: r,
        evidence: [],
      });
    };
    if (!c.url) {
      skip('no_url');
      continue;
    }
    if (!safeArtifactUrl(c.url, c.registry)) {
      skip('unsafe_url');
      continue;
    }
    try {
      const r = await opts.http.request(c.url, {
        binary: true,
        maxBytes: LIMITS.maxArtifactCompressedBytes,
      });
      const data = Buffer.from(r.body, 'latin1');
      if (bytes + data.length > LIMITS.maxArtifactTotalCompressedBytes) {
        skip('budget_bytes');
        continue;
      }
      bytes += data.length;
      const i = inspectArtifact(data, {
        expectedDigest: c.digest?.value,
        algorithm: c.digest?.algorithm,
      });
      const facts =
        i.state === 'invalid'
          ? { hooks: [], domains: [], mismatches: [] }
          : extractStaticFacts(i, { name: c.package, version: c.version });
      artifacts.push({
        registry: c.registry,
        package: c.package,
        version: c.version,
        url: c.url,
        state: i.state,
        entries: i.entries.length,
        total_size: i.totalSize,
        hooks: facts.hooks,
        domains: facts.domains,
        mismatches: facts.mismatches,
        reason: i.state === 'invalid' ? 'digest_mismatch' : null,
        evidence: [],
      });
    } catch {
      skip('fetch_failed');
    }
  }
  if (eligible > LIMITS.maxArtifactsPerRun)
    skipped['budget_artifacts'] = eligible - LIMITS.maxArtifactsPerRun;
  const inspected = artifacts.filter(
    (a) => a.state === 'verified' || a.state === 'verification_unavailable',
  ).length;
  return {
    version: '1',
    status: 'analyzed',
    eligible,
    candidates: eligible,
    downloaded: artifacts.filter((a) => a.state !== 'skipped').length,
    digest_verified: artifacts.filter((a) => a.state === 'verified').length,
    inspected,
    skipped,
    artifacts,
    limits_hit: [],
    not_available: [],
  };
}
