import type { Report } from './schema.js';
import { sanitizeForTerminal } from '../util/text.js';

export interface TextOptions {
  ascii?: boolean;
  verbose?: boolean;
}

const pct = (n: number): string => `${Math.round(n * 100)}%`;

function bar(score: number | null, ascii: boolean): string {
  const filled = score === null ? 0 : Math.max(0, Math.min(10, Math.round(score / 10)));
  const [on, off] = ascii ? ['#', '-'] : ['█', '░'];
  return on.repeat(filled) + off.repeat(10 - filled);
}

/** Every repo-controlled string passes through sanitizeForTerminal before reaching the terminal. */
export function renderText(r: Report, o: TextOptions = {}): string {
  const ascii = !!o.ascii;
  const s = (x: string, n?: number): string => sanitizeForTerminal(x, n);
  const out: string[] = [];
  out.push(
    `repo-radar v${r.tool.version}  (methodology ${r.methodology.version}, profile: ${r.profile.id})`,
  );
  out.push('');
  out.push(`${s(r.subject.owner)}/${s(r.subject.repo)}`);
  out.push('');
  out.push('IDENTITY');
  const id = r.identity;
  if (id.canonical_type === 'unclassified') {
    out.push(`  Purpose not determined from available metadata (confidence ${pct(id.confidence)})`);
  } else {
    out.push(`  ${s(id.primary_function)} - detected type: ${s(id.canonical_type)}`);
    out.push(
      `  Confidence: ${pct(id.confidence)} (heuristic classifier ${s(id.classifier)}; a heuristic score, not a calibrated probability)`,
    );
  }
  if (id.declared_summary) out.push(`  Declared: "${s(id.declared_summary, 160)}"`);
  if (id.interfaces.length > 0)
    out.push(`  Interfaces: ${id.interfaces.map((x) => s(x)).join(', ')}`);
  if (id.ecosystem.length > 0) out.push(`  Ecosystem: ${id.ecosystem.map((x) => s(x)).join(', ')}`);
  out.push(
    `  Artifact: ${s(id.artifact_type)} (${pct(id.artifact_confidence)})${id.artifact_alternatives.length > 0 ? `, alternatives: ${id.artifact_alternatives.map((x) => s(x)).join(', ')}` : ''}  Domain: ${s(id.domain)}`,
  );
  if (id.alternatives.length > 1)
    out.push(
      `  Candidates: ${id.alternatives.map((a) => `${s(a.canonical_type)} ${pct(a.share)}`).join(', ')}`,
    );
  if (id.name_purpose_divergence !== null && id.name_purpose_divergence >= 0.8) {
    out.push(`  Note: the name says little about the purpose (informational, not scored)`);
  }
  out.push('');
  out.push(
    `TRUST PROFILE (observed evidence evaluated against methodology ${r.methodology.version})`,
  );
  const width = Math.max(...r.dimensions.map((d) => d.label.length), 7);
  for (const d of r.dimensions) {
    const score = d.score === null ? ' --' : String(Math.round(d.score)).padStart(3);
    const wide = d.score_range && d.score_range[1] - d.score_range[0] >= 20;
    const range =
      wide && d.score_range
        ? ` range ${Math.round(d.score_range[0])}-${Math.round(d.score_range[1])}`
        : '';
    const note =
      d.sufficiency === 'insufficient'
        ? '  insufficient evidence'
        : d.sufficiency === 'low'
          ? `  low confidence${range}`
          : range
            ? ` ${range.trim()}`
            : '';
    out.push(
      `  ${d.label.padEnd(width)}  ${score}  ${d.grade.padEnd(3)}  ${bar(d.sufficiency === 'insufficient' ? null : d.score, ascii)}  conf ${pct(d.confidence).padStart(4)}${note}`,
    );
  }
  const ov = r.overall;
  const ovScore = ov.score === null ? ' --' : String(Math.round(ov.score)).padStart(3);
  out.push(
    `  ${'Overall'.padEnd(width)}  ${ovScore}  ${ov.grade.padEnd(3)}  ${bar(ov.sufficiency === 'insufficient' ? null : ov.score, ascii)}  conf ${pct(ov.confidence).padStart(4)}  (weighted by profile "${r.profile.id}"; not an absolute verdict)`,
  );
  out.push('');
  out.push(`Overall confidence: ${pct(ov.confidence)}`);

  if (r.warnings.length > 0) {
    out.push('');
    out.push('WARNINGS');
    for (const w of r.warnings) out.push(`  - ${s(w.message, 200)}`);
  }

  if (r.policy.violations.length > 0) {
    out.push('');
    out.push(
      `POLICY (${r.policy.source} minimums${r.policy.enforced ? ', enforced' : ', advisory'})`,
    );
    for (const v of r.policy.violations) {
      out.push(
        v.reason === 'below_minimum'
          ? `  - ${v.key}: ${v.actual} < minimum ${v.minimum}`
          : `  - ${v.key}: cannot verify minimum ${v.minimum} (insufficient evidence)`,
      );
    }
  }

  if (r.policy.block_violations.length > 0) {
    out.push('');
    out.push(
      `POLICY BLOCKS (${r.policy.blocks_evaluated} evaluated${r.policy.enforced ? ', enforced' : ', advisory'})`,
    );
    for (const b of r.policy.block_violations)
      out.push(
        `  - ${s(b.id, 60)}: ${s(b.description, 140)}${b.reason === 'undecidable' ? ' (could not be decided; this block fails closed)' : ''}`,
      );
  }

  const notable = r.diagnostics.filter((d) => d.level !== 'info');
  if (notable.length > 0 || o.verbose) {
    out.push('');
    out.push('DIAGNOSTICS');
    if (o.verbose && r.diagnostics.length === 0) out.push('  none');
    for (const d of o.verbose ? r.diagnostics : notable)
      out.push(`  [${d.level}] ${d.source}: ${s(d.message, 200)}`);
  }

  if (o.verbose) {
    out.push('');
    out.push('RULE DETAIL');
    for (const d of r.dimensions) {
      out.push(
        `  ${d.label}  (coverage ${pct(d.coverage)}, evidence quality ${pct(d.evidence_quality)})`,
      );
      for (const rule of d.rules) {
        const sc = rule.score === null ? '  - ' : rule.score.toFixed(1).padStart(4);
        out.push(
          `    ${rule.status.padEnd(14)} ${sc}/10  w=${String(rule.effective_weight).padEnd(5)} ${rule.rule_id}`,
        );
        out.push(`      ${s(rule.explanation, 220)}`);
      }
    }
  }

  out.push(...renderDependencies(r, s));
  out.push(...renderCoverage(r, s, !!o.verbose));
  out.push(...renderRegulatory(r, s, !!o.verbose));
  out.push(...renderCodeAnalysis(r, s, !!o.verbose));

  out.push('');
  out.push(
    `Evidence: ${r.stats.evidence_count} signals | Methodology: v${r.methodology.version} | Rules digest: ${r.methodology.rules_digest.slice(0, 12)}`,
  );
  out.push(
    'Scores summarize observed indicators; they are not a statement that code is safe, secure or trustworthy.',
  );
  return out.join('\n') + '\n';
}

