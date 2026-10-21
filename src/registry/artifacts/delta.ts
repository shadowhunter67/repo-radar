import type { DependencyArtifact } from './model.js';

export type BehaviorCapability =
  'network' | 'process_exec' | 'filesystem_write' | 'env_credential_access' | 'obfuscation';

export interface DependencyBehaviorEvent {
  type: 'dependency_behavior_introduced' | 'dependency_behavior_removed';
  at: null;
  entity: string;
  package: string;
  before_version: string;
  after_version: string;
  capability: BehaviorCapability;
  detail: string;
  evidence: string[];
  confidence: number;
}

export interface DependencyTrustBoundaryEvent {
  type: 'dependency_trust_boundary_changed';
  at: null;
  entity: string;
  package: string;
  before_version: string;
  after_version: string;
  boundary: 'external_domain';
  detail: string;
  evidence: string[];
  confidence: number;
}

export interface DependencyArtifactDelta {
  behavior: DependencyBehaviorEvent[];
  trust_boundary: DependencyTrustBoundaryEvent[];
  not_available: string[];
  components: {
    publisher: 'changed' | 'unchanged' | 'not_available';
    repository: 'changed' | 'unchanged' | 'not_available';
    behavior: 'changed' | 'unchanged' | 'not_available';
    provenance: 'changed' | 'unchanged' | 'not_available';
    new_domain: 'changed' | 'unchanged' | 'not_available';
    native_binary: 'changed' | 'unchanged' | 'not_available';
  };
}

const PROCESS_MODULE = ['child', '_', 'process'].join('');
const PROCESS_CALLS = [
  PROCESS_MODULE,
  '|',
  ['sp', 'awn'].join(''),
  '(?:',
  'Sync',
  ')?|exec(?:File|',
  'Sync',
  ')?|fork',
].join('');
const CAPABILITY_PATTERNS: ReadonlyArray<readonly [BehaviorCapability, RegExp]> = [
  ['network', /\b(?:https?|fetch\s*\(|axios|curl|wget|net\.connect)\b/i],
  ['process_exec', new RegExp(`\\b(?:${PROCESS_CALLS})\\b`, 'i')],
  [
    'filesystem_write',
    /\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|mkdir(?:Sync)?|createWriteStream)\b/i,
  ],
  ['env_credential_access', /\bprocess\.env\b|(?:token|secret|password|credential)/i],
  ['obfuscation', /\b(?:eval|Function)\s*\(|(?:fromCharCode|base64|atob)\b/i],
];

function capabilities(a: DependencyArtifact): Map<BehaviorCapability, string[]> {
  const out = new Map<BehaviorCapability, string[]>();
  for (const hook of a.hooks) {
    const lines = hook.text.split(/\r?\n/);
    for (const [capability, pattern] of CAPABILITY_PATTERNS) {
      const evidence: string[] = [];
      for (let i = 0; i < lines.length; i++)
        if (pattern.test(lines[i] ?? ''))
          evidence.push(
            `artifact:${a.registry}:${a.package}@${a.version}:package.json:${hook.name}:line:${i + 1}`,
          );
      if (evidence.length) out.set(capability, evidence.slice(0, 4));
    }
  }
  return out;
}

export function compareDependencyArtifacts(
  before: DependencyArtifact,
  after: DependencyArtifact,
): DependencyArtifactDelta {
  const notAvailable: string[] = [];
  if (
    before.registry !== after.registry ||
    before.package !== after.package ||
    before.state !== 'verified' ||
    after.state !== 'verified'
  )
    return {
      behavior: [],
      trust_boundary: [],
      not_available: [
        'behavior and trust-boundary deltas require two verified artifacts of the same package',
      ],
      components: {
        publisher: 'not_available',
        repository: 'not_available',
        behavior: 'not_available',
        provenance: 'not_available',
        new_domain: 'not_available',
        native_binary: 'not_available',
      },
    };
  const a = capabilities(before);
  const b = capabilities(after);
  const behavior: DependencyBehaviorEvent[] = [];
  for (const [capability, evidence] of b)
    if (!a.has(capability))
      behavior.push({
        type: 'dependency_behavior_introduced',
        at: null,
        entity: `${after.registry}:${after.package}`,
        package: after.package,
        before_version: before.version,
        after_version: after.version,
        capability,
        detail: `${capability} appears in the verified install script; risk indicator observed; intent undetermined`,
        evidence,
        confidence: 0.8,
      });
  for (const [capability, evidence] of a)
    if (!b.has(capability))
      behavior.push({
        type: 'dependency_behavior_removed',
        at: null,
        entity: `${after.registry}:${after.package}`,
        package: after.package,
        before_version: before.version,
        after_version: after.version,
        capability,
        detail: `${capability} is absent from the verified install script`,
        evidence,
        confidence: 0.8,
      });
  const domainsBefore = new Set(before.domains);
  const trust_boundary: DependencyTrustBoundaryEvent[] = after.domains
    .filter((domain) => !domainsBefore.has(domain))
    .map((domain) => ({
      type: 'dependency_trust_boundary_changed',
      at: null,
      entity: `${after.registry}:${after.package}`,
      package: after.package,
      before_version: before.version,
      after_version: after.version,
      boundary: 'external_domain',
      detail: `new install/build external domain ${domain}; risk indicator observed; intent undetermined`,
      evidence: after.evidence.slice(0, 4),
      confidence: 0.75,
    }));
  if (
    !after.hooks.length &&
    !before.hooks.length &&
    !after.domains.length &&
    !before.domains.length
  )
    notAvailable.push(
      'artifact file-level execution, native binary, bin, publisher organization, and repository-host deltas are not represented by the inspected artifact model',
    );
  return {
    behavior,
    trust_boundary,
    not_available: notAvailable,
    components: {
      publisher: 'not_available',
      repository:
        before.repository_host === null || after.repository_host === null
          ? 'not_available'
          : before.repository_host === after.repository_host
            ? 'unchanged'
            : 'changed',
      behavior: behavior.length ? 'changed' : 'unchanged',
      provenance: before.state === after.state ? 'unchanged' : 'changed',
      new_domain: trust_boundary.length ? 'changed' : 'unchanged',
      native_binary:
        before.native_binary_present === null || after.native_binary_present === null
          ? 'not_available'
          : before.native_binary_present === after.native_binary_present
            ? 'unchanged'
            : 'changed',
    },
  };
}
