import type { Finding } from '../analysis/findings.js';
import type { Fact } from '../facts/index.js';
import type { NameIntelligence } from './name-model.js';
export function buildNameFindings(n: NameIntelligence): Finding[] {
  return n.signals.map((s, i) => ({
    id: `RR-NAME-${String(i + 1).padStart(3, '0')}`,
    dimension: 'supply-chain',
    category: 'registry',
    severity:
      s.signals.includes('homoglyph') || s.signals.includes('scope_confusion') ? 'low' : 'info',
    confidence: 0.65,
    evidence_ids: s.evidence,
    rule_ids: [],
    standards: [],
    intent: 'undetermined',
    title: 'Possible package-name confusion',
    summary: `${s.ecosystem}:${s.target} resembles ${s.candidate}; possible package-name confusion. Signals: ${s.signals.join(', ')}. Intent is undetermined.`,
    remediation:
      'Check the dependency source, publisher and repository before adding or upgrading it.',
  }));
}
export function deriveNameFacts(n: NameIntelligence): Fact[] {
  if (n.status !== 'analyzed') return [];
  const from = n.signals.flatMap((s) => s.evidence).slice(0, 20);
  const out: Fact[] = [];
  if (n.signals.length)
    out.push({
      id: 'registry.deps.name_confusion_present',
      value: true,
      confidence: 0.7,
      scope: 'registry',
      derived_from: from,
      derived_by: 'name-intelligence@0.1',
    });
  else if (n.compared >= n.eligible && n.eligible > 0)
    out.push({
      id: 'registry.deps.name_confusion_present',
      value: false,
      confidence: 0.65,
      scope: 'registry',
      derived_from: [],
      derived_by: 'name-intelligence@0.1',
    });
  return out;
}
