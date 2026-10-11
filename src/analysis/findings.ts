import { z } from 'zod';
import type { CodeAnalysis } from './index.js';
import { PERSISTENCE_KINDS, type PersistenceKind } from './types.js';

/**
 * Standardized findings for the code-analysis subsystems. A finding states an OBSERVATION with confidence;
 * it never states intent. `rule_ids` links to the scored rules that (if any) turn the observation into score impact,
 * so "why did the score move" is always answerable through finding -> rule -> fact -> detection.
 */
export const FindingSchema = z.object({
  id: z.string(),
  title: z.string(),
  severity: z.enum(['info', 'low', 'medium', 'high']),
  confidence: z.number().min(0).max(1),
  dimension: z.enum(['security', 'supply-chain']),
  category: z.enum([
    'execution',
    'capability',
    'secrets',
    'persistence',
    'dependency',
    'sbom',
    'release',
    'governance',
  ]),
  /** Ids of detections / chains / hooks / secret candidates in this report. */
  evidence_ids: z.array(z.string()),
  rule_ids: z.array(z.string()),
  standards: z.array(z.string()),
  summary: z.string(),
  remediation: z.string(),
  /** Always "undetermined": capability is not intent. */
  intent: z.literal('undetermined'),
});
export type Finding = z.infer<typeof FindingSchema>;

/** MITRE ATT&CK technique ids for persistence mechanisms (reference mapping, not an accusation). */
const ATTACK: Partial<Record<PersistenceKind, string>> = {
  systemd_service: 'mitre-attack:T1543.002',
  cron_job: 'mitre-attack:T1053.003',
  launchd_service: 'mitre-attack:T1543.001',
  windows_service: 'mitre-attack:T1543.003',
  registry_run_key: 'mitre-attack:T1547.001',
  startup_folder: 'mitre-attack:T1547.001',
  scheduled_task: 'mitre-attack:T1053.005',
  shell_profile_modification: 'mitre-attack:T1546.004',
  ssh_authorized_keys_write: 'mitre-attack:T1098.004',
  login_item: 'mitre-attack:T1547.015',
  browser_extension_install: 'mitre-attack:T1176',
};

