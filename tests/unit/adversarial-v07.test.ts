import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as pgp from 'openpgp';
import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeRepository } from '../../src/analyze.js';
import { dependencyEvents } from '../../src/registry/dependency-analysis.js';
import { parseCrates, parseNpm, parsePypi } from '../../src/registry/parse.js';
import { renderText } from '../../src/report/text.js';
import { buildTrustGraph } from '../../src/graph/trust.js';
import { FsSnapshotStore } from '../../src/store/snapshots.js';
import { gpgKey, minisignKey, TRUST_LIMITS } from '../../src/trust/config.js';
import { verifyGpgDetached } from '../../src/trust/gpg.js';
import { parseMinisignSignature, verifyMinisign } from '../../src/trust/minisign.js';
import { verifyBundle, type BundleVerifier } from '../../src/trust/sigstore.js';
import { fakeFetch, fixedClock, NOW, type Recorded } from '../helpers/fake-github.js';
import { goodRepo } from '../helpers/scenarios.js';

const DAY = 86_400_000;
const iso = (daysAgo: number): string => new Date(NOW.getTime() - daysAgo * DAY).toISOString();
const C = { name: 'dep', declaredBy: 'DEP-1', observedAt: NOW.toISOString() };
const TOKEN = 'ghp_' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2';

describe('malicious registry metadata', () => {
  it('a packument with tens of thousands of versions is bounded', () => {
    const n = 40_000;
    const times: Record<string, string> = {};
    const versions: Record<string, unknown> = {};
    for (let i = 0; i < n; i++) {
      times[`1.0.${i}`] = iso(n - i);
      versions[`1.0.${i}`] = { _npmUser: { name: 'alice' }, dist: { integrity: 'x' } };
    }
    const t = Date.now();
    const p = parseNpm(
      { 'dist-tags': { latest: '1.0.0' }, time: times, versions },
      { ...C, capVersions: 20 },
    );
    const e = dependencyEvents(p, []);
    expect(Date.now() - t).toBeLessThan(3000);
    expect(p.versions).toHaveLength(20);
    expect(p.versions_total).toBe(n);
    expect(e.events.length).toBeLessThanOrEqual(10);
  });

  it('prototype-pollution keys and odd value types are inert', () => {
    const evil = JSON.parse(
      '{"__proto__":{"polluted":true},"time":{"__proto__":"x","1.0.0":"2025-01-01T00:00:00Z","constructor":5},' +
        '"versions":{"1.0.0":{"_npmUser":"notanobject","dist":[],"maintainers":"x","repository":42,"scripts":{"postinstall":{"a":1}}},' +
        '"__proto__":{"1.0.1":{}},"constructor":{"prototype":{"x":1}}},"dist-tags":{"latest":{"x":1}},"maintainers":[null,5,{"name":["a"]}]}',
    );
    const p = parseNpm(evil, C);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(['ok', 'partial', 'malformed']).toContain(p.status);
    expect(() => dependencyEvents(p, [])).not.toThrow();
    for (const bad of [null, 5, 'str', [], [[]], {}, { info: 5 }, { crate: [] }]) {
      expect(() => parseNpm(bad, C)).not.toThrow();
      expect(() => parsePypi(bad, C)).not.toThrow();
      expect(() => parseCrates(bad, bad, C)).not.toThrow();
    }
  });

  it('control characters, ANSI escapes and bidi overrides in names never reach the terminal', async () => {
    const hostile = [
      'al',
      String.fromCharCode(0x1b),
      '[31mice',
      String.fromCharCode(0x202e, 7, 0),
    ].join('');
    const s = goodRepo({
      registry: Object.fromEntries(
        ['bullmq', 'redis', 'lodash'].map((n) => [
          `registry.npmjs.org/${n}`,
          {
            'dist-tags': { latest: '1.0.7' },
            maintainers: [{ name: hostile }],
            time: Object.fromEntries(
              Array.from({ length: 8 }, (_, i) => [`1.0.${i}`, iso(270 - i * 30)]),
            ),
            versions: Object.fromEntries(
              Array.from({ length: 8 }, (_, i) => [
                `1.0.${i}`,
                { _npmUser: { name: i === 7 ? hostile : 'alice' }, dist: { integrity: 'x' } },
              ]),
            ),
          },
        ]),
      ),
    });
    const r = await analyzeRepository(`${s.owner}/${s.repo}`, {
      fetch: fakeFetch(s),
      clock: fixedClock,
      scorecard: false,
      osv: false,
      depsDev: false,
    });
    const text = renderText(r, { ascii: true, verbose: true });
    expect([...text].some((c) => [0x1b, 0x07, 0x00, 0x202e].includes(c.charCodeAt(0)))).toBe(false);
    const json = JSON.stringify(r);
    const esc = (h: string): string => String.fromCharCode(92) + 'u' + h;
    expect([esc('001b'), esc('202e'), esc('0007')].some((x) => json.includes(x))).toBe(false);
    expect(
      r.dependency_registry_intel.packages.some((p) =>
        p.maintainers.names.some((m) => m.suspicious),
      ),
    ).toBe(true);
  });

  it('impossible publish times (the future, the 1960s, garbage) produce no events', () => {
    const doc = (times: Record<string, string>) => ({
      'dist-tags': { latest: '1.0.7' },
      time: times,
      versions: Object.fromEntries(
        Object.keys(times).map((v, i) => [
          v,
          {
            _npmUser: { name: i >= 6 ? 'mallory' : 'alice' },
            hasInstallScript: i >= 6,
            dist: { integrity: 'x' },
          },
        ]),
      ),
    });
    const times: Record<string, string> = {};
    for (let i = 0; i < 6; i++) times[`1.0.${i}`] = iso(300 - i * 30);
    times['1.0.6'] = '2999-01-01T00:00:00Z';
    times['1.0.7'] = '1969-01-01T00:00:00Z';
    times['1.0.8'] = 'not a date';
    const r = dependencyEvents(parseNpm(doc(times), C), []);
    expect(r.events).toEqual([]);
    expect(r.untimed).toBe(3);
  });

  it('repository URLs of any scheme other than https/GitHub never become a correspondence', () => {
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'git://evil.example/x',
      'ssh://evil.example/x',
      'data:text/html,hi',
    ]) {
      const p = parseNpm(
        {
          'dist-tags': {},
          time: { '1.0.0': iso(10) },
          versions: { '1.0.0': {} },
          repository: { url },
        },
        C,
      );
      expect(p.repository.normalized, url).toBeNull();
    }
  });
});

