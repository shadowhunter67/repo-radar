import { describe, expect, it } from 'vitest';
import { analyzeRepository } from '../../src/analyze.js';
import type { Hook } from '../../src/analysis/execution.js';
import type { ScannedFile } from '../../src/analysis/types.js';
import { domainDeltas } from '../../src/domains/diff.js';
import { classifyHost, extractDomains, parseHost } from '../../src/domains/extract.js';
import { ExternalDomainsSchema } from '../../src/domains/model.js';
import { compareSnapshots } from '../../src/history/delta.js';
import { evaluateHistoryBlocks } from '../../src/scoring/policy.js';
import type { Report } from '../../src/report/schema.js';
import { fakeFetch, fixedClock, type FakeSpec } from '../helpers/fake-github.js';
import { goodRepo } from '../helpers/scenarios.js';

const file = (
  path: string,
  content: string,
  role: ScannedFile['role'] = 'source',
): ScannedFile => ({
  path,
  content,
  size: content.length,
  role,
});
const hook = (over: Partial<Hook> & { files: string[] }): Hook =>
  ({
    id: 'HOOK-1',
    ecosystem: 'npm',
    name: 'postinstall',
    trigger: 'on install',
    runs_for_dependents: true,
    context: 'install',
    risk: 'none',
    confidence: 0.8,
    analyzed: true,
    capabilities: [],
    chain_ids: [],
    unanalyzed_commands: 0,
    node_ids: [],
    ...over,
  }) as Hook;
const run = (files: ScannedFile[], hooks: Hook[] = []) =>
  extractDomains({ files, hooks, detections: [] });
const byHost = (r: ReturnType<typeof run>, h: string) => r.domains.find((d) => d.hostname === h);