/** Regulatory readiness: technical indicators and applicability; always with the legal disclaimer. */
/** Coverage by evidence class; always shown when the tree was not read completely. */
function renderCoverage(
  r: Report,
  s: (x: string, n?: number) => string,
  verbose: boolean,
): string[] {
  const t = r.retrieval;
  const incomplete = !t.complete;
  if (!incomplete && !verbose) return [];
  const out = ['', 'EVIDENCE COVERAGE'];
  if (t.method === 'none')
    out.push('  Repository tree unavailable: file-based evidence was not read.');
  else if (t.method === 'targeted')
    out.push(
      `  Repository tree incomplete (${t.reason === 'github_truncated' ? 'GitHub truncated the recursive tree' : 'recursive tree too large'}). Targeted retrieval: ${t.explored.length} directories listed in ${t.requests} requests, ${t.unexplored_count} known directories unread, stopped by ${t.stopped_by}.`,
    );
  else if (t.github_truncated)
    out.push('  GitHub truncated the recursive tree; file-based signals are partial.');
  for (const [k, v] of Object.entries(r.coverage_map))
    out.push(
      `  ${k.padEnd(17)} ${v.state.padEnd(9)} ${v.ratio === null ? '' : pct(v.ratio) + ' '}${s(v.note, 110)}`,
    );
  if (t.unexplored.length > 0)
    out.push(
      `  unread (first): ${t.unexplored
        .slice(0, 8)
        .map((d) => s(d, 40))
        .join(', ')}`,
    );
  return out;
}

