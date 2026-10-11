import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeRepository } from '../../src/analyze.js';
import { EXIT, main } from '../../src/cli.js';
import {
  buildRepositoryModel,
  MODEL_LIMITS,
  RepositoryModelSchema,
} from '../../src/model/index.js';
import { diffReports, renderDiffText } from '../../src/report/diff.js';
import type { Report } from '../../src/report/schema.js';
import { ProfileSchema } from '../../src/scoring/types.js';
import { evaluateBlocks } from '../../src/scoring/policy.js';
import { installerRepo } from '../helpers/code-scenarios.js';
import { fakeFetch, fixedClock, type FakeSpec } from '../helpers/fake-github.js';
import { goodRepo } from '../helpers/scenarios.js';

const run = (
  spec: FakeSpec,
  extra: Parameters<typeof analyzeRepository>[1] = {},
): Promise<Report> =>
  analyzeRepository(`${spec.owner}/${spec.repo}`, {
    fetch: fakeFetch(spec),
    clock: fixedClock,
    ...extra,
  });

describe('policy-as-code blocks', () => {
  it('the enterprise profile blocks install-time remote execution and a high-severity execution finding', async () => {
    const r = await run(installerRepo(), { profile: 'enterprise' });
    const ids = r.policy.block_violations.map((b) => b.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'no-install-time-remote-execution',
        'no-high-severity-execution-finding',
      ]),
    );
    expect(r.policy.blocks_evaluated).toBe(3);
    expect(
      r.policy.block_violations.find((b) => b.id === 'no-install-time-remote-execution')?.evidence
        .length,
    ).toBeGreaterThan(0);
  });

  it('a benign repository passes the same blocks; SBOM-required fires only on a decided "no SBOM"', async () => {
    const good = await run(goodRepo(), { profile: 'enterprise' });
    expect(good.policy.block_violations.map((b) => b.id)).not.toContain(
      'no-install-time-remote-execution',
    );
    const noSbom = goodRepo();
    delete noSbom.files['sbom.json'];
    const r = await run(noSbom, { profile: 'enterprise' });
    expect(r.policy.block_violations.map((b) => b.id)).toContain('sbom-required');
    const disabled = await run(noSbom, { profile: 'enterprise', sbom: false });
    expect(disabled.policy.block_violations.map((b) => b.id)).not.toContain('sbom-required'); // unknown is not a violation
  });

  it('unknown fails closed only when the block says so', () => {
    const profile = ProfileSchema.parse({
      id: 't',
      version: '1',
      title: 'T',
      description: 'd',
      block: [
        {
          id: 'strict',
          description: 'needs the SBOM fact',
          when: { fact: { id: 'deps.sbom.present', equals: true } },
          on_unknown: 'block',
        },
        {
          id: 'lenient',
          description: 'needs the SBOM fact',
          when: { fact: { id: 'deps.sbom.present', equals: true } },
        },
      ],
    });
    const ctx = {
      fact: () => undefined,
      identity: { artifact_type: 'x', artifact_confidence: 1, domain: 'x', ecosystem: [] },
      treePaths: [],
      indicators: [],
      scanReliable: true,
    } as never;
    expect(evaluateBlocks(profile.block, ctx).map((b) => [b.id, b.reason])).toEqual([
      ['strict', 'undecidable'],
    ]);
  });

  it('a block cannot be smuggled in with unknown keys', () => {
    expect(
      ProfileSchema.safeParse({
        id: 't',
        version: '1',
        title: 'T',
        description: 'd',
        block: [{ id: 'abc', description: 'long enough', when: { path: 'x' }, run: 'rm -rf /' }],
      }).success,
    ).toBe(false);
  });
});

