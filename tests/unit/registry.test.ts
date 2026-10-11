import { describe, expect, it } from 'vitest';
import { analyzeRepository } from '../../src/analyze.js';
import { declaredPackages } from '../../src/collectors/registry.js';
import { parseManifest } from '../../src/collectors/manifests/parse.js';
import {
  matchRepository,
  normalizeRepoUrl,
  parseCrates,
  parseNpm,
  parsePypi,
} from '../../src/registry/parse.js';
import { registrySignals } from '../../src/registry/signals.js';
import type { Report } from '../../src/report/schema.js';
import { fakeFetch, fixedClock, type FakeSpec } from '../helpers/fake-github.js';
import { goodRepo } from '../helpers/scenarios.js';

const ME = { owner: 'acme', repo: 'widget' };
const C = {
  name: 'widget',
  declaredBy: 'package.json',
  analyzed: ME,
  observedAt: '2026-01-01T00:00:00Z',
};
const DAY = 86_400_000;
const T0 = Date.parse('2024-01-01T00:00:00Z');
const iso = (d: number): string => new Date(T0 + d * DAY).toISOString();

interface NpmVersion {
  v: string;
  day: number;
  user: string;
  prov?: boolean;
}
const npmDoc = (versions: NpmVersion[], extra: Record<string, unknown> = {}) => ({
  name: 'widget',
  'dist-tags': { latest: versions[versions.length - 1]?.v },
  maintainers: [{ name: 'alice' }],
  repository: { type: 'git', url: 'git+https://github.com/acme/widget.git' },
  time: Object.fromEntries(versions.map((x) => [x.v, iso(x.day)])),
  versions: Object.fromEntries(
    versions.map((x) => [
      x.v,
      {
        _npmUser: { name: x.user },
        dist: {
          integrity: 'sha512-x',
          ...(x.prov ? { attestations: { url: 'u', provenance: { predicateType: 'p' } } } : {}),
        },
      },
    ]),
  ),
  ...extra,
});
const steady = (n: number, user = 'alice'): NpmVersion[] =>
  Array.from({ length: n }, (_, i) => ({ v: `1.0.${i}`, day: i * 20, user }));

describe('repository URL normalization and correspondence', () => {
  it('normalizes the usual GitHub URL shapes and rejects everything else', () => {
    for (const u of [
      'git+https://github.com/Acme/Widget.git',
      'git://github.com/acme/widget',
      'git@github.com:acme/widget.git',
      'ssh://git@github.com/acme/widget',
      'github:acme/widget',
      'acme/widget',
      'https://www.github.com/acme/widget/tree/main/sub',
    ])
      expect(normalizeRepoUrl(u), u).toBe('acme/widget');
    for (const u of [
      'https://gitlab.com/acme/widget',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'https://github.com/acme',
      '',
      5,
      null,
    ])
      expect(normalizeRepoUrl(u), String(u)).toBeNull();
  });

  it('confirmed / likely / conflicting / missing', () => {
    expect(matchRepository(ME, 'git+https://github.com/acme/widget.git', null).match).toBe(
      'confirmed',
    );
    expect(matchRepository(ME, 'https://github.com/acme/old-name', 'acme/widget').match).toBe(
      'likely',
    );
    expect(matchRepository(ME, 'https://github.com/evil/widget', null).match).toBe('conflicting');
    expect(matchRepository(ME, 'https://gitlab.com/acme/widget', null).match).toBe('conflicting');
    expect(matchRepository(ME, null, null).match).toBe('missing');
    expect(matchRepository(ME, null, 'acme/widget').match).toBe('likely');
  });

  it('the same package name proves nothing: a package that points elsewhere is conflicting', () => {
    const p = parseNpm(
      npmDoc(steady(3), { repository: { url: 'git+https://github.com/someone-else/widget.git' } }),
      C,
    );
    expect(p.repository.match).toBe('conflicting');
  });
});

