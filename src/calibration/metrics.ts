import type { CAPABILITIES } from '../analysis/types.js';
import type { Report } from '../report/schema.js';
import type { Label, Tri } from './schema.js';
// Tri is still used by disagreements()

/**
 * Pure evaluation of analyzer reports against labels. Nothing here touches the network or the filesystem.
 * Principles: unknown/disputed labels are excluded and counted (never silently scored); every metric carries its
 * sample size; small samples are flagged rather than hidden behind a single percentage.
 */

export interface Counts {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  /** Labelled yes/no pairs that entered the metric. */
  n: number;
  /** Pairs left out because the label was unknown or disputed. */
  excluded: number;
}

export interface Prf extends Counts {
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export const emptyCounts = (): Counts => ({ tp: 0, fp: 0, fn: 0, tn: 0, n: 0, excluded: 0 });

export function addBinary(c: Counts, predicted: boolean, label: string): void {
  if (label !== 'yes' && label !== 'no') {
    c.excluded++;
    return;
  }
  const truth = label === 'yes';
  c.n++;
  if (predicted && truth) c.tp++;
  else if (predicted && !truth) c.fp++;
  else if (!predicted && truth) c.fn++;
  else c.tn++;
}

const ratio = (a: number, b: number): number | null => (b === 0 ? null : a / b);

export function prf(c: Counts): Prf {
  const precision = ratio(c.tp, c.tp + c.fp);
  const recall = ratio(c.tp, c.tp + c.fn);
  const f1 =
    precision === null || recall === null || precision + recall === 0
      ? null
      : (2 * precision * recall) / (precision + recall);
  return { ...c, precision, recall, f1 };
}

/** One scored probability-like prediction: how confident the analyzer was and whether it was right. */
export interface ConfidencePoint {
  confidence: number;
  correct: boolean;
}

export interface CalibrationBin {
  range: [number, number];
  n: number;
  meanConfidence: number | null;
  accuracy: number | null;
}

export interface CalibrationSummary {
  n: number;
  bins: CalibrationBin[];
  /** Expected calibration error: sample-weighted mean |accuracy - confidence| over bins. null if n = 0. */
  ece: number | null;
  /** Brier score (lower is better; always-0.5 scores 0.25). */
  brier: number | null;
}

export function calibration(points: ConfidencePoint[], binCount = 5): CalibrationSummary {
  const bins: { range: [number, number]; pts: ConfidencePoint[] }[] = Array.from(
    { length: binCount },
    (_, i) => ({ range: [i / binCount, (i + 1) / binCount] as [number, number], pts: [] }),
  );
  for (const p of points) {
    const c = Math.max(0, Math.min(1, p.confidence));
    bins[Math.min(binCount - 1, Math.floor(c * binCount))]!.pts.push(p);
  }
  const out: CalibrationBin[] = bins.map((b) => ({
    range: b.range,
    n: b.pts.length,
    meanConfidence: b.pts.length
      ? b.pts.reduce((a, p) => a + p.confidence, 0) / b.pts.length
      : null,
    accuracy: b.pts.length ? b.pts.filter((p) => p.correct).length / b.pts.length : null,
  }));
  const n = points.length;
  const ece =
    n === 0
      ? null
      : out.reduce(
          (a, b) => a + (b.n / n) * Math.abs((b.accuracy ?? 0) - (b.meanConfidence ?? 0)),
          0,
        );
  const brier =
    n === 0 ? null : points.reduce((a, p) => a + (p.confidence - (p.correct ? 1 : 0)) ** 2, 0) / n;
  return { n, bins: out, ece, brier };
}

// ---- predictions extracted from a report -------------------------------------------------------------------------------

type CapabilityName = (typeof CAPABILITIES)[number];

export interface Prediction {
  artifact: { value: string; confidence: number; alternatives: string[] };
  domain: { value: string; confidence: number; alternatives: string[] };
  capabilities: Partial<Record<CapabilityName, { predicted: boolean; confidence: number }>>;
  automaticHooks: boolean;
  persistence: boolean;
  secrets: boolean;
  sourceCoverage: number;
}

/** DIRECT and INFERRED observations count as predictions; POSSIBLE is deliberately weak and is not a prediction. */
export function predictionFrom(r: Report): Prediction {
  const caps: Prediction['capabilities'] = {};
  for (const s of r.code_analysis.capabilities.summary) {
    const predicted = s.observed && s.mode !== 'POSSIBLE';
    caps[s.capability] = { predicted, confidence: predicted ? s.confidence : 0 };
  }
  return {
    artifact: {
      value: r.identity.artifact_type,
      confidence: r.identity.artifact_confidence,
      alternatives: r.identity.artifact_alternatives,
    },
    domain: {
      value: r.identity.domain,
      confidence: r.identity.confidence,
      alternatives: r.identity.alternatives.map((a) => a.canonical_type),
    },
    capabilities: caps,
    automaticHooks: r.code_analysis.execution.hooks.some((h) => h.runs_for_dependents),
    persistence: r.code_analysis.persistence.observed,
    secrets: r.code_analysis.secrets.scored_count > 0,
    sourceCoverage: r.code_analysis.scan.source_coverage,
  };
}

export interface Case {
  label: Label;
  prediction: Prediction;
}

export interface CategoricalResult {
  n: number;
  excluded: number;
  correct: number;
  /** The analyzer answered "unknown": an abstention, neither right nor wrong. */
  abstained: number;
  /** correct / answered (abstentions excluded). */
  accuracy: number | null;
  /** correct / all decided labels (abstentions count as misses). */
  accuracyOverall: number | null;
  /** Correct if the prediction OR one of its listed alternatives is acceptable (diagnostic; not the headline). */
  topKCorrect: number;
  confusion: Record<string, Record<string, number>>;
  calibration: CalibrationSummary;
}

function categorical(
  cases: Case[],
  pick: (c: Case) => {
    truth: string;
    acceptable: string[];
    predicted: string;
    confidence: number;
    alternatives: string[];
  },
): CategoricalResult {
  const confusion: Record<string, Record<string, number>> = {};
  const pts: ConfidencePoint[] = [];
  let n = 0;
  let excluded = 0;
  let correct = 0;
  let abstained = 0;
  let topK = 0;
  for (const c of cases) {
    const p = pick(c);
    if (p.truth === 'unknown' || p.truth === 'disputed') {
      excluded++;
      continue;
    }
    n++;
    if (p.predicted === 'unknown') {
      abstained++;
      continue;
    }
    const ok = p.predicted === p.truth || p.acceptable.includes(p.predicted);
    if (ok) correct++;
    if (ok || p.alternatives.some((a) => a === p.truth || p.acceptable.includes(a))) topK++;
    const row = (confusion[p.truth] ??= {});
    row[p.predicted] = (row[p.predicted] ?? 0) + 1;
    pts.push({ confidence: p.confidence, correct: ok });
  }
  return {
    n,
    excluded,
    correct,
    abstained,
    accuracy: n - abstained ? correct / (n - abstained) : null,
    accuracyOverall: n ? correct / n : null,
    topKCorrect: topK,
    confusion,
    calibration: calibration(pts),
  };
}

export interface Evaluation {
  repositories: number;
  artifact: CategoricalResult;
  domain: CategoricalResult;
  capabilities: Record<string, Prf>;
  /** Capability recall/precision restricted to repositories whose source was mostly scanned (>= 50%) vs not. */
  capabilitiesByCoverage: { high: Prf; low: Prf };
  capabilityConfidence: CalibrationSummary;
  installHooks: Prf;
  persistence: Prf;
  secrets: Prf;
}

export function evaluate(cases: Case[]): Evaluation {
  const caps: Record<string, Counts> = {};
  const byCov = { high: emptyCounts(), low: emptyCounts() };
  const capPts: ConfidencePoint[] = [];
  const hooks = emptyCounts();
  const pers = emptyCounts();
  const sec = emptyCounts();
  for (const { label, prediction } of cases) {
    for (const [name, lab] of Object.entries(label.capabilities)) {
      const pred = prediction.capabilities[name as CapabilityName];
      if (!pred) continue;
      addBinary((caps[name] ??= emptyCounts()), pred.predicted, lab);
      addBinary(prediction.sourceCoverage >= 0.5 ? byCov.high : byCov.low, pred.predicted, lab);
      if (pred.predicted && (lab === 'yes' || lab === 'no'))
        capPts.push({ confidence: pred.confidence, correct: lab === 'yes' });
    }
    addBinary(hooks, prediction.automaticHooks, label.install_hooks.automatic);
    addBinary(pers, prediction.persistence, label.persistence);
    addBinary(sec, prediction.secrets, label.hard_coded_secrets);
  }
  return {
    repositories: cases.length,
    artifact: categorical(cases, ({ label, prediction }) => ({
      truth: label.artifact_type,
      acceptable: label.artifact_also_acceptable,
      predicted: prediction.artifact.value,
      confidence: prediction.artifact.confidence,
      alternatives: prediction.artifact.alternatives,
    })),
    domain: categorical(cases, ({ label, prediction }) => ({
      truth: label.domain,
      acceptable: label.domain_also_acceptable,
      predicted: prediction.domain.value,
      confidence: prediction.domain.confidence,
      alternatives: prediction.domain.alternatives,
    })),
    capabilities: Object.fromEntries(Object.entries(caps).map(([k, v]) => [k, prf(v)])),
    capabilitiesByCoverage: { high: prf(byCov.high), low: prf(byCov.low) },
    capabilityConfidence: calibration(capPts),
    installHooks: prf(hooks),
    persistence: prf(pers),
    secrets: prf(sec),
  };
}

const pct = (x: number | null): string => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);

