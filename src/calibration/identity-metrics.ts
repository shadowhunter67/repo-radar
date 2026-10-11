import type { Case } from './metrics.js';

/**
 * Identity v2 evaluation that does not hide behind accuracy-when-answered. Every repository with a decided label is exactly
 * one of: correct, wrong, `unknown` (the model abstained) or `ambiguous` (the model answered but said its top candidates
 * are close). Ambiguous answers are scored like any other answer and also counted separately.
 */
export interface IdentityV2Metrics {
  n: number;
  correct: number;
  wrong: number;
  unknown: number;
  ambiguousAnswers: number;
  /** correct / n (abstentions count as misses). */
  accuracyOverall: number | null;
  /** correct / (n - unknown). */
  accuracyAnswered: number | null;
  /** The label is the answer or the runner-up (or acceptable alternatives count). */
  top2: number | null;
  /** Expected calibration error of the primary-artifact confidence over answered cases (10 bins). */
  ece: number | null;
  packaging: { n: number; correct: number; accuracy: number | null };
  deployment: { n: number; correct: number; accuracy: number | null };
  interfaces: {
    n: number;
    tp: number;
    fp: number;
    fn: number;
    precision: number | null;
    recall: number | null;
  };
}

const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);

export function evaluateIdentityV2(cases: Case[]): IdentityV2Metrics | undefined {
  const usable = cases.filter((c) => c.prediction.artifactV2);
  if (usable.length === 0) return undefined;
  let n = 0,
    correct = 0,
    unknown = 0,
    ambiguous = 0,
    top2 = 0;
  const pts: { conf: number; ok: boolean }[] = [];
  const pk = { n: 0, correct: 0 };
  const dp = { n: 0, correct: 0 };
  const itf = { tp: 0, fp: 0, fn: 0, n: 0 };
  for (const { label, prediction } of usable) {
    const v2 = prediction.artifactV2!;
    const art = label.artifact_type;
    if (art !== 'unknown' && art !== 'disputed') {
      n++;
      const accept = new Set<string>([art, ...label.artifact_also_acceptable]);
      if (label.artifact_type === 'monorepo' && v2.multiPackage) accept.add(v2.value);
      if (v2.value === 'unknown') unknown++;
      else {
        const ok = accept.has(v2.value);
        if (ok) correct++;
        if (v2.status === 'ambiguous') ambiguous++;
        pts.push({ conf: v2.confidence, ok });
      }
      if (
        v2.value !== 'unknown' &&
        (accept.has(v2.value) || v2.alternatives.slice(0, 1).some((a) => accept.has(a)))
      )
        top2++;
    }
    if (label.packaging && label.packaging !== 'unknown') {
      pk.n++;
      if (
        v2.packaging === label.packaging ||
        label.packaging_also_acceptable.includes(v2.packaging as never)
      )
        pk.correct++;
    }
    if (label.deployment_form && v2.deployment) {
      dp.n++;
      if (
        v2.deployment === label.deployment_form ||
        label.deployment_also_acceptable.includes(v2.deployment as never)
      )
        dp.correct++;
    }
    if (label.interfaces) {
      itf.n++;
      const want = new Set<string>(label.interfaces);
      const got = new Set<string>(v2.interfaces);
      for (const g of got) want.has(g) ? itf.tp++ : itf.fp++;
      for (const w of want) if (!got.has(w)) itf.fn++;
    }
  }
  let ece: number | null = null;
  if (pts.length > 0) {
    ece = 0;
    for (let b = 0; b < 10; b++) {
      const bin = pts.filter(
        (p) => p.conf >= b / 10 && (b === 9 ? p.conf <= 1 : p.conf < (b + 1) / 10),
      );
      if (bin.length === 0) continue;
      const acc = bin.filter((p) => p.ok).length / bin.length;
      const mean = bin.reduce((a, p) => a + p.conf, 0) / bin.length;
      ece += (bin.length / pts.length) * Math.abs(acc - mean);
    }
  }
  return {
    n,
    correct,
    wrong: n - correct - unknown,
    unknown,
    ambiguousAnswers: ambiguous,
    accuracyOverall: ratio(correct, n),
    accuracyAnswered: ratio(correct, n - unknown),
    top2: ratio(top2, n),
    ece,
    packaging: { ...pk, accuracy: ratio(pk.correct, pk.n) },
    deployment: { ...dp, accuracy: ratio(dp.correct, dp.n) },
    interfaces: {
      n: itf.n,
      tp: itf.tp,
      fp: itf.fp,
      fn: itf.fn,
      precision: ratio(itf.tp, itf.tp + itf.fp),
      recall: ratio(itf.tp, itf.tp + itf.fn),
    },
  };
}

const pct = (x: number | null): string => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);

export function renderIdentityV2(m: IdentityV2Metrics): string[] {
  return [
    `Identity v2 detail: n=${m.n}; correct ${m.correct}, wrong ${m.wrong}, unknown (abstained) ${m.unknown}, answered-but-ambiguous ${m.ambiguousAnswers}`,
    `- primary artifact: overall ${pct(m.accuracyOverall)}, answered ${pct(m.accuracyAnswered)}, top-2 ${pct(m.top2)}, ECE ${m.ece === null ? 'n/a' : m.ece.toFixed(2)}`,
    `- packaging: ${pct(m.packaging.accuracy)} (n=${m.packaging.n}); deployment form: ${pct(m.deployment.accuracy)} (n=${m.deployment.n})`,
    `- interfaces (n=${m.interfaces.n}): precision ${pct(m.interfaces.precision)}, recall ${pct(m.interfaces.recall)} (tp ${m.interfaces.tp}, fp ${m.interfaces.fp}, fn ${m.interfaces.fn})`,
    '',
  ];
}