function renderRegulatory(
  r: Report,
  s: (x: string, n?: number) => string,
  verbose: boolean,
): string[] {
  const g = r.regulatory;
  const shown = g.packs.filter((p) => p.applicability.state !== 'not_applicable' || verbose);
  const privacy = [
    ...new Set(g.indicators.filter((i) => i.family === 'privacy').map((i) => i.category)),
  ];
  const ai = [...new Set(g.indicators.filter((i) => i.family === 'ai').map((i) => i.category))];
  if (g.packs.length === 0 && privacy.length === 0 && ai.length === 0) return [];
  const out = ['', 'REGULATORY READINESS (technical indicators only; not legal advice)'];
  for (const p of shown) {
    out.push(`  ${s(p.title, 90)}  [${p.pack}@${p.version}, ${s(p.jurisdiction, 20)}]`);
    out.push(
      `    applicability: ${p.applicability.state} (confidence ${pct(p.applicability.confidence)})`,
    );
    if (p.applicability.missing_context.length > 0)
      out.push(
        `    depends on context a repository cannot show: ${p.applicability.missing_context
          .slice(0, 3)
          .map((x) => s(x, 80))
          .join('; ')}`,
      );
    if (p.evaluated) {
      out.push(
        `    indicators: ${p.summary.observed} observed, ${p.summary.partial} partial, ${p.summary.not_observed} not observed, ${p.summary.unknown} unknown`,
      );
      for (const i of p.indicators) out.push(`      [${i.status}] ${s(i.title, 100)}`);
    } else out.push('    indicators not evaluated (the pack does not apply to what was observed)');
    out.push('    legal determination: not provided');
  }
  if (privacy.length > 0)
    out.push(`  Privacy-related technical indicators observed: ${privacy.join(', ')}`);
  if (ai.length > 0) out.push(`  AI/ML technical indicators observed: ${ai.join(', ')}`);
  out.push(`  ${s(g.disclaimer, 400)}`);
  return out;
}

