import type { Report } from '../report/schema.js';
import { addBinary, emptyCounts, prf, type Counts, type Prf } from './metrics.js';
import type { DependencyLabel, Label } from './schema.js';

/**
 * Metrics for the dependency/SBOM label family (Phase 4). Pure functions over a report and a label.
 * `unknown`, `disputed` and `not_applicable` labels are excluded and counted, never scored.
 */
export interface DepPrediction {
  lockfiles: string[];
  sbomParsed: boolean;
  sbomFormats: string[];
  sbomComparison: string | null;
  primaryManifests: number;
  direct: number;
  directRegistry: number;
  exactRatio: number | null;
  checkedRatio: number | null;
  auxiliary: number;
  missingFromSbom: number;
  additionalSbomComponents: number;
  vulnerableTotal: number;
}

export function depPredictionFrom(r: Report): DepPrediction | undefined {
  const d = (r as Partial<Report>).dependency_intel;
  if (!d) return undefined;
  const s = d.summary;
  const manifests = new Set(
    d.dependencies
      .filter((x) => x.context === 'primary' && x.manifest_path)
      .map((x) => x.manifest_path),
  );
  const cmp = d.sbom_comparisons[0];
  return {
    lockfiles: d.lockfiles.map((l) => l.path.slice(l.path.lastIndexOf('/') + 1)),
    sbomParsed: d.sboms.some((x) => x.status === 'parsed'),
    sbomFormats: d.sboms.filter((x) => x.status === 'parsed').map((x) => x.format),
    sbomComparison: cmp?.state ?? null,
    primaryManifests: manifests.size,
    direct: s.direct,
    directRegistry: s.direct_registry,
    exactRatio: s.direct_registry > 0 ? s.direct_resolved_exact / s.direct_registry : null,
    checkedRatio: s.direct_registry > 0 ? s.direct_vulnerability_checked / s.direct_registry : null,
    auxiliary: s.auxiliary,
    missingFromSbom: cmp?.missing_from_sbom.length ?? 0,
    additionalSbomComponents: cmp?.additional_sbom_components ?? 0,
    vulnerableTotal: s.vulnerable_total,
  };
}

export interface DepCase {
  label: Label;
  prediction: DepPrediction | undefined;
}

export interface NumericResult {
  n: number;
  exact: number;
  within10pct: number;
}

export interface DepEvaluation {
  /** Repositories that have a `dependencies:` label block. */
  repositories: number;
  detectors: Record<string, Prf>;
  /** Categorical dependency labels: accuracy over decided labels, with abstentions kept visible. */
  sbomFormat: { n: number; correct: number; excluded: number };
  sbomConsistency: {
    n: number;
    correct: number;
    excluded: number;
    confusion: Record<string, Record<string, number>>;
  };
  dependencyManifestCount: NumericResult;
  directDependencyCount: NumericResult;
  /** Mean exact-resolution and vulnerability-check coverage over repositories labelled "expected". */
  coverage: {
    exactRatioWhenExpected: number | null;
    checkedRatioWhenExpected: number | null;
    n: number;
  };
}

const decided = (l: string): boolean => l === 'yes' || l === 'no';

