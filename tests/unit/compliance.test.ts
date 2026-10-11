import { describe, expect, it } from 'vitest';
import { analyzeRepository } from '../../src/analyze.js';
import { emptyCodeAnalysis } from '../../src/analysis/index.js';
import {
  evaluateApplicability,
  evaluateCondition,
  type ComplianceContext,
  type Condition,
} from '../../src/compliance/applicability.js';
import { LEGAL_DISCLAIMER } from '../../src/compliance/disclaimer.js';
import { detectIndicators } from '../../src/compliance/indicators.js';
import { loadPacks, PackSchema } from '../../src/compliance/packs.js';
import { emptyIntel } from '../../src/deps/intel.js';
import { ReportSchema, type Report } from '../../src/report/schema.js';
import { renderText } from '../../src/report/text.js';
import { fakeFetch, fixedClock, type FakeSpec } from '../helpers/fake-github.js';
import { goodRepo } from '../helpers/scenarios.js';

const ctx = (over: Partial<ComplianceContext> = {}): ComplianceContext => ({
  identity: {
    artifact_type: 'library',
    artifact_confidence: 0.8,
    domain: 'web',
    ecosystem: ['npm'],
  },
  code: emptyCodeAnalysis(),
  intel: emptyIntel(),
  treePaths: ['README.md', 'SECURITY.md'],
  indicators: [],
  scanReliable: true,
  fact: (id) =>
    ({ 'a.true': { value: true, confidence: 0.9 }, 'a.five': { value: 5, confidence: 0.8 } })[id],
  hasPrivateOnlyManifests: false,
  releasesPresent: true,
  dockerfilePresent: false,
  ...over,
});
const ap = (c: Condition | undefined, over: Partial<ComplianceContext> = {}, req: string[] = []) =>
  evaluateApplicability(c, ctx(over), req);