/** Dependency intelligence: counts that must be read together (a clean result means little at low coverage). */
function renderDependencies(r: Report, s: (x: string, n?: number) => string): string[] {
  const d = r.dependency_intel;
  const m = d.summary;
  if (m.discovered === 0 && d.sboms.length === 0) return [];
  const row = (k: string, v: string | number): string => `  ${k.padEnd(31)}${v}`;
  const out = ['', 'DEPENDENCY INTELLIGENCE'];
  out.push(
    row(
      'Dependencies discovered:',
      `${m.discovered} (${m.direct} direct, ${m.transitive} transitive)`,
    ),
  );
  if (m.direct > 0) {
    out.push(row('Direct, registry-resolvable:', m.direct_registry));
    out.push(row('  exact version known:', m.direct_resolved_exact));
    out.push(row('  unresolved / ambiguous:', `${m.direct_unresolved} / ${m.direct_ambiguous}`));
    out.push(row('Direct, not from a registry:', m.direct_non_registry));
    out.push(
      row(
        'Direct, vulnerability-checked:',
        `${m.direct_vulnerability_checked} of ${m.direct_registry}`,
      ),
    );
  }
  out.push(
    row(
      'Packages checked / vulnerable:',
      `${m.vulnerability_checked_total} / ${m.vulnerable_total}`,
    ),
  );
  out.push(
    row(
      'Vulnerability lookup (OSV):',
      `${d.vulnerability_lookup.state}${d.vulnerability_lookup.detail ? ` - ${s(d.vulnerability_lookup.detail, 80)}` : ''}`,
    ),
  );
  out.push(
    row(
      'deps.dev:',
      `${d.deps_dev.state} (${d.deps_dev.requests} requests, ${d.deps_dev.enriched} enriched, ${d.deps_dev.registry_candidates} current-version candidates)`,
    ),
  );
  if (d.lockfiles.length > 0)
    out.push(
      row('Lockfiles read:', d.lockfiles.map((l) => `${s(l.path, 40)} (${l.packages})`).join(', ')),
    );
  const parsed = d.sboms.filter((x) => x.status === 'parsed');
  out.push(
    row(
      'SBOM:',
      d.sboms.length === 0
        ? 'none found'
        : d.sboms
            .map(
              (x) =>
                `${s(x.path, 40)} ${x.format}${x.spec_version ? ` ${s(x.spec_version, 12)}` : ''} [${x.status}]`,
            )
            .join(', '),
    ),
  );
  for (const c of d.sbom_comparisons)
    out.push(
      row(
        'SBOM comparison:',
        `${c.state.toUpperCase()} (${c.matched}/${c.direct_runtime_dependencies} direct runtime deps matched, ${c.version_mismatches.length} version mismatches, +${c.additional_sbom_components} extra components, confidence ${pct(c.confidence)})`,
      ),
    );
  if (parsed.length > 0 && d.sbom_comparisons.length === 0)
    out.push(row('SBOM comparison:', 'unable_to_compare'));
  if (d.conflicts.length > 0) out.push(row('Source conflicts:', d.conflicts.length));
  out.push(
    '  (A versioned dependency without a lockfile, SBOM or exact pin is "unresolved", not "safe". A registry candidate is what the registry offers today, not what this revision used.)',
  );
  return out;
}

const RISK_LABEL = { none: 'NONE OBSERVED', low: 'LOW', medium: 'MEDIUM', high: 'HIGH' } as const;