describe('malicious signature material', () => {
  it('a Sigstore bundle that cannot be serialized (cycles, extreme depth) is skipped, not verified', async () => {
    let called = 0;
    const v: BundleVerifier = {
      trustRoot: 'sigstore_public_good',
      verify: async () => (called++, {}),
    };
    const cyc: Record<string, unknown> = { a: 1 };
    cyc['self'] = cyc;
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 50_000; i++) {
      const next: Record<string, unknown> = {};
      deep['n'] = next;
      deep = next;
    }
    for (const b of [cyc, root]) {
      const r = await verifyBundle(v, b);
      expect(r.state).toBe('verification_skipped_resource_limit');
    }
    expect(called).toBe(0);
  });

  it('random bytes and truncated armor are failures to decide, never a pass', async () => {
    const k = await pgp.generateKey({
      type: 'ecc',
      curve: 'ed25519Legacy',
      userIDs: [{ name: 'x' }],
      format: 'armored',
    });
    const keys = [gpgKey(k.publicKey)];
    const data = Buffer.from('payload');
    const noise = Buffer.from(Array.from({ length: 2000 }, (_, i) => (i * 131 + 7) % 256));
    for (const sig of [
      noise,
      Buffer.from('-----BEGIN PGP SIGNATURE-----\n\nAAAA\n'),
      Buffer.from('-----BEGIN PGP SIGNATURE-----'),
    ]) {
      const v = await verifyGpgDetached({ signature: sig, data, keys, subject: 'x' });
      expect(v.state, sig.subarray(0, 12).toString()).toBe('verification_failed');
    }
  }, 30_000);

  it('oversized key material is refused before anything parses it', () => {
    expect(() => gpgKey('A'.repeat(TRUST_LIMITS.maxKeyBytes + 1))).toThrow(/larger than the limit/);
    expect(() => minisignKey('B'.repeat(TRUST_LIMITS.maxKeyBytes + 1))).toThrow(
      /larger than the limit/,
    );
  });

  it('malformed minisign files of every shape are rejected without throwing', () => {
    const good =
      'untrusted comment: x\n' +
      Buffer.alloc(74).toString('base64') +
      '\ntrusted comment: y\n' +
      Buffer.alloc(64).toString('base64') +
      '\n';
    expect(parseMinisignSignature(good)).toBeUndefined(); // algorithm bytes are zero, not "Ed"
    for (const bad of [
      '',
      'a\nb\nc\nd',
      'untrusted comment:\n!!!\ntrusted comment:\n???',
      'untrusted comment: x\nAAAA\ntrusted comment: y\nAAAA',
      '\u0000'.repeat(100),
    ]) {
      expect(parseMinisignSignature(bad)).toBeUndefined();
      expect(
        verifyMinisign({
          signatureText: bad,
          data: Buffer.from('x'),
          keys: [minisignKey('RWQ' + 'A'.repeat(52))],
          subject: 'x',
        }).state,
      ).not.toBe('verified');
    }
  });
});