export function evaluateDependencies(cases: DepCase[]): DepEvaluation {
  const det: Record<string, Counts> = {};
  const add = (name: string, predicted: boolean, label: string): void =>
    addBinary((det[name] ??= emptyCounts()), predicted, label as 'yes');
  const numeric = (): NumericResult => ({ n: 0, exact: 0, within10pct: 0 });
  const out: DepEvaluation = {
    repositories: 0,
    detectors: {},
    sbomFormat: { n: 0, correct: 0, excluded: 0 },
    sbomConsistency: { n: 0, correct: 0, excluded: 0, confusion: {} },
    dependencyManifestCount: numeric(),
    directDependencyCount: numeric(),
    coverage: { exactRatioWhenExpected: null, checkedRatioWhenExpected: null, n: 0 },
  };
  const exactVals: number[] = [];
  const checkedVals: number[] = [];
  for (const { label, prediction: p } of cases) {
    const l: DependencyLabel | undefined = label.dependencies;
    if (!l || !p) continue;
    out.repositories++;
    add('has_lockfile', p.lockfiles.length > 0, l.has_lockfile);
    add('has_sbom', p.sbomParsed, l.has_sbom);
    if (p.exactRatio !== null)
      add('exact_version_expected', p.exactRatio >= 0.8, l.exact_version_expected);
    if (p.checkedRatio !== null) add('osv_checkable', p.checkedRatio >= 0.5, l.osv_checkable);
    add('auxiliary_dependency_presence', p.auxiliary > 0, l.auxiliary_dependency_presence);
    if (p.sbomComparison && p.sbomComparison !== 'unable_to_compare') {
      add('manifest_sbom_missing', p.missingFromSbom > 0, l.manifest_sbom_missing);
      add('sbom_extra_components', p.additionalSbomComponents > 0, l.sbom_extra_components);
    }
    add(
      'osv_expected_known_vulnerabilities',
      p.vulnerableTotal > 0,
      l.osv_expected_known_vulnerabilities,
    );

    if (l.sbom_format === 'unknown') out.sbomFormat.excluded++;
    else {
      out.sbomFormat.n++;
      const predicted = p.sbomFormats[0] ?? 'none';
      if (predicted === l.sbom_format) out.sbomFormat.correct++;
    }

    const lc = l.sbom_consistency;
    if (lc === 'unknown' || lc === 'disputed' || lc === 'not_applicable')
      out.sbomConsistency.excluded++;
    else {
      const predicted = p.sbomComparison ?? 'unable_to_compare';
      out.sbomConsistency.n++;
      if (predicted === lc) out.sbomConsistency.correct++;
      const row = (out.sbomConsistency.confusion[lc] ??= {});
      row[predicted] = (row[predicted] ?? 0) + 1;
    }

    const num = (r: NumericResult, expected: number | 'unknown', got: number): void => {
      if (expected === 'unknown') return;
      r.n++;
      if (got === expected) r.exact++;
      if (Math.abs(got - expected) <= Math.max(1, Math.abs(expected) * 0.1)) r.within10pct++;
    };
    num(out.dependencyManifestCount, l.dependency_manifest_count, p.primaryManifests);
    num(out.directDependencyCount, l.direct_dependency_count_expected, p.direct);

    if (
      decided(l.exact_version_expected) &&
      l.exact_version_expected === 'yes' &&
      p.exactRatio !== null
    )
      exactVals.push(p.exactRatio);
    if (l.osv_checkable === 'yes' && p.checkedRatio !== null) checkedVals.push(p.checkedRatio);
  }
  out.detectors = Object.fromEntries(Object.entries(det).map(([k, v]) => [k, prf(v)]));
  const mean = (a: number[]): number | null =>
    a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  out.coverage = {
    exactRatioWhenExpected: mean(exactVals),
    checkedRatioWhenExpected: mean(checkedVals),
    n: exactVals.length,
  };
  return out;
}

const pct = (x: number | null): string => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);

export function renderDependencyMarkdown(e: DepEvaluation): string {
  const row = (name: string, r: Prf): string =>
    `| ${name} | ${r.n} | ${r.tp} | ${r.fp} | ${r.fn} | ${r.tn} | ${r.excluded} | ${pct(r.precision)} | ${pct(r.recall)} |`;
  const lines = [
    `Dependency / SBOM label family (${e.repositories} repositories with dependency labels)`,
    '',
    '| Detector | n | TP | FP | FN | TN | excluded | precision | recall |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...Object.entries(e.detectors)
      .sort()
      .map(([k, v]) => row(k, v)),
    '',
    `- SBOM format: ${e.sbomFormat.correct}/${e.sbomFormat.n} correct (${e.sbomFormat.excluded} unknown)`,
    `- SBOM consistency class: ${e.sbomConsistency.correct}/${e.sbomConsistency.n} correct (${e.sbomConsistency.excluded} unknown/disputed/n.a.); confusion ${JSON.stringify(e.sbomConsistency.confusion)}`,
    `- primary dependency manifests: exact ${e.dependencyManifestCount.exact}/${e.dependencyManifestCount.n}, within 10% ${e.dependencyManifestCount.within10pct}/${e.dependencyManifestCount.n}`,
    `- direct dependency count: exact ${e.directDependencyCount.exact}/${e.directDependencyCount.n}, within 10% ${e.directDependencyCount.within10pct}/${e.directDependencyCount.n}`,
    `- resolution coverage where exact versions were expected: ${pct(e.coverage.exactRatioWhenExpected)} (n=${e.coverage.n}); OSV direct coverage where checkable: ${pct(e.coverage.checkedRatioWhenExpected)}`,
    '',
  ];
  return lines.join('\n');
}