describe('applicability engine', () => {
  it('leaf conditions: artifact type, ecosystem, path, fact comparisons', () => {
    expect(ap({ artifact_type: ['library', 'cli'] }).state).toBe('applicable');
    expect(ap({ artifact_type: 'service' }).state).toBe('not_applicable');
    expect(ap({ ecosystem: 'NPM' }).state).toBe('applicable');
    expect(ap({ path: '^SECURITY\\.md$' }).state).toBe('applicable');
    expect(ap({ path: '^NOPE$' }).state).toBe('not_applicable');
    expect(ap({ fact: { id: 'a.five', gte: 5 } }).state).toBe('applicable');
    expect(ap({ fact: { id: 'a.five', lt: 5 } }).state).toBe('not_applicable');
    expect(ap({ fact: { id: 'a.true', equals: true } }).state).toBe('applicable');
  });

  it('three-valued logic: unknown never becomes false, all/any/not combine correctly', () => {
    const unknownFact: Condition = { fact: { id: 'missing.fact', equals: true } };
    expect(ap(unknownFact).state).toBe('unknown');
    expect(ap({ all: [unknownFact, { artifact_type: 'library' }] }).state).toBe('unknown');
    expect(ap({ all: [unknownFact, { artifact_type: 'service' }] }).state).toBe('not_applicable'); // one definite false decides
    expect(ap({ any: [unknownFact, { artifact_type: 'library' }] }).state).toBe('applicable');
    expect(ap({ any: [unknownFact, { artifact_type: 'service' }] }).state).toBe('unknown');
    expect(ap({ not: unknownFact }).state).toBe('unknown');
    expect(ap({ not: { artifact_type: 'service' } }).state).toBe('applicable');
  });

  it('missing evidence is explained: unknown artifact type, unreliable scan, absent dependency manifests', () => {
    const unknownArtifact = ap(
      { artifact_type: 'library' },
      {
        identity: {
          artifact_type: 'unknown',
          artifact_confidence: 0.2,
          domain: 'unknown',
          ecosystem: [],
        },
      },
    );
    expect(unknownArtifact.state).toBe('unknown');
    expect(unknownArtifact.missing_context).toContain('artifact type');
    const unreliable = ap({ capability: 'PROCESS_EXEC' }, { scanReliable: false });
    expect(unreliable.state).toBe('unknown');
    expect(unreliable.missing_context).toContain('broader code scan');
    expect(ap({ dependency: { name: '^torch$' } }).state).toBe('unknown'); // no dependencies discovered at all
  });

  it('context a repository cannot show caps the answer at potentially_applicable and is listed', () => {
    const r = ap({ artifact_type: 'library' }, {}, [
      'commercial distribution in the EU',
      'organization role',
    ]);
    expect(r.state).toBe('potentially_applicable');
    expect(r.missing_context).toEqual(
      expect.arrayContaining(['commercial distribution in the EU', 'organization role']),
    );
    expect(ap({ context: 'jurisdiction' }).state).toBe('unknown');
    expect(ap({ context: 'jurisdiction' }).missing_context).toContain('jurisdiction');
  });

  it('low-confidence support is potentially_applicable even without declared context', () => {
    const r = ap(
      { artifact_type: 'library' },
      {
        identity: {
          artifact_type: 'library',
          artifact_confidence: 0.4,
          domain: 'web',
          ecosystem: ['npm'],
        },
      },
    );
    expect(r.state).toBe('potentially_applicable');
  });

  it('hostile patterns (invalid or catastrophic-looking regexes) never throw and yield unknown', () => {
    expect(evaluateCondition({ path: '(' }, ctx()).value).toBeNull();
    expect(evaluateCondition({ dependency: { name: '[' } }, ctx()).value).toBeNull();
    const t0 = Date.now();
    evaluateCondition({ path: '^(a+)+$' }, ctx({ treePaths: ['a'.repeat(30) + '!'] }));
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('technical indicators (privacy and AI)', () => {
  const file = (path: string, content: string) => ({
    path,
    content,
    size: content.length,
    role: 'source' as const,
  });
  it('detects personal-data related code, ignores comments, tests and examples', () => {
    const ind = detectIndicators({
      files: [
        file(
          'src/geo.js',
          'navigator.geolocation.getCurrentPosition(cb);\n// navigator.mediaDevices.getUserMedia({video:true})\nconst c = document.cookie;\n',
        ),
        file('tests/geo.test.js', 'navigator.geolocation.getCurrentPosition(cb);\n'),
        file('examples/demo.js', 'posthog.capture("x")\n'),
        file('src/media.js', 'navigator.mediaDevices.getUserMedia({ audio: true });\n'),
      ],
      treePaths: [],
      dependencies: [],
    });
    const cats = new Set(
      ind.filter((i) => i.family === 'privacy').map((i) => `${i.category}:${i.file}`),
    );
    expect(cats).toEqual(
      new Set(['location:src/geo.js', 'cookies:src/geo.js', 'microphone:src/media.js']),
    );
    expect(ind.every((i) => i.confidence > 0 && i.confidence <= 1)).toBe(true);
  });

  it('detects AI/ML from dependencies and model files, not from the word "model" alone', () => {
    const dep = (name: string) =>
      ({ package: { name }, context: 'primary', relationship: 'runtime' }) as never;
    const ind = detectIndicators({
      files: [file('src/app.js', 'const model = { name: "user" };\nmodel.predict = 1;\n')],
      treePaths: ['weights/llama.safetensors', 'tests/fixtures/tiny.onnx', 'models/readme.md'],
      dependencies: [dep('torch'), dep('@anthropic-ai/sdk'), dep('lodash')],
    });
    const cats = ind
      .filter((i) => i.family === 'ai')
      .map((i) => `${i.category}:${i.source}`)
      .sort();
    expect(cats).toEqual([
      'llm_client:dependency',
      'ml_framework:dependency',
      'model_weights:path',
    ]);
    expect(ind.find((i) => i.category === 'model_weights')?.file).toBe('weights/llama.safetensors'); // fixture ignored
  });

  it('development and auxiliary dependencies do not count as shipped analytics/AI', () => {
    const dev = {
      package: { name: 'torch' },
      context: 'primary',
      relationship: 'development',
    } as never;
    const aux = {
      package: { name: 'mixpanel' },
      context: 'auxiliary',
      relationship: 'runtime',
    } as never;
    expect(detectIndicators({ files: [], treePaths: [], dependencies: [dev, aux] })).toEqual([]);
  });
});

describe('regulatory packs', () => {
  it('load as versioned data with a digest, indicative status and the engine methodology', () => {
    const packs = loadPacks(undefined, '0.4');
    expect(packs.map((p) => `${p.pack.pack}@${p.pack.version}`).sort()).toEqual([
      'eu-ai-act@0.1.0',
      'eu-cra@0.1.0',
    ]);
    for (const p of packs) {
      expect(p.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(p.pack.status).toBe('indicative');
      expect(p.pack.requires_context.length).toBeGreaterThan(0);
    }
    expect(() => loadPacks(undefined, '9.9')).toThrow(/methodology/);
  });

  it('a pack cannot claim to be anything but indicative and must declare missing context', () => {
    const base = loadPacks(undefined, '0.4')[0]!.pack;
    expect(PackSchema.safeParse({ ...base, status: 'binding' }).success).toBe(false);
    expect(PackSchema.safeParse({ ...base, requires_context: [] }).success).toBe(false);
    expect(PackSchema.safeParse({ ...base, legal_verdict: 'compliant' }).success).toBe(false);
  });
});

async function run(
  spec: FakeSpec,
  extra: Parameters<typeof analyzeRepository>[1] = {},
): Promise<Report> {
  return analyzeRepository(`${spec.owner}/${spec.repo}`, {
    fetch: fakeFetch(spec),
    clock: fixedClock,
    ...extra,
  });
}
const cra = (r: Report) => r.regulatory.packs.find((p) => p.pack === 'eu-cra')!;
const aiAct = (r: Report) => r.regulatory.packs.find((p) => p.pack === 'eu-ai-act')!;

describe('regulatory readiness in the report', () => {
  it('CRA: potentially applicable (never "applicable"), indicators from real evidence, no legal verdict', async () => {
    const r = await run(goodRepo());
    expect(ReportSchema.safeParse(r).success).toBe(true);
    const p = cra(r);
    expect(p.applicability.state).toBe('potentially_applicable');
    expect(p.applicability.missing_context.join(' ')).toMatch(/commercial activity/);
    expect(p.legal_determination).toBe('not_provided');
    const by = Object.fromEntries(p.indicators.map((i) => [i.id, i.status]));
    expect(by['cra.vulnerability-disclosure-policy']).toBe('observed');
    expect(by['cra.support-information']).toBe('not_observed');
    expect(by['cra.update-release-process']).toBe('observed');
    expect(['observed', 'partial']).toContain(by['cra.dependency-inventory']);
    expect(
      p.summary.observed + p.summary.partial + p.summary.not_observed + p.summary.unknown,
    ).toBe(p.indicators.length);
    expect(r.regulatory.disclaimer).toBe(LEGAL_DISCLAIMER);
  });

  it('AI Act: not applicable to an ordinary repository, and then no indicator is evaluated', async () => {
    const r = await run(goodRepo());
    const p = aiAct(r);
    expect(p.applicability.state).toBe('not_applicable');
    expect(p.evaluated).toBe(false);
    expect(p.indicators).toEqual([]);
  });

  it('AI Act: a repository with ML dependencies and model weights becomes potentially applicable, with documentation indicators', async () => {
    const spec = goodRepo();
    spec.files['package.json'] = JSON.stringify({
      name: 'w',
      dependencies: { '@tensorflow/tfjs': '^4.0.0' },
    });
    spec.files['weights/model.safetensors'] = 'x';
    spec.files['MODEL_CARD.md'] = '# Model card';
    spec.files['evals/results.json'] = '{}';
    delete spec.files['package-lock.json'];
    const r = await run(spec);
    const p = aiAct(r);
    expect(p.applicability.state).toBe('potentially_applicable');
    expect(p.applicability.missing_context.join(' ')).toMatch(/risk classification/);
    const by = Object.fromEntries(p.indicators.map((i) => [i.id, i.status]));
    expect(by['ai.model-documentation']).toBe('observed');
    expect(by['ai.evaluation-artifacts']).toBe('observed');
    expect(by['ai.dataset-provenance']).toBe('not_observed');
    expect(r.facts.find((f) => f.id === 'ai.model_weights.observed')?.value).toBe(true);
    expect(r.regulatory.indicators.some((i) => i.category === 'model_weights')).toBe(true);
  });

  it('privacy facts are emitted with provenance; "not observed" only when the scan was broad enough', async () => {
    const spec = goodRepo();
    spec.files['src/mod0.ts'] =
      'export const c = document.cookie;\nnavigator.geolocation.watchPosition(f);\n';
    const r = await run(spec);
    expect(r.facts.find((f) => f.id === 'privacy.cookies.observed')).toMatchObject({ value: true });
    expect(r.facts.find((f) => f.id === 'privacy.location.observed')).toMatchObject({
      value: true,
    });
    expect(r.facts.find((f) => f.id === 'privacy.camera.observed')?.value).toBe(false);
    const noScan = await run(goodRepo(), { codeScan: false });
    expect(noScan.facts.some((f) => f.id.startsWith('privacy.') && f.value === false)).toBe(false);
  });

  it('--no-compliance leaves the section empty but still carries the disclaimer, and changes the config digest', async () => {
    const on = await run(goodRepo());
    const off = await run(goodRepo(), { compliance: false });
    expect(off.regulatory.packs).toEqual([]);
    expect(off.regulatory.disclaimer).toBe(LEGAL_DISCLAIMER);
    expect(on.methodology.config_digest).not.toBe(off.methodology.config_digest);
    expect(off.facts.some((f) => f.id.startsWith('privacy.') || f.id.startsWith('ai.'))).toBe(
      false,
    );
  });

  it('text output states the limits and never declares compliance or violation', async () => {
    const text = renderText(await run(goodRepo()), { ascii: true });
    expect(text).toMatch(/REGULATORY READINESS \(technical indicators only; not legal advice\)/);
    expect(text).toMatch(/legal determination: not provided/);
    expect(text).toContain('does not provide legal advice');
    expect(text).not.toMatch(/\b(?:CRA|AI Act)[- ](?:compliant|non-compliant|violation)\b/i);
    expect(text).not.toMatch(/is compliant|are compliant|violates/i);
  });

  it('is deterministic for identical inputs', async () => {
    const a = await run(goodRepo());
    const b = await run(goodRepo());
    expect(a.integrity.report_sha256).toBe(b.integrity.report_sha256);
  });
});

describe('pack loading safety', () => {
  it('refuses a pack whose pattern could backtrack catastrophically (patterns meet repository-controlled paths)', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const root = mkdtempSync(join(tmpdir(), 'rr-pack-'));
    try {
      mkdirSync(join(root, 'standards', 'regulatory'), { recursive: true });
      const good = readFileSync(
        join(process.cwd(), 'standards', 'regulatory', 'eu-cra.yaml'),
        'utf8',
      );
      const bad = good.replace(
        /observed_when: \{ path: [^\n]{0,300}SUPPORTED_VERSIONS[^\n]{0,200}\}/,
        () => "observed_when: { path: '^(a+)+$' }", // a function: "$'" would be a replacement pattern
      );
      expect(bad).not.toBe(good);
      writeFileSync(join(root, 'standards', 'regulatory', 'bad.yaml'), bad);
      expect(() => loadPacks(root, '0.4')).toThrow(/unsafe or invalid path pattern/);
    } finally {
      rmSync(join(root, 'standards', 'regulatory', 'bad.yaml'), { force: true });
      rmSync(join(root, 'standards', 'regulatory'), { recursive: true, force: true });
      rmSync(join(root, 'standards'), { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