export function renderMarkdown(title: string, e: Evaluation): string {
  const row = (name: string, r: Prf): string =>
    `| ${name} | ${r.n} | ${r.tp} | ${r.fp} | ${r.fn} | ${r.tn} | ${r.excluded} | ${pct(r.precision)} | ${pct(r.recall)} |`;
  const cat = (name: string, c: CategoricalResult): string =>
    `| ${name} | ${c.n} | ${c.excluded} | ${c.abstained} | ${pct(c.accuracy)} | ${pct(c.accuracyOverall)} | ${c.n ? pct(c.topKCorrect / c.n) : 'n/a'} | ${c.calibration.ece === null ? 'n/a' : c.calibration.ece.toFixed(2)} |`;
  const lines = [
    `### ${title} (${e.repositories} repositories)`,
    '',
    '| Identity | n | excluded | abstained | accuracy (answered) | accuracy (overall) | correct incl. alternatives | ECE |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    cat('artifact type', e.artifact),
    cat('domain', e.domain),
    '',
    '| Detector | n | TP | FP | FN | TN | excluded | precision | recall |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    row('automatic install hooks', e.installHooks),
    row('persistence', e.persistence),
    row('hard-coded secrets', e.secrets),
    ...Object.entries(e.capabilities)
      .sort()
      .map(([k, v]) => row(k, v)),
    row('(all capabilities) scan coverage >= 50%', e.capabilitiesByCoverage.high),
    row('(all capabilities) scan coverage < 50%', e.capabilitiesByCoverage.low),
    '',
    `Capability confidence calibration: n=${e.capabilityConfidence.n}, ECE=${e.capabilityConfidence.ece === null ? 'n/a' : e.capabilityConfidence.ece.toFixed(2)}, Brier=${e.capabilityConfidence.brier === null ? 'n/a' : e.capabilityConfidence.brier.toFixed(2)}`,
    ...e.capabilityConfidence.bins.map(
      (b) =>
        `- confidence ${b.range[0].toFixed(1)}-${b.range[1].toFixed(1)}: n=${b.n}, mean confidence ${pct(b.meanConfidence)}, actually correct ${pct(b.accuracy)}`,
    ),
    '',
  ];
  return lines.join('\n');
}