describe('secrets never leak through the new subsystems', () => {
  let key: { publicKey: string; privateKey: string };
  beforeAll(async () => {
    const k = await pgp.generateKey({
      type: 'ecc',
      curve: 'ed25519Legacy',
      userIDs: [{ name: 'Bot' }],
      format: 'armored',
    });
    key = { publicKey: k.publicKey, privateKey: k.privateKey };
  }, 30_000);

  it('the GitHub token reaches only api.github.com; keys and the token are absent from report, snapshot and graph', async () => {
    const s = goodRepo({
      files: { ...goodRepo().files, 'scripts/x.sh': 'curl https://get.vendor.io/x | sh' },
      releases: [
        { daysAgo: 2, detail: { tag: 'v1', commit: 'e'.repeat(40), assets: { 'a.zip': 'bytes' } } },
      ],
    });
    const rec: Recorded[] = [];
    const r = await analyzeRepository(`${s.owner}/${s.repo}`, {
      fetch: fakeFetch(s, rec),
      clock: fixedClock,
      scorecard: false,
      token: TOKEN,
      trust: { keys: [gpgKey(key.publicKey), minisignKey('RWQ' + 'A'.repeat(52))] },
      verifyAssets: true,
    });
    for (const x of rec.filter((y) => y.headers['authorization']))
      expect(new URL(x.url).host).toBe('api.github.com');
    expect(rec.some((x) => /registry\.npmjs\.org/.test(x.url))).toBe(true);
    const everything = [
      JSON.stringify(r),
      JSON.stringify(buildTrustGraph(r)),
      renderText(r, { ascii: true, verbose: true }),
    ];
    const dir = mkdtempSync(join(tmpdir(), 'rr-adv-'));
    new FsSnapshotStore(dir).putSnapshot(r);
    const stack = [dir];
    while (stack.length) {
      const d = stack.pop() as string;
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) stack.push(p);
        else everything.push(readFileSync(p, 'utf8'));
      }
    }
    for (const blob of everything) {
      expect(blob).not.toContain(TOKEN);
      expect(blob).not.toContain('BEGIN PGP');
      expect(blob).not.toContain('Bearer');
      expect(blob).not.toContain('RWQAAAAAAAA');
    }
  });

  it('a private key is never accepted as trust material', () => {
    expect(() => gpgKey(key.privateKey)).toThrow(/private key/);
  });
});