describe('external domain extraction: contexts', () => {
  it('a runtime reference is an external domain in runtime context', () => {
    const r = run([
      file('src/client.ts', "const r = await fetch('https://api.vendor.io/v1/items');"),
    ]);
    expect(ExternalDomainsSchema.safeParse(r).success).toBe(true);
    expect(byHost(r, 'api.vendor.io')).toMatchObject({
      category: 'generic_external',
      strongest_context: 'runtime',
      schemes: ['https'],
    });
  });

  it('a host in a file on an install hook path is install-time with high confidence', () => {
    const r = run(
      [file('scripts/postinstall.js', "download('https://dl.vendor.io/bin/tool.tgz')", 'script')],
      [hook({ files: ['package.json', 'scripts/postinstall.js'] })],
    );
    const d = byHost(r, 'dl.vendor.io');
    expect(d?.strongest_context).toBe('install');
    expect(d?.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('the lifecycle command string itself counts, with the hook context', () => {
    const r = run(
      [],
      [
        hook({
          files: ['package.json'],
          script: 'curl -sSL https://get.vendor.io/install.sh | sh',
        }),
      ],
    );
    expect(byHost(r, 'get.vendor.io')?.strongest_context).toBe('install');
  });

  it('build, CI, container, release, docs, test and metadata contexts', () => {
    const r = run([
      file('Makefile', 'fetch:\n\tcurl -O https://build.vendor.io/a.tgz', 'build'),
      file('.github/workflows/ci.yml', 'run: wget https://ci.vendor.io/x', 'workflow'),
      file('Dockerfile', 'RUN wget https://img.vendor.io/base.tar', 'build'),
      file('scripts/release.sh', 'curl https://pub.vendor.io/upload', 'script'),
      file('docs/guide.md', 'See https://docs.vendor.io/start', 'config'),
      file('tests/e2e/a.test.ts', "fetch('https://test.vendor.io')", 'source'),
      file('package.json', '{"homepage": "https://home.vendor.io"}', 'manifest'),
    ]);
    const ctx = Object.fromEntries(r.domains.map((d) => [d.hostname, d.strongest_context]));
    expect(ctx).toMatchObject({
      'build.vendor.io': 'build',
      'ci.vendor.io': 'ci',
      'img.vendor.io': 'container',
      'pub.vendor.io': 'release',
      'docs.vendor.io': 'docs',
      'test.vendor.io': 'test',
      'home.vendor.io': 'metadata',
    });
    // active domains sort before passive ones
    const active = ['build', 'ci', 'container', 'release'];
    const firstPassive = r.domains.findIndex((d) => !active.includes(d.strongest_context));
    expect(
      r.domains.slice(0, firstPassive).every((d) => active.includes(d.strongest_context)),
    ).toBe(true);
  });

  it('a URL inside a comment is a comment-context reference with low confidence', () => {
    const r = run([
      file(
        'src/a.ts',
        '// see https://commented.vendor.io/docs\nconst x = 1;\n/* also\n https://block.vendor.io/x\n*/',
      ),
      file(
        'scripts/a.sh',
        '# https://hash.vendor.io/x\necho https://live.vendor.io/x # trailing',
        'script',
      ),
    ]);
    expect(byHost(r, 'commented.vendor.io')?.strongest_context).toBe('comment');
    expect(byHost(r, 'block.vendor.io')?.strongest_context).toBe('comment');
    expect(byHost(r, 'hash.vendor.io')?.strongest_context).toBe('comment');
    expect(byHost(r, 'commented.vendor.io')?.confidence).toBeLessThan(0.2);
    expect(byHost(r, 'live.vendor.io')?.strongest_context).toBe('build');
  });

  it('the scheme separator is not mistaken for a comment', () => {
    const r = run([file('src/a.ts', "const u = 'https://notacomment.vendor.io/x';")]);
    expect(byHost(r, 'notacomment.vendor.io')?.strongest_context).toBe('runtime');
  });
});

describe('external domain extraction: filtering and classification', () => {
  it('localhost, loopback and private addresses are counted, not reported as external', () => {
    const r = run([
      file(
        'src/dev.ts',
        [
          "a('http://localhost:3000/x')",
          "b('http://127.0.0.1:8080')",
          "c('http://[::1]:9000/')",
          "d('http://10.1.2.3/x')",
          "e('http://192.168.0.7/x')",
          "f('http://172.16.5.5/x')",
          "g('http://169.254.169.254/latest/meta-data')",
          "h('http://db:5432/x')",
          "i('http://printer.local/x')",
        ].join('\n'),
      ),
    ]);
    expect(r.domains).toEqual([]);
    expect(r.filtered['localhost']).toBe(3);
    expect(r.filtered['private_address']).toBe(6);
  });

  it('the cloud metadata endpoint is a private address with an explicit note', () => {
    expect(classifyHost('169.254.169.254')).toEqual({
      category: 'private_address',
      notes: ['cloud_metadata_endpoint'],
    });
  });

  it('documentation placeholders are filtered', () => {
    const r = run([
      file(
        'src/a.ts',
        "x('https://example.com/a'); y('https://api.example.org'); z('https://foo.test/')",
      ),
    ]);
    expect(r.domains).toEqual([]);
    expect(r.filtered['documentation_example']).toBe(3);
  });

  it('registry, GitHub, telemetry, IP literal and generic hosts get their own category', () => {
    const cat = (h: string) => classifyHost(h).category;
    expect(cat('registry.npmjs.org')).toBe('registry');
    expect(cat('files.pythonhosted.org')).toBe('registry');
    expect(cat('raw.githubusercontent.com')).toBe('github');
    expect(cat('github.com')).toBe('github');
    expect(cat('o123.ingest.sentry.io')).toBe('telemetry');
    expect(cat('telemetry.vendor.io')).toBe('telemetry');
    expect(cat('203.0.113.7')).toBe('ip_literal');
    expect(cat('api.vendor.io')).toBe('generic_external');
  });

  it('a public IP literal is reported; scp-style git remotes yield their host', () => {
    const r = run([
      file(
        'scripts/a.sh',
        'curl http://203.0.113.7:8080/x\ngit clone git@github.com:acme/widget.git',
        'script',
      ),
    ]);
    expect(byHost(r, '203.0.113.7')).toMatchObject({ category: 'ip_literal', ports: [8080] });
    expect(byHost(r, 'github.com')?.category).toBe('github');
  });

  it('a bare host after curl needs a path or port; a file name alone is not a host', () => {
    const r = run([
      file(
        'scripts/a.sh',
        'curl -sSL get.vendor.io/install.sh | sh\ncurl install.sh\nwget -q mirror.vendor.io:8080',
        'script',
      ),
    ]);
    expect(byHost(r, 'get.vendor.io')?.observations[0]?.bare).toBe(true);
    expect(byHost(r, 'mirror.vendor.io')?.ports).toEqual([8080]);
    expect(byHost(r, 'install.sh')).toBeUndefined();
  });

  it('template variables are counted as unparsed, never guessed', () => {
    const r = run([
      file('src/a.ts', "x(`https://${HOST}/a`); y('https://$HOST/b'); z('https://%s/c')"),
    ]);
    expect(r.domains).toEqual([]);
    expect(r.unparsed).toBeGreaterThanOrEqual(3);
  });
});

describe('external domain extraction: hostile input', () => {
  it('internationalized names are normalized, the original is kept, and the ambiguity is informational', () => {
    const cyr = parseHost('https://аpple.com/login'); // Cyrillic a + Latin pple
    expect(cyr?.hostname).toBe('xn--pple-43d.com');
    expect(cyr?.display).toBe('аpple.com');
    expect(cyr?.ambiguity).toBe('mixed_script');
    expect(parseHost('https://xn--80ak6aa92e.com/')?.ambiguity).toBe('punycode');
    expect(parseHost('https://bücher.example.org/')?.ambiguity).toBe('unicode');
    expect(parseHost('https://plain.vendor.io/')?.ambiguity).toBe('none');
    const r = run([file('src/a.ts', "x('https://аpple.com/login')")]);
    expect(r.domains[0]).toMatchObject({ hostname: 'xn--pple-43d.com', ambiguity: 'mixed_script' });
  });

  it('credentials in a URL are dropped from the report', () => {
    const r = run([file('src/a.ts', "x('https://admin:Sup3rS3cret@host.vendor.io/x')")]);
    expect(byHost(r, 'host.vendor.io')?.credentials_in_url).toBe(true);
    expect(JSON.stringify(r)).not.toContain('Sup3rS3cret');
    expect(JSON.stringify(r)).not.toContain('admin:');
  });

  it('huge lines and URL literals stay fast and bounded (no regex blow-up)', () => {
    const huge = 'https://' + 'a'.repeat(200_000) + '.io/x';
    const noise = 'x'.repeat(500_000) + '/'.repeat(100_000);
    const manyDots = 'https://' + 'a.'.repeat(5000) + 'io';
    const started = Date.now();
    const r = run([
      file('src/a.ts', `${huge}\n${noise}\n${manyDots}\ncurl ${'a'.repeat(100_000)}`),
    ]);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.domains.length).toBeLessThanOrEqual(2);
  });

  it('thousands of distinct hosts are capped and reported as a limit', () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `x('https://h${i}.vendor.io/')`);
    const files = Array.from({ length: 80 }, (_, i) =>
      file(`src/f${i}.ts`, lines.slice(i * 60, i * 60 + 60).join('\n')),
    );
    const r = run(files);
    expect(r.domains.length).toBeLessThanOrEqual(300);
    expect(r.domains_total).toBeGreaterThan(300);
    expect(ExternalDomainsSchema.safeParse(r).success).toBe(true);
  });

  it('never makes a request: the module has no network access', async () => {
    // extraction is a pure function of its input; the pipeline test below checks no observed host is contacted
    expect(run([file('src/a.ts', "x('https://never-contacted.vendor.io/')")]).domains).toHaveLength(
      1,
    );
  });
});