describe('npm / PyPI / crates.io parsing', () => {
  it('npm: versions newest first, per-version publisher, provenance and integrity flags, current-state maintainers', () => {
    const p = parseNpm(
      npmDoc([...steady(4), { v: '2.0.0', day: 200, user: 'bob', prov: true }]),
      C,
    );
    expect(p.status).toBe('ok');
    expect(p.versions[0]).toMatchObject({
      version: '2.0.0',
      has_provenance: true,
      has_integrity: true,
    });
    expect(p.versions[0]?.publisher?.name).toBe('bob');
    expect(p.maintainers.scope).toBe('current_state');
    expect(p.provenance).toEqual({ reported: 'yes', versions_with: 1 });
    expect(p.repository.match).toBe('confirmed');
  });

  it('npm: no provenance anywhere is "no", not "unknown"; versions are capped and the cap is stated', () => {
    const p = parseNpm(npmDoc(steady(60)), C);
    expect(p.provenance.reported).toBe('no');
    expect(p.versions).toHaveLength(40);
    expect(p.versions_total).toBe(60);
    expect(p.limits.join(' ')).toMatch(/newest 40 of 60/);
  });

  it('PyPI: upload times, yanked state, hashes; states that maintainers and publishers are not exposed', () => {
    const p = parsePypi(
      {
        info: { version: '1.2.0', project_urls: { Source: 'https://github.com/acme/widget' } },
        releases: {
          '1.0.0': [
            {
              upload_time_iso_8601: '2024-01-01T00:00:00Z',
              digests: { sha256: 'a' },
              yanked: false,
            },
          ],
          '1.2.0': [
            {
              upload_time_iso_8601: '2025-01-01T00:00:00Z',
              digests: { sha256: 'b' },
              yanked: false,
            },
          ],
        },
      },
      { ...C, name: 'widget' },
    );
    expect(p.versions.map((v) => v.version)).toEqual(['1.2.0', '1.0.0']);
    expect(p.versions[0]?.publisher).toBeNull();
    expect(p.repository.match).toBe('confirmed');
    expect(p.limits.join(' ')).toMatch(/neither maintainers nor per-version publishers/);
    expect(p.provenance.reported).toBe('unknown');
  });

  it('crates.io: published_by and owners', () => {
    const p = parseCrates(
      {
        crate: { max_stable_version: '0.3.0', repository: 'https://github.com/acme/widget' },
        versions: [
          {
            num: '0.3.0',
            created_at: iso(300),
            published_by: { login: 'carol' },
            yanked: false,
            checksum: 'x',
          },
          {
            num: '0.2.0',
            created_at: iso(100),
            published_by: { login: 'alice' },
            yanked: true,
            checksum: 'y',
          },
        ],
      },
      { users: [{ login: 'alice' }, { login: 'ALICE' }] },
      C,
    );
    expect(p.versions[0]?.publisher?.name).toBe('carol');
    expect(p.versions[1]?.yanked_or_deprecated).toBe(true);
    expect(p.maintainers.names.map((n) => n.name)).toEqual(['alice']);
    expect(p.maintainers.duplicates).toBe(1);
  });

  it('malformed bodies fail closed as "malformed", never as a clean package', () => {
    expect(parseNpm(null, C).status).toBe('malformed');
    expect(parsePypi({}, C).status).toBe('malformed');
    expect(parseCrates({ versions: [] }, undefined, C).status).toBe('malformed');
    expect(parseNpm('garbage', C).versions).toEqual([]);
  });

  it('hostile fields: control characters, homoglyphs, huge strings, prototype keys', () => {
    const esc = String.fromCharCode(27);
    const doc = npmDoc(steady(5, `al${esc}[2Jice`), {
      maintainers: [{ name: 'аlice' }, { name: 'x'.repeat(5000) }, { name: '__proto__' }],
      repository: 'x'.repeat(5000),
    });
    const p = parseNpm(doc, C);
    const all = JSON.stringify(p);
    expect(all.includes(esc)).toBe(false);
    expect(p.maintainers.names.some((n) => n.suspicious)).toBe(true);
    expect(p.maintainers.names.every((n) => n.name.length <= 100)).toBe(true);
    expect(p.repository.declared_url?.length ?? 0).toBeLessThanOrEqual(300);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describe('publisher / publish-history signals', () => {
  const kinds = (doc: unknown): string[] => registrySignals(parseNpm(doc, C)).map((s) => s.kind);

  it('a stable publisher and steady cadence produce no publisher signals', () => {
    const k = kinds(npmDoc(steady(12)));
    expect(k).not.toContain('new_publisher');
    expect(k).not.toContain('dormancy_then_publish');
    expect(k).not.toContain('cadence_change');
  });

  it('a new publisher on the newest version is reported with the publish time, as history', () => {
    const v = [...steady(10), { v: '2.0.0', day: 260, user: 'mallory' }];
    const sig = registrySignals(parseNpm(npmDoc(v), C)).find((s) => s.kind === 'new_publisher')!;
    expect(sig.scope).toBe('publish_history');
    expect(sig.at).toBe(iso(260));
    expect(sig.detail).toMatch(/earlier versions/);
  });

  it('dormancy followed by a publication', () => {
    const v = [...steady(8), { v: '2.0.0', day: 7 * 20 + 800, user: 'alice' }];
    expect(kinds(npmDoc(v))).toContain('dormancy_then_publish');
    expect(kinds(npmDoc(v))).toContain('cadence_change');
  });

  it('a conflicting repository is a current-state signal; provenance missing is informational', () => {
    const sigs = registrySignals(
      parseNpm(npmDoc(steady(5), { repository: { url: 'https://github.com/evil/widget' } }), C),
    );
    expect(sigs.find((s) => s.kind === 'repository_mismatch')?.scope).toBe('current_state');
    expect(sigs.some((s) => s.kind === 'provenance_missing')).toBe(true);
  });

  it('registries without per-version publishers (PyPI) never invent publisher signals', () => {
    const k = registrySignals(
      parsePypi(
        {
          info: { version: '1.0.0' },
          releases: Object.fromEntries(
            steady(12).map((x) => [
              x.v,
              [{ upload_time_iso_8601: iso(x.day), digests: { sha256: 'a' } }],
            ]),
          ),
        },
        C,
      ),
    ).map((s) => s.kind);
    expect(k).not.toContain('new_publisher');
  });

  it('failed lookups yield no signals at all', () => {
    expect(registrySignals({ ...parseNpm(npmDoc(steady(3)), C), status: 'timeout' })).toEqual([]);
  });
});

describe('which packages are looked up', () => {
  it('only publishable, valid-name packages of this repository, never examples or private ones', () => {
    const m = [
      parseManifest('package.json', JSON.stringify({ name: 'widget' }))!,
      parseManifest('examples/a/package.json', JSON.stringify({ name: 'demo' }))!,
      parseManifest(
        'packages/b/package.json',
        JSON.stringify({ name: 'private-one', private: true }),
      )!,
      parseManifest('packages/c/package.json', JSON.stringify({ name: '../evil' }))!,
      parseManifest('Cargo.toml', '[package]\nname = "widget-rs"\nversion = "1.0.0"\n')!,
    ];
    expect(declaredPackages(m).map((p) => `${p.registry}:${p.name}`)).toEqual([
      'npm:widget',
      'crates.io:widget-rs',
    ]);
  });
});

const spec = (over: Partial<FakeSpec> = {}): FakeSpec => {
  const s = goodRepo(over);
  s.files['package.json'] = JSON.stringify({
    name: 'widget',
    version: '1.0.0',
    description: 'Distributed task queue for background jobs',
  });
  return s;
};
const run = (s: FakeSpec, extra: Parameters<typeof analyzeRepository>[1] = {}): Promise<Report> =>
  analyzeRepository(`${s.owner}/${s.repo}`, { fetch: fakeFetch(s), clock: fixedClock, ...extra });

describe('registry intelligence end to end', () => {
  it('confirmed package: facts and no finding; the lookup is made against the registry host only', async () => {
    const s = spec();
    s.registry = { 'registry.npmjs.org/widget': npmDoc(steady(8, 'alice')) };
    const r = await run(s);
    expect(r.registry_intel.status).toBe('analyzed');
    expect(r.registry_intel.packages[0]?.repository.match).toBe('confirmed');
    expect(r.facts.find((f) => f.id === 'registry.repository_match')?.value).toBe('confirmed');
    expect(r.facts.find((f) => f.id === 'registry.lookup_complete')?.value).toBe(true);
    expect(s.registryRequests.every((u) => u.startsWith('https://registry.npmjs.org/'))).toBe(true);
    expect(
      r.findings.some((f) => f.category === 'registry' && /different source/.test(f.title)),
    ).toBe(false);
  });

  it('a package pointing at another repository becomes a medium finding and a conflicting fact', async () => {
    const s = spec();
    s.registry = {
      'registry.npmjs.org/widget': npmDoc(steady(8), {
        repository: { url: 'https://github.com/evil/widget' },
      }),
    };
    const r = await run(s);
    expect(r.facts.find((f) => f.id === 'registry.repository_match')?.value).toBe('conflicting');
    expect(r.findings.find((f) => f.category === 'registry')?.severity).toBe('medium');
  });

  for (const [label, fail, status] of [
    ['429', 429, 'rate_limited'],
    ['500', 500, 'server_error'],
    ['timeout', 'slow', 'timeout'],
    ['wrong content type', 'html', 'malformed'],
    ['broken JSON', 'broken', 'malformed'],
  ] as const)
    it(`${label} is a diagnostic and an unknown fact, never a clean result`, async () => {
      const s = spec();
      s.registry = { 'registry.npmjs.org/widget': npmDoc(steady(8)) };
      s.registryFail = { 'registry.npmjs.org/widget': fail };
      const r = await run(s);
      expect(r.registry_intel.packages[0]?.status).toBe(status);
      expect(r.diagnostics.some((d) => d.code === 'registry_lookup_failed')).toBe(true);
      expect(r.facts.find((f) => f.id === 'registry.lookup_complete')?.value).toBe(false);
      expect(r.facts.find((f) => f.id === 'registry.repository_match')?.value).toBe('unknown');
      expect(r.facts.some((f) => f.id === 'registry.publisher_stable')).toBe(false);
    });

  it('a missing package is "not_found" and the repository match stays unknown', async () => {
    const r = await run(spec());
    expect(r.registry_intel.packages[0]?.status).toBe('not_found');
    expect(r.facts.find((f) => f.id === 'registry.repository_match')?.value).toBe('unknown');
  });

  it('--no-registry makes no registry request and leaves the section disabled', async () => {
    const s = spec();
    const r = await run(s, { registry: false });
    expect(r.registry_intel.status).toBe('disabled');
    expect(s.registryRequests).toEqual([]);
  });

  it('a redirect-style attack cannot leave the allowlisted hosts (client refuses non-allowlisted hosts)', async () => {
    const { HttpClient } = await import('../../src/util/http.js');
    const { REGISTRY_HOSTS } = await import('../../src/collectors/registry.js');
    const c = new HttpClient({
      allowedHosts: REGISTRY_HOSTS,
      retryDelayMs: 0,
      fetch: async (url) =>
        String(url).startsWith('https://registry.npmjs.org/')
          ? new Response('', { status: 302, headers: { location: 'http://127.0.0.1:8080/admin' } })
          : new Response('should never be reached', { status: 200 }),
    });
    await expect(c.request('https://registry.npmjs.org/widget')).rejects.toThrow(
      /refusing redirect/,
    );
    await expect(c.request('https://169.254.169.254/latest/meta-data')).rejects.toThrow(
      /non-allowlisted/,
    );
  });
});

describe('regressions found by real registry probes', () => {
  it('a Cargo crate with publish = false is not a published package (ripgrep fuzz harness)', () => {
    const fuzz = parseManifest(
      'fuzz/Cargo.toml',
      '[package]\nname = "fuzz"\nversion = "0.0.1"\npublish = false\n',
    )!;
    expect(fuzz.isPrivate).toBe(true);
    const lib = parseManifest(
      'crates/g/Cargo.toml',
      '[package]\nname = "globset"\nversion = "1.0.0"\n',
    )!;
    expect(declaredPackages([fuzz, lib]).map((p) => p.name)).toEqual(['globset']);
    const harness = parseManifest(
      'fuzz/Cargo.toml',
      '[package]\nname = "other"\nversion = "1.0.0"\n',
    )!;
    expect(declaredPackages([harness])).toEqual([]); // fuzz/ directories are never publication candidates
  });

  it('a dormancy that ended years ago is history, not a signal; a recent one is', () => {
    const old = parseNpm(
      npmDoc([
        ...steady(6),
        { v: '2.0.0', day: 5 * 20 + 500, user: 'alice' },
        ...steady(6).map((x, i) => ({ v: `3.0.${i}`, day: 700 + i * 20, user: 'alice' })),
      ]),
      { ...C, observedAt: '2030-01-01T00:00:00Z' },
    );
    expect(registrySignals(old).map((s) => s.kind)).not.toContain('dormancy_then_publish');
    const fresh = parseNpm(
      npmDoc([...steady(6), { v: '2.0.0', day: 5 * 20 + 500, user: 'alice' }]),
      { ...C, observedAt: iso(5 * 20 + 520) },
    );
    expect(registrySignals(fresh).map((s) => s.kind)).toContain('dormancy_then_publish');
  });
});
