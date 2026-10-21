import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { classifyArtifactProvenance } from '../../src/registry/artifacts/provenance.js';
import { evaluateCase, summarizeEvaluator } from '../../src/calibration/evaluator.js';
import { readFileSync } from 'node:fs';

const detector = { required_evidence: [], applicable_mechanisms: ['artifact_behavior_change'] as const, out_of_scope_mechanisms: ['source_code_semantic_sabotage'] as const };
const base = { artifact_available: true, artifact_provenance_verified: true, registry_history_available: true, dependency_history_available: true, behavioral_delta_available: true };
describe('incident evaluator v2', () => {
  it('scores only evaluable settled labels and keeps abstentions separate', () => {
    const rows = [
      { result: evaluateCase({ ...base, label_status: 'known_incident', incident_mechanism: 'artifact_behavior_change' }, detector), observed: true },
      { result: evaluateCase({ ...base, label_status: 'known_benign', incident_mechanism: 'artifact_behavior_change' }, detector), observed: false },
      { result: evaluateCase({ ...base, label_status: 'insufficient_evidence', incident_mechanism: 'unknown' }, detector), observed: false },
      { result: evaluateCase({ ...base, label_status: 'known_incident', incident_mechanism: 'source_code_semantic_sabotage' }, detector), observed: false },
    ];
    const summary = summarizeEvaluator(rows);
    expect(summary.metrics).toMatchObject({ tp: 1, tn: 1, fp: 0, fn: 0, total: 2 });
    expect(summary.not_evaluable).toBe(1); expect(summary.not_applicable).toBe(1); expect(summary.metrics.recall).toBe(1);
  });
  it('unknown mechanism cannot hide a miss', () => {
    const r = evaluateCase({ ...base, label_status: 'known_incident', incident_mechanism: 'unknown' }, detector);
    expect(r.evaluability).toBe('evaluable_positive');
    expect(summarizeEvaluator([{ result: r, observed: false }]).metrics.fn).toBe(1);
  });
  it('distinguishes provenance classes and confidence', () => {
    const bytes = new TextEncoder().encode('fixture');
    const digest = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    expect(classifyArtifactProvenance({ source: 'fixture', identifier: 'x', bytes, expectedDigest: digest, kind: 'reproducible_fixture' }).digest_verification).toBe('verified');
    expect(classifyArtifactProvenance({ source: 'mirror', identifier: 'x', bytes, kind: 'third_party_mirror' }).provenance_class).toBe('third_party_mirror');
    expect(classifyArtifactProvenance({ source: 'synthetic', identifier: 'x', bytes, kind: 'synthetic_fixture' }).source_confidence).toBe(0);
  });
  it('keeps the future v4 format empty and Gate 14 manual', () => {
    const schema = JSON.parse(readFileSync('calibration/incidents-v4/schema.json', 'utf8')) as { required: string[] };
    expect(schema.required).toEqual(expect.arrayContaining(['incident_mechanism', 'label_status', 'detector_applicability', 'human_review_status']));
    expect(readFileSync('scripts/check-release-gates.mjs', 'utf8')).toContain("'MANUAL'");
    const review = JSON.parse(readFileSync('calibration/review-v2/index.json', 'utf8')) as { packets: { packet: string }[] };
    expect(review.packets).toHaveLength(9);
    for (const item of review.packets) {
      const packet = readFileSync(`calibration/review-v2/${item.packet}`, 'utf8');
      expect(packet).not.toContain('known_incident');
      expect(packet).not.toContain('known_benign');
    }
  });
});
