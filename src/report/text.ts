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
    out.push(`  Confidence: ${pct(id.confidence)} (heuristic classifier ${s(id.classifier)})`);
  }
  if (id.declared_summary) out.push(`  Declared: "${s(id.declared_summary, 160)}"`);
  if (id.interfaces.length > 0)
    out.push(`  Interfaces: ${id.interfaces.map((x) => s(x)).join(', ')}`);
  if (id.ecosystem.length > 0) out.push(`  Ecosystem: ${id.ecosystem.map((x) => s(x)).join(', ')}`);
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

  out.push('');
  out.push(
    `Evidence: ${r.stats.evidence_count} signals | Methodology: v${r.methodology.version} | Rules digest: ${r.methodology.rules_digest.slice(0, 12)}`,
  );
  out.push(
    'Scores summarize observed indicators; they are not a statement that code is safe, secure or trustworthy.',
  );
  return out.join('\n') + '\n';
}