export interface Disagreement {
  repository: string;
  field: string;
  predicted: string;
  label: string;
  confidence: number | null;
}

/** Every place where a decided label and the analyzer disagree: the reading list for fixing the model. */
export function disagreements(cases: Case[]): Disagreement[] {
  const out: Disagreement[] = [];
  for (const { label, prediction } of cases) {
    const repo = label.repository;
    const art = label.artifact_type;
    if (
      art !== 'unknown' &&
      art !== 'disputed' &&
      prediction.artifact.value !== art &&
      !label.artifact_also_acceptable.includes(prediction.artifact.value as never)
    ) {
      out.push({
        repository: repo,
        field: 'artifact_type',
        predicted: prediction.artifact.value,
        label: art,
        confidence: prediction.artifact.confidence,
      });
    }
    if (
      label.domain !== 'unknown' &&
      label.domain !== 'disputed' &&
      prediction.domain.value !== label.domain &&
      !label.domain_also_acceptable.includes(prediction.domain.value)
    ) {
      out.push({
        repository: repo,
        field: 'domain',
        predicted: prediction.domain.value,
        label: label.domain,
        confidence: prediction.domain.confidence,
      });
    }
    for (const [name, lab] of Object.entries(label.capabilities)) {
      const pred = prediction.capabilities[name as CapabilityName];
      if (!pred || (lab !== 'yes' && lab !== 'no')) continue;
      if (pred.predicted !== (lab === 'yes'))
        out.push({
          repository: repo,
          field: `capability:${name}`,
          predicted: pred.predicted ? 'observed' : 'not observed',
          label: lab,
          confidence: pred.predicted ? pred.confidence : null,
        });
    }
    const bin = (field: string, predicted: boolean, lab: Tri): void => {
      if ((lab === 'yes' || lab === 'no') && predicted !== (lab === 'yes'))
        out.push({
          repository: repo,
          field,
          predicted: String(predicted),
          label: lab,
          confidence: null,
        });
    };
    bin('automatic_install_hooks', prediction.automaticHooks, label.install_hooks.automatic);
    bin('persistence', prediction.persistence, label.persistence);
    bin('hard_coded_secrets', prediction.secrets, label.hard_coded_secrets);
  }
  return out;
}