/** Capability, install-time execution, persistence, secrets and findings sections. */
function renderCodeAnalysis(
  r: Report,
  s: (x: string, n?: number) => string,
  verbose: boolean,
): string[] {
  const c = r.code_analysis;
  const out: string[] = [];
  if (!c.scan.performed) {
    out.push(
      '',
      'CODE ANALYSIS',
      '  Not performed (--no-scan): capabilities, install-time execution and secrets were not evaluated.',
    );
    return out;
  }
  out.push(
    '',
    `CAPABILITIES (static scan of ${c.scan.files_scanned} files, ${pct(c.scan.source_coverage)} of source files sampled)`,
  );
  const observed = c.capabilities.summary.filter((x) => x.observed);
  for (const cap of observed) {
    out.push(
      `  ${cap.capability.padEnd(20)} ${RISK_LABEL[cap.risk].padEnd(7)} ${String(cap.mode)} ${pct(cap.confidence)}  [${cap.contexts.join(',')}] ${cap.files
        .slice(0, 2)
        .map((f) => s(f, 50))
        .join(', ')}`,
    );
  }
  const none = c.capabilities.summary.filter((x) => !x.observed).map((x) => x.capability);
  out.push(
    `  Not observed in the scanned sample: ${none.length > 0 ? none.join(', ') : '(all observed)'}`,
  );
  out.push('  (A capability describes what code can do, not why. Intent: undetermined.)');
  if (r.facts.some((f) => f.id === 'scan.absence_reliable' && f.value === false)) {
    out.push(
      '  Too little code was scanned for "not observed" to count as evidence: those results are not used for scoring.',
    );
  }

  out.push('', 'INSTALL-TIME EXECUTION');
  if (c.execution.hooks.length === 0)
    out.push('  No install/build hooks detected in the parsed manifests and scanned build files.');
  for (const h of c.execution.hooks) {
    out.push(
      `  ${h.ecosystem}:${s(h.name)}  risk ${RISK_LABEL[h.risk]}  confidence ${pct(h.confidence)}${h.runs_for_dependents ? '  (runs for dependents)' : ''}${h.analyzed ? '' : '  (not fully analyzed)'}`,
    );
    out.push(`    trigger: ${s(h.trigger, 100)}`);
    if (h.stage)
      out.push(
        `    stage ${h.stage} | trigger kind ${h.trigger_kind ?? 'UNKNOWN'} | environment ${h.environment ?? 'UNKNOWN'}`,
      );
    if (h.capabilities.length > 0) out.push(`    capabilities: ${h.capabilities.join(', ')}`);
    if (h.chain_ids.length > 0) out.push(`    chains: ${h.chain_ids.join(', ')}`);
    if (verbose && h.files.length > 0)
      out.push(
        `    files: ${h.files
          .slice(0, 6)
          .map((f) => s(f, 60))
          .join(', ')}`,
      );
  }
  for (const p of c.execution.projects)
    out.push(
      `  project ${s(p.dir, 40)} [${p.ecosystem}] build system ${s(p.build_system ?? '?', 50)}: ${p.kind}${p.repository_code_runs ? ', repository code runs on a source build' : ''}${p.native_build_systems.length > 0 ? `, native: ${p.native_build_systems.join(', ')}` : ''}`,
    );
  for (const p of c.execution.projects)
    for (const b of p.bypassed) out.push(`    note: ${s(b, 140)}`);
  if (c.execution.entrypoints.length > 0) {
    out.push(
      '',
      'ENTRY POINTS (installed launchers; they run when a user invokes them, NOT during installation)',
    );
    for (const e of c.execution.entrypoints.slice(0, verbose ? 40 : 10))
      out.push(
        `  ${e.ecosystem}:${s(e.name, 40)} -> ${s(e.target, 60)}${e.file ? ` (${s(e.file, 50)})` : ''}  [${e.trigger_kind}]${e.capabilities.length > 0 ? `  capabilities: ${e.capabilities.join(', ')}` : ''}`,
      );
    if (c.execution.entrypoints.length > (verbose ? 40 : 10))
      out.push(`  ... ${c.execution.entrypoints.length - (verbose ? 40 : 10)} more`);
  }
  for (const ch of c.execution.chains) {
    out.push(
      `  ${ch.id} ${ch.kind} ${ch.mode} ${pct(ch.confidence)}  ${s(ch.file, 60)}:${ch.lines.join(',')}  [${ch.contexts.join(',')}]`,
    );
  }

  out.push('', 'PERSISTENCE');
  out.push(
    c.persistence.kinds.length === 0
      ? '  None observed in the scanned sample.'
      : `  ${c.persistence.observed ? 'OBSERVED' : 'background execution only'}: ${c.persistence.kinds.join(', ')}${c.persistence.install_time ? ' (install time)' : ''}  Intent: undetermined`,
  );

  out.push('', 'SECRETS (values are never shown)');
  if (c.secrets.candidates.length === 0)
    out.push(`  None found in ${c.secrets.files_scanned} scanned files.`);
  for (const sc of c.secrets.candidates.slice(0, verbose ? 50 : 8)) {
    out.push(
      `  ${sc.id} ${sc.type} ${sc.mode} ${pct(sc.confidence)}  ${s(sc.file, 60)}${sc.line > 0 ? `:${sc.line}` : ''}  ${sc.redacted}${sc.in_test_or_example ? '  (test/example)' : ''}`,
    );
  }

  if (r.findings.length > 0) {
    out.push('', 'FINDINGS');
    for (const f of r.findings)
      out.push(`  ${f.id} [${f.severity}] ${s(f.title, 110)}  confidence ${pct(f.confidence)}`);
  }
  if (c.scan.limits_hit.length > 0)
    out.push('', 'SCAN LIMITS', ...c.scan.limits_hit.map((l) => `  - ${s(l, 120)}`));
  return out;
}