export function buildFindings(code: CodeAnalysis): Finding[] {
  if (!code.scan.performed) return [];
  const out: Finding[] = [];
  const counters = { EXEC: 0, PERS: 0, SEC: 0, CAP: 0 };
  const next = (k: keyof typeof counters): string =>
    `RR-${k}-${String(++counters[k]).padStart(3, '0')}`;

  for (const c of code.execution.chains) {
    const install = c.contexts.includes('install');
    out.push({
      id: next('EXEC'),
      title: `Download-and-execute chain observed in ${c.file}`,
      severity: install
        ? c.mode === 'DIRECT'
          ? 'high'
          : 'medium'
        : c.mode === 'DIRECT'
          ? 'medium'
          : 'low',
      confidence: c.confidence,
      dimension: 'security',
      category: 'execution',
      evidence_ids: [c.id],
      rule_ids: install ? ['security.install-time-download-execute'] : [],
      standards: ['cwe:CWE-494'],
      summary: `${c.mode === 'DIRECT' ? 'Directly observed' : 'Inferred'} path: ${c.steps.join(' -> ')} (line${c.lines.length > 1 ? 's' : ''} ${c.lines.join(', ')}). Context: ${c.contexts.join(', ')}. This describes a capability; the purpose of the download is undetermined.`,
      remediation:
        'Verify what is downloaded: pin a version and check a checksum or signature before executing, or vendor the artifact.',
      intent: 'undetermined',
    });
  }

  for (const h of code.execution.hooks) {
    if (h.risk === 'none') continue;
    if (!h.runs_for_dependents && h.risk !== 'high') continue;
    out.push({
      id: next('EXEC'),
      title: `${h.ecosystem} hook "${h.name}" runs code at ${h.context} time${h.runs_for_dependents ? ', including for dependents' : ''}`,
      // Hooks a user starts by hand are reported, but at most as medium: they are not automatic.
      severity:
        h.risk === 'high'
          ? h.runs_for_dependents
            ? 'high'
            : 'medium'
          : h.risk === 'medium'
            ? 'medium'
            : 'info',
      confidence: h.confidence,
      dimension: 'supply-chain',
      category: 'execution',
      evidence_ids: [h.id, ...h.chain_ids],
      rule_ids: ['supply-chain.install-hooks'],
      standards: ['mitre-attack:T1195.002'],
      summary: `${h.stage ? `Stage ${h.stage}, trigger ${h.trigger_kind ?? 'UNKNOWN'}, environment ${h.environment ?? 'UNKNOWN'}. ` : ''}Trigger: ${h.trigger}. Observed capabilities: ${h.capabilities.length > 0 ? h.capabilities.join(', ') : 'none detected'}${h.analyzed ? '' : ` (not fully analyzed: ${h.unanalyzed_commands} command(s)/file(s) could not be read)`}.`,
      remediation:
        h.ecosystem === 'pypi'
          ? 'Prefer installing a published wheel (pip install --only-binary :all:) so no build code runs; otherwise review the build backend and the files it runs before building from source.'
          : 'Review the hook and the files it runs before installing; consider installing with lifecycle scripts disabled (for npm: --ignore-scripts) where the package allows it.',
      intent: 'undetermined',
    });
  }

  // A repository-controlled build backend is worth stating even when no risky capability was observed in it:
  // it is code from the repository that runs in the installer's build environment.
  for (const p of code.execution.projects) {
    if (p.kind !== 'in_tree_custom' || !p.repository_code_runs) continue;
    if (out.some((f) => f.evidence_ids.some((id) => p.hook_ids.includes(id)))) continue;
    out.push({
      id: next('EXEC'),
      title: `Repository-controlled ${p.ecosystem} build backend runs when building ${p.dir} from source`,
      severity: 'low',
      confidence: 0.85,
      dimension: 'supply-chain',
      category: 'execution',
      evidence_ids: p.hook_ids,
      rule_ids: ['supply-chain.install-hooks'],
      standards: [],
      summary: `The declared build backend (${p.build_system ?? 'unknown'}) is loaded from the repository itself (backend-path), so building from source executes repository code in the build environment. No risky capability was observed in the analyzed files; this is a statement about where the code comes from, not a finding of misbehaviour.`,
      remediation:
        'Prefer a published wheel (pip install --only-binary :all:) or review the in-tree backend before building from source.',
      intent: 'undetermined',
    });
  }

  // Build files that resolve or download build tooling over plain HTTP can be tampered with in transit.
  for (const p of code.execution.projects) {
    const insecure = p.notes.filter((n) => /plain HTTP/.test(n));
    if (insecure.length === 0) continue;
    out.push({
      id: next('EXEC'),
      title: `${p.ecosystem} build of ${p.dir} resolves or downloads over plain HTTP`,
      severity: 'medium',
      confidence: 0.9,
      dimension: 'supply-chain',
      category: 'dependency',
      evidence_ids: p.hook_ids,
      rule_ids: [],
      standards: [],
      summary: `${insecure.slice(0, 3).join('; ')}. Content fetched over HTTP can be modified by anyone on the network path.`,
      remediation: 'Use https URLs and, for wrappers, set a distributionSha256Sum checksum.',
      intent: 'undetermined',
    });
  }

  if (code.persistence.observed) {
    const kinds = code.persistence.kinds.filter((k) =>
      (PERSISTENCE_KINDS as readonly string[]).includes(k),
    );
    out.push({
      id: next('PERS'),
      title: `Persistence capability observed (${kinds.join(', ')})`,
      severity: code.persistence.install_time ? 'high' : 'medium',
      confidence: 0.75,
      dimension: 'security',
      category: 'persistence',
      evidence_ids: code.capabilities.detections
        .filter((d) => d.persistence_kind)
        .slice(0, 10)
        .map((d) => d.id),
      rule_ids: ['security.persistence-capability'],
      standards: kinds.map((k) => ATTACK[k]).filter((x): x is string => !!x),
      summary:
        'Files in the scanned sample contain constructs that can make software start again after login or reboot. Installers, agents and servers legitimately do this; intent is undetermined.',
      remediation:
        'Confirm that the persistence is documented, expected for this kind of software, and removable.',
      intent: 'undetermined',
    });
  }

  const byType = new Map<string, typeof code.secrets.candidates>();
  for (const c of code.secrets.candidates) byType.set(c.type, [...(byType.get(c.type) ?? []), c]);
  for (const [type, list] of byType) {
    const scored = list.filter((c) => c.mode === 'DIRECT' && !c.in_test_or_example);
    const strong = scored.length > 0;
    out.push({
      id: next('SEC'),
      title: `${strong ? 'Possible' : 'Low-confidence'} hard-coded secret: ${type} (${list.length} location${list.length > 1 ? 's' : ''})`,
      severity: strong ? 'high' : 'low',
      confidence: Math.max(...list.map((c) => c.confidence)),
      dimension: 'security',
      category: 'secrets',
      evidence_ids: list.map((c) => c.id),
      rule_ids: strong ? ['security.hardcoded-secrets'] : [],
      standards: ['cwe:CWE-798'],
      summary: `Locations: ${list
        .slice(0, 5)
        .map((c) => (c.line > 0 ? `${c.file}:${c.line}` : c.file))
        .join(
          ', ',
        )}. Values are redacted and never stored. ${strong ? '' : 'Only in tests/examples or low-confidence patterns, so not scored.'}`,
      remediation:
        'Rotate the credential if it is real, remove it from history, and load secrets from the environment or a secret manager.',
      intent: 'undetermined',
    });
  }

  for (const s of code.capabilities.summary) {
    if (!s.observed || s.mode === 'POSSIBLE' || s.risk !== 'high') continue;
    if (s.capability === 'PERSISTENCE') continue; // covered above
    out.push({
      id: next('CAP'),
      title: `High-risk capability observed: ${s.capability}`,
      severity: s.mode === 'DIRECT' ? 'high' : 'medium',
      confidence: s.confidence,
      dimension: 'security',
      category: 'capability',
      evidence_ids: code.capabilities.detections
        .filter((d) => d.capability === s.capability)
        .slice(0, 10)
        .map((d) => d.id),
      rule_ids: [],
      standards: [],
      summary: `${s.count} detection(s) in ${s.files.join(', ')}; contexts: ${s.contexts.join(', ')}. A capability describes what the code can do, not why.`,
      remediation:
        'Review the referenced files and confirm the behavior is expected and documented.',
      intent: 'undetermined',
    });
  }

  return out;
}
