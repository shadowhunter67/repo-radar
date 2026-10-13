import type { Finding } from '../analysis/findings.js';
import type { Fact } from '../facts/index.js';
import { ACTIVE_CONTEXTS, type ExternalDomain, type ExternalDomains } from './model.js';

/**
 * Findings and facts from external-domain extraction. A finding says a file refers to a host in a context; it never says the
 * host is malicious, and "no domain found" is a fact only when enough code was read (`scanReliable`).
 */
const safe = (s: string, n = 80): string => s.replace(/[^\x20-\x7e]/g, '?').slice(0, n);

const EXPECTED = new Set(['registry', 'github']);

export function buildDomainFindings(d: ExternalDomains): Finding[] {
  if (d.status !== 'analyzed') return [];
  const out: Finding[] = [];
  let n = 0;
  const base = {
    dimension: 'supply-chain' as const,
    category: 'domain' as const,
    rule_ids: [] as string[],
    standards: [] as string[],
    intent: 'undetermined' as const,
  };
  const ev = (x: ExternalDomain): string[] =>
    [
      `domain:${safe(x.hostname, 100)}`,
      ...x.observations.slice(0, 2).map((o) => `${o.file}:${o.line}`),
    ].slice(0, 3);
  for (const x of d.domains) {
    if (out.length >= 12) break;
    const where = x.observations[0];
    const at = where ? ` (${safe(where.file, 100)}:${where.line})` : '';
    if (x.strongest_context === 'install' && !EXPECTED.has(x.category)) {
      out.push({
        ...base,
        id: `RR-DOM-${String(++n).padStart(3, '0')}`,
        title: 'Install-time code refers to an external host',
        // a script that also shows network behaviour is a stronger observation than text it prints
        severity: x.confidence >= 0.7 ? 'medium' : 'low',
        confidence: x.confidence,
        evidence_ids: ev(x),
        summary: `${safe(x.hostname)}${at} is referenced from a file that runs when the package is installed. A reference is not a connection and says nothing about intent.`,
        remediation:
          'Read what the install step does with this host (download, telemetry, configuration) and prefer installs that need no network access beyond the package registry.',
      });
    } else if (x.category === 'ip_literal' && ACTIVE_CONTEXTS.has(x.strongest_context)) {
      out.push({
        ...base,
        id: `RR-DOM-${String(++n).padStart(3, '0')}`,
        title: 'Code refers to a host by IP address',
        severity: 'low',
        confidence: x.confidence,
        evidence_ids: ev(x),
        summary: `${safe(x.hostname)}${at} is a public IP address used in ${x.strongest_context} context. IP literals cannot be reviewed by name.`,
        remediation: 'Confirm what the address is and prefer a documented host name.',
      });
    } else if (x.ambiguity !== 'none' && ACTIVE_CONTEXTS.has(x.strongest_context)) {
      out.push({
        ...base,
        id: `RR-DOM-${String(++n).padStart(3, '0')}`,
        title: 'Host name uses punycode, Unicode or mixed scripts',
        severity: 'info',
        confidence: 0.5,
        evidence_ids: ev(x),
        summary: `${safe(x.hostname)} (shown as ${safe(x.display)}${at}) is written with ${x.ambiguity.replace('_', ' ')} characters. This is informational: look-alike names exist, but so do legitimate internationalized domains. No judgement about the domain is made and it was not resolved.`,
        remediation: 'Check the name character by character against the project it is meant to be.',
      });
    } else if (
      x.category === 'telemetry' &&
      (x.strongest_context === 'install' || x.strongest_context === 'build')
    ) {
      out.push({
        ...base,
        id: `RR-DOM-${String(++n).padStart(3, '0')}`,
        title: 'Build or install code refers to a telemetry endpoint',
        severity: 'low',
        confidence: x.confidence,
        evidence_ids: ev(x),
        summary: `${safe(x.hostname)}${at} looks like an analytics or telemetry host.`,
        remediation: 'Check whether the data collection is documented and can be disabled.',
      });
    }
  }
  return out;
}

export function deriveDomainFacts(d: ExternalDomains, scanReliable: boolean): Fact[] {
  if (d.status !== 'analyzed') return [];
  const facts: Fact[] = [];
  const from = d.domains.slice(0, 10).map((x) => `domain:${safe(x.hostname, 100)}`);
  const f = (id: string, value: number | boolean, confidence = 0.8): void => {
    facts.push({
      id,
      value,
      confidence,
      scope: 'domain',
      derived_from: from,
      derived_by: 'domains@0.1',
    });
  };
  const active = d.domains.filter((x) => ACTIVE_CONTEXTS.has(x.strongest_context));
  const installHosts = d.domains.filter(
    (x) => x.strongest_context === 'install' && !EXPECTED.has(x.category),
  );
  // presence is evidence at any scan coverage; absence needs a scan that read enough code
  f('domains.external.count', d.domains_total, 0.8);
  f('domains.active.count', active.length, 0.8);
  if (installHosts.length > 0) f('domains.install_time.present', true, 0.85);
  else if (scanReliable) f('domains.install_time.present', false, 0.7);
  const ambiguous = active.some((x) => x.ambiguity !== 'none');
  if (ambiguous) f('domains.ambiguous_names.present', true, 0.6);
  else if (scanReliable) f('domains.ambiguous_names.present', false, 0.6);
  return facts;
}