// ---- the pipeline and the historical diff -------------------------------------------------------------------------
const NEW_SCRIPT = (url: string) =>
  `const https = require('https');\nhttps.get('${url}', () => {});\n`;
function spec(over: {
  script?: string;
  extra?: Record<string, string>;
  homepage?: string;
}): FakeSpec {
  const base = goodRepo();
  return goodRepo({
    files: {
      ...base.files,
      'package.json': JSON.stringify({
        name: 'widget',
        description: 'Distributed task queue for background jobs',
        ...(over.homepage ? { homepage: over.homepage } : {}),
        scripts: over.script ? { postinstall: 'node scripts/install.js' } : {},
        dependencies: { bullmq: '^5.0.0' },
      }),
      ...(over.script ? { 'scripts/install.js': over.script } : {}),
      ...(over.extra ?? {}),
    },
  });
}
async function analyze(s: FakeSpec): Promise<Report> {
  return analyzeRepository(`${s.owner}/${s.repo}`, {
    fetch: fakeFetch(s),
    clock: fixedClock,
    scorecard: false,
    osv: false,
    depsDev: false,
    registry: false,
  });
}

describe('external domains through the pipeline and the diff', () => {
  it('an install script that refers to a host yields an install-time domain, a fact and a finding', async () => {
    const r = await analyze(spec({ script: NEW_SCRIPT('https://dl.vendor.io/payload') }));
    const d = r.external_domains.domains.find((x) => x.hostname === 'dl.vendor.io');
    expect(d?.strongest_context).toBe('install');
    expect(r.facts.find((f) => f.id === 'domains.install_time.present')?.value).toBe(true);
    expect(r.findings.some((f) => f.title === 'Install-time code refers to an external host')).toBe(
      true,
    );
    for (const f of r.findings.filter((x) => x.id.startsWith('RR-DOM'))) {
      expect(f.intent).toBe('undetermined');
      expect(f.summary).toMatch(/not a connection|informational|looks like|IP address/);
    }
  });

  it('no observed host is ever requested', async () => {
    const s = spec({ script: NEW_SCRIPT('https://never-requested.vendor.io/x') });
    const seen: string[] = [];
    const inner = fakeFetch(s);
    await analyzeRepository(`${s.owner}/${s.repo}`, {
      fetch: async (u, i) => {
        seen.push(String(u));
        return inner(u, i);
      },
      clock: fixedClock,
      scorecard: false,
    });
    expect(seen.some((u) => u.includes('never-requested.vendor.io'))).toBe(false);
  });

  it('a new install-time host between revisions is an event, a risk reason and a history-policy hit', async () => {
    const before = await analyze(spec({}));
    const after = await analyze(spec({ script: NEW_SCRIPT('https://dl.vendor.io/payload') }));
    const diff = compareSnapshots(before, after);
    const d = diff.domains.find((x) => x.hostname === 'dl.vendor.io');
    expect(d).toMatchObject({
      kind: 'introduced',
      significance: 'active',
      certainty: 'observed',
      after: { strongest_context: 'install' },
    });
    const ev = diff.timeline.events.find((e) => e.type === 'external_domain_introduced');
    expect(ev?.subject).toBe('dl.vendor.io');
    expect(ev?.at).not.toBeNull();
    expect(diff.risk.reasons.some((x) => /new external host dl\.vendor\.io/.test(x.text))).toBe(
      true,
    );
    const hits = evaluateHistoryBlocks(
      [
        {
          id: 'no-new-install-domain',
          description: 'no new install-time domain',
          kind: 'new_install_time_domain',
        },
      ],
      diff,
    );
    expect(hits[0]?.subjects).toEqual(['dl.vendor.io']);
  });

  it('a new host that only appears in package metadata is passive: no timeline event', async () => {
    const before = await analyze(spec({}));
    const after = await analyze(spec({ homepage: 'https://docs.vendor.io/start' }));
    const diff = compareSnapshots(before, after);
    const d = diff.domains.find((x) => x.hostname === 'docs.vendor.io');
    expect(d?.significance).toBe('passive');
    expect(diff.timeline.events.some((e) => e.type === 'external_domain_introduced')).toBe(false);
    expect(diff.risk.reasons.some((x) => /docs\.vendor\.io/.test(x.text))).toBe(false);
  });

  it('a removed host and a context change are reported', async () => {
    const withHost = await analyze(spec({ script: NEW_SCRIPT('https://dl.vendor.io/payload') }));
    const without = await analyze(spec({}));
    const gone = compareSnapshots(withHost, without);
    expect(gone.domains.find((x) => x.hostname === 'dl.vendor.io')?.kind).toBe('removed');
    // runtime -> install
    const runtimeOnly = await analyze(
      spec({ extra: { 'src/client.ts': NEW_SCRIPT('https://dl.vendor.io/payload') } }),
    );
    const moved = compareSnapshots(runtimeOnly, withHost);
    const d = moved.domains.find((x) => x.hostname === 'dl.vendor.io');
    expect(d).toMatchObject({ kind: 'context_changed', significance: 'active' });
    expect(d?.before?.strongest_context).toBe('runtime');
    expect(d?.after?.strongest_context).toBe('install');
  });

  it('removal is inconclusive when the earlier scan may simply have missed the file', () => {
    const mk = (hosts: string[]) =>
      ExternalDomainsSchema.parse(
        run(hosts.map((h, i) => file(`src/f${i}.ts`, `x('https://${h}/')`))),
      );
    const a = mk(['one.vendor.io', 'two.vendor.io']);
    const b = mk(['one.vendor.io']);
    expect(domainDeltas(a, b, true).find((x) => x.kind === 'removed')?.certainty).toBe(
      'inconclusive',
    );
    expect(domainDeltas(a, b, false).find((x) => x.kind === 'removed')?.certainty).toBe('observed');
  });

  it('older reports without the section produce no domain deltas', async () => {
    const after = await analyze(spec({ script: NEW_SCRIPT('https://dl.vendor.io/payload') }));
    const legacy = JSON.parse(JSON.stringify(after)) as Record<string, unknown>;
    delete legacy['external_domains'];
    expect(compareSnapshots(legacy, after).domains).toEqual([]);
  });

  it('--no-domains leaves the section disabled and emits no domain facts', async () => {
    const s = spec({ script: NEW_SCRIPT('https://dl.vendor.io/payload') });
    const r = await analyzeRepository(`${s.owner}/${s.repo}`, {
      fetch: fakeFetch(s),
      clock: fixedClock,
      scorecard: false,
      domains: false,
    });
    expect(r.external_domains.status).toBe('disabled');
    expect(r.facts.some((f) => f.id.startsWith('domains.'))).toBe(false);
  });
});