describe('CLI: --enforce-profile with blocks, diff and model', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rr-cli-'));
    delete process.env['GITHUB_TOKEN'];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });
  const cli = async (args: string[], spec: FakeSpec = goodRepo()) => {
    vi.stubGlobal('fetch', fakeFetch(spec));
    let out = '';
    let err = '';
    const code = await main(
      args,
      (s) => (out += s),
      (s) => (err += s),
    );
    return { code, out, err };
  };

  it('exits with the policy code when an enforced block fires, and not when it is only advisory', async () => {
    const spec = installerRepo();
    const advisory = await cli(['analyze', 'acme/widget', '--profile', 'enterprise'], spec);
    expect(advisory.code).not.toBe(EXIT.POLICY);
    expect(advisory.out).toMatch(/POLICY BLOCKS/);
    const enforced = await cli(
      ['analyze', 'acme/widget', '--profile', 'enterprise', '--enforce-profile'],
      spec,
    );
    expect(enforced.code).toBe(EXIT.POLICY);
  });

  it('diff compares two saved reports and says what changed', async () => {
    const before = await run(goodRepo());
    const spec = goodRepo();
    spec.files['package.json'] = JSON.stringify({
      name: 'widget',
      dependencies: { bullmq: '^5.0.0', leftpad: '1.3.0' },
    });
    spec.files['package-lock.json'] = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'node_modules/bullmq': { version: '5.2.0' },
        'node_modules/leftpad': { version: '1.3.0' },
      },
    });
    spec.osvVulns = { leftpad: ['GHSA-new'] };
    const after = await run(spec);
    const a = join(dir, 'a.json');
    const b = join(dir, 'b.json');
    writeFileSync(a, JSON.stringify(before));
    writeFileSync(b, JSON.stringify(after));
    const r = await cli(['diff', a, b, '--format', 'json']);
    expect(r.code).toBe(EXIT.OK);
    const d = JSON.parse(r.out) as ReturnType<typeof diffReports>;
    const cats = d.changes.map((c) => `${c.category}:${c.subject}`);
    expect(cats).toEqual(
      expect.arrayContaining([
        'dependency_added:npm:leftpad',
        'dependency_removed:npm:redis',
        'dependency_version_changed:npm:bullmq',
        'vulnerability_added:npm:leftpad GHSA-new',
      ]),
    );
    expect(d.from.tool_version).toBe(d.to.tool_version);
    const text = renderDiffText(d);
    expect(text).toMatch(/dependency_added \(1\)/);
  });

  it('diff warns when methodologies or schemas differ and tolerates an older report without sections', () => {
    const d = diffReports(
      {
        schema_version: '0.2',
        subject: { owner: 'a', repo: 'b' },
        methodology: { version: '0.2' },
      },
      {
        schema_version: '0.4',
        subject: { owner: 'a', repo: 'b' },
        methodology: { version: '0.4' },
      },
    );
    expect(d.caveats.join(' ')).toMatch(/schema versions differ/);
    expect(d.caveats.join(' ')).toMatch(/methodology or rule set differs/);
    expect(d.changes).toEqual([]);
    expect(diffReports(null, 5).changes).toEqual([]);
  });

  it('model refuses reports of another schema and summarizes a current one', async () => {
    const r = await run(goodRepo());
    const f = join(dir, 'r.json');
    writeFileSync(f, JSON.stringify(r));
    const ok = await cli(['model', f]);
    expect(ok.code).toBe(EXIT.OK);
    expect(ok.out).toMatch(/entities: \d+/);
    const old = join(dir, 'old.json');
    writeFileSync(old, JSON.stringify({ schema_version: '0.2' }));
    expect((await cli(['model', old])).code).toBe(EXIT.USAGE);
  });
});

describe('unified repository model', () => {
  it('projects dependencies, execution, capabilities and findings onto entities and relationships with consistent references', async () => {
    const r = await run(installerRepo());
    const m = buildRepositoryModel(r);
    expect(RepositoryModelSchema.safeParse(m).success).toBe(true);
    const kinds = new Set(m.entities.map((e) => e.kind));
    for (const k of [
      'Repository',
      'Manifest',
      'Package',
      'Script',
      'ExecutionNode',
      'Capability',
      'File',
      'Finding',
    ])
      expect(kinds.has(k as never), k).toBe(true);
    const ids = new Set(m.entities.map((e) => e.id));
    for (const rel of m.relationships) {
      expect(ids.has(rel.from), `${rel.type} from ${rel.from}`).toBe(true);
      expect(ids.has(rel.to), `${rel.type} to ${rel.to}`).toBe(true);
    }
    expect(m.relationships.some((x) => x.type === 'DEPENDS_ON')).toBe(true);
    expect(m.relationships.some((x) => x.type === 'EXECUTES')).toBe(true);
    expect(m.entities.length).toBeLessThanOrEqual(MODEL_LIMITS.entities);
  });

  it('has a place for releases and maintainers without inventing data', async () => {
    const m = buildRepositoryModel(await run(goodRepo()));
    expect(m.entities.some((e) => e.kind === 'Release')).toBe(true);
    expect(m.entities.some((e) => e.kind === 'Maintainer')).toBe(true);
    const bare = buildRepositoryModel(await run(goodRepo({ releases: [] })));
    expect(bare.entities.some((e) => e.kind === 'Release')).toBe(false);
  });
});
