import { diffReports, type Change, type ReportDiff, type ReportKey } from '../report/diff.js';

/**
 * Historical comparison of two analyses of the SAME repository at two exact revisions. It reads saved reports, never the
 * network, and never judges: it states what appeared, what disappeared and what moved, with the evidence it came from.
 *
 * Reports of older schema versions are read defensively; a missing section contributes no deltas and is named in the
 * comparability caveats. Score differences are only presented as meaningful when both analyses used the same
 * methodology, rule set and configuration.
 */
type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {};
const arr = (v: unknown): Json[] => (Array.isArray(v) ? v.map(obj) : []);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

export type ComparabilityLevel = 'comparable' | 'reduced' | 'not_directly_comparable';
export interface Comparability {
  level: ComparabilityLevel;
  /** Exact score differences are only meaningful at level `comparable`. */
  score_deltas_meaningful: boolean;
  reasons: string[];
}

/** Whether a removal/absence can be trusted: an incomplete tree or a small scan cannot prove something is gone. */
export type Certainty = 'observed' | 'inconclusive';

export interface IdentityChange {
  field: string;
  before: string;
  after: string;
}
export type DependencyDeltaKind =
  | 'added'
  | 'removed'
  | 'version_changed'
  | 'became_exact'
  | 'became_unresolved'
  | 'source_changed'
  | 'new_vulnerability'
  | 'resolved_vulnerability'
  | 'new_git_or_path_dependency'
  | 'new_unpinned_dependency';
export interface DependencyState {
  spec: string;
  spec_kind: string;
  resolution: string;
  version: string | null;
  version_source: string | null;
  file: string | null;
  direct: boolean;
  relationship: string;
}
export interface DependencyDelta {
  kind: DependencyDeltaKind;
  package: string;
  before?: DependencyState;
  after?: DependencyState;
  advisory_ids?: string[];
  certainty: Certainty;
  evidence_ids: string[];
}
export interface CapabilityDelta {
  capability: string;
  change: 'new' | 'removed' | 'unchanged' | 'risk_changed' | 'context_changed';
  before: { observed: boolean; risk: string; contexts: string[] } | null;
  after: { observed: boolean; risk: string; contexts: string[] } | null;
  certainty: Certainty;
}
export interface ExecutionDelta {
  change: 'new' | 'removed' | 'changed';
  hook: string;
  /** e.g. `npm postinstall -> scripts/install.js -> remote download -> piped into a shell` */
  path: string;
  for_dependents: boolean;
  risk: string;
  certainty: Certainty;
  evidence_ids: string[];
}
export interface RiskReason {
  direction: 'increase' | 'decrease';
  text: string;
  /** Delta kinds / finding ids / evidence ids this statement comes from. */
  traces: string[];
}
export interface RiskDelta {
  comparable: boolean;
  overall: { before: number | null; after: number | null; delta: number | null };
  dimensions: {
    dimension: string;
    before: number | null;
    after: number | null;
    delta: number | null;
  }[];
  /** Interpretable reasons, each traceable to a delta below; independent of the score numbers. */
  reasons: RiskReason[];
}
export interface PolicyDelta {
  block_violations_added: string[];
  block_violations_removed: string[];
  violations_added: string[];
  violations_removed: string[];
  enforced: { before: boolean | null; after: boolean | null };
}
export interface ComplianceDelta {
  subject: string;
  before: string;
  after: string;
}
export interface FindingDelta {
  change: 'added' | 'removed';
  id: string;
  title: string;
  severity: string;
  dimension: string;
  category: string;
  evidence_ids: string[];
  certainty: Certainty;
}

export interface GovernanceDelta {
  new_signals: { kind: string; role: string; detail: string }[];
  resolved_signals: string[];
  takeover_indicators_before: boolean;
  takeover_indicators_after: boolean;
  /** Set when a newly introduced install-time hook coincides with takeover indicators in the later revision's window. */
  combined_sequence: string | null;
  note: string;
}

export interface HistoricalDiff extends ReportDiff {
  governance: GovernanceDelta;
  comparability: Comparability;
  identity: IdentityChange[];
  dependencies: DependencyDelta[];
  capabilities: CapabilityDelta[];
  execution: ExecutionDelta[];
  findings: FindingDelta[];
  policy: PolicyDelta;
  compliance: ComplianceDelta[];
  risk: RiskDelta;
}

const SEV = { info: 0, low: 1, medium: 2, high: 3, critical: 4 } as Record<string, number>;
const sevRank = (s: string): number => SEV[s] ?? 0;
const MUTABLE_KINDS = new Set(['range', 'tag', 'branch', 'unpinned', 'latest', 'unknown']);
/** Only dependencies shipped to users matter for the "unpinned" signal; dev/test/build tooling is noise here. */
const runtimeRel = (d: DependencyState): boolean =>
  d.relationship === 'runtime' || d.relationship === 'optional';
const NON_REGISTRY_KINDS = new Set(['git', 'path', 'url', 'commit', 'branch']);

function comparabilityOf(a: Json, b: Json, base: ReportKey, head: ReportKey): Comparability {
  const reasons: string[] = [];
  let level: ComparabilityLevel = 'comparable';
  const lower = (to: ComparabilityLevel): void => {
    const order: ComparabilityLevel[] = ['comparable', 'reduced', 'not_directly_comparable'];
    if (order.indexOf(to) > order.indexOf(level)) level = to;
  };
  if (base.repository !== head.repository) {
    lower('not_directly_comparable');
    reasons.push(`different repositories (${base.repository} vs ${head.repository})`);
  }
  if (base.methodology !== head.methodology || base.rules_digest !== head.rules_digest) {
    lower('not_directly_comparable');
    reasons.push(
      'methodology or rule set differs: score changes may come from the method, not from the repository',
    );
  }
  if (base.schema_version !== head.schema_version) {
    lower('reduced');
    reasons.push(
      `schema versions differ (${base.schema_version} vs ${head.schema_version}); sections missing from the older report contribute no deltas`,
    );
  }
  if (base.tool_version !== head.tool_version) {
    lower('reduced');
    reasons.push(`analyzer versions differ (${base.tool_version} vs ${head.tool_version})`);
  }
  const cfg = (r: Json): string => str(obj(r['methodology'])['config_digest']);
  if (cfg(a) !== cfg(b)) {
    lower('reduced');
    reasons.push('analysis configuration differs (flags or standards packs changed)');
  }
  for (const [label, r] of [
    ['from', a],
    ['to', b],
  ] as const) {
    const ret = obj(r['retrieval']);
    if (Object.keys(ret).length > 0 && ret['complete'] !== true) {
      lower('reduced');
      reasons.push(
        `the "${label}" revision's repository tree was incomplete: something absent there may merely be unread`,
      );
    }
  }
  if (base.commit && head.commit && base.commit === head.commit)
    reasons.push('both analyses describe the same commit');
  return { level, score_deltas_meaningful: level === 'comparable', reasons };
}

function incomplete(r: Json): boolean {
  const ret = obj(r['retrieval']);
  if (Object.keys(ret).length > 0 && ret['complete'] !== true) return true;
  return false;
}
const lowScan = (r: Json): boolean => {
  const sc = obj(obj(r['code_analysis'])['scan']);
  const cov = num(sc['source_coverage']);
  return sc['performed'] === true && cov !== null && cov < 0.5;
};

function depState(d: Json): DependencyState {
  const req = obj(d['requested']);
  const res = obj(d['resolved']);
  return {
    spec: str(req['spec']),
    spec_kind: str(req['kind'], 'unknown'),
    resolution: str(d['resolution'], 'unknown'),
    version: str(res['version']) || null,
    version_source: str(res['source']) || null,
    file: str(res['file']) || str(d['manifest_path']) || null,
    direct: d['direct'] === true,
    relationship: str(d['relationship'], 'runtime'),
  };
}
const depKey = (d: Json): string =>
  `${str(obj(d['package'])['ecosystem'])}:${str(obj(d['package'])['name'])}`;

function dependencyDeltas(a: Json, b: Json): DependencyDelta[] {
  const out: DependencyDelta[] = [];
  const index = (r: Json): Map<string, Json> => {
    const m = new Map<string, Json>();
    for (const d of arr(obj(r['dependency_intel'])['dependencies']))
      if (str(d['context'], 'primary') !== 'auxiliary') m.set(depKey(d), d);
    return m;
  };
  const da = index(a);
  const db = index(b);
  const removalCertainty: Certainty = incomplete(a) || incomplete(b) ? 'inconclusive' : 'observed';
  const advisories = (d: Json): string[] => strs(obj(d['vulnerability'])['advisory_ids']);
  const id = (d: Json): string[] => [str(d['id'])].filter(Boolean);
  for (const [k, d] of db) {
    const after = depState(d);
    const o = da.get(k);
    if (!o) {
      out.push({ kind: 'added', package: k, after, certainty: 'observed', evidence_ids: id(d) });
      if (NON_REGISTRY_KINDS.has(after.spec_kind) && after.direct)
        out.push({
          kind: 'new_git_or_path_dependency',
          package: k,
          after,
          certainty: 'observed',
          evidence_ids: id(d),
        });
      else if (
        MUTABLE_KINDS.has(after.spec_kind) &&
        after.direct &&
        runtimeRel(after) &&
        after.resolution !== 'resolved'
      )
        out.push({
          kind: 'new_unpinned_dependency',
          package: k,
          after,
          certainty: 'observed',
          evidence_ids: id(d),
        });
      for (const adv of advisories(d))
        out.push({
          kind: 'new_vulnerability',
          package: k,
          after,
          advisory_ids: [adv],
          certainty: 'observed',
          evidence_ids: id(d),
        });
      continue;
    }
    const before = depState(o);
    const ev = [...id(o), ...id(d)];
    if (before.version !== after.version && (before.version || after.version))
      out.push({
        kind: 'version_changed',
        package: k,
        before,
        after,
        certainty: 'observed',
        evidence_ids: ev,
      });
    if (before.resolution !== 'resolved' && after.resolution === 'resolved')
      out.push({
        kind: 'became_exact',
        package: k,
        before,
        after,
        certainty: 'observed',
        evidence_ids: ev,
      });
    if (before.resolution === 'resolved' && after.resolution !== 'resolved')
      out.push({
        kind: 'became_unresolved',
        package: k,
        before,
        after,
        certainty: 'observed',
        evidence_ids: ev,
      });
    if (
      before.version_source !== after.version_source &&
      before.version_source &&
      after.version_source
    )
      out.push({
        kind: 'source_changed',
        package: k,
        before,
        after,
        certainty: 'observed',
        evidence_ids: ev,
      });
    if (
      NON_REGISTRY_KINDS.has(after.spec_kind) &&
      !NON_REGISTRY_KINDS.has(before.spec_kind) &&
      after.direct
    )
      out.push({
        kind: 'new_git_or_path_dependency',
        package: k,
        before,
        after,
        certainty: 'observed',
        evidence_ids: ev,
      });
    if (
      MUTABLE_KINDS.has(after.spec_kind) &&
      !MUTABLE_KINDS.has(before.spec_kind) &&
      after.direct &&
      runtimeRel(after) &&
      after.resolution !== 'resolved'
    )
      out.push({
        kind: 'new_unpinned_dependency',
        package: k,
        before,
        after,
        certainty: 'observed',
        evidence_ids: ev,
      });
    const advA = new Set(advisories(o));
    const advB = new Set(advisories(d));
    for (const adv of advB)
      if (!advA.has(adv))
        out.push({
          kind: 'new_vulnerability',
          package: k,
          before,
          after,
          advisory_ids: [adv],
          certainty: 'observed',
          evidence_ids: ev,
        });
    for (const adv of advA)
      if (!advB.has(adv))
        out.push({
          kind: 'resolved_vulnerability',
          package: k,
          before,
          after,
          advisory_ids: [adv],
          certainty: 'observed',
          evidence_ids: ev,
        });
  }
  for (const [k, d] of da)
    if (!db.has(k))
      out.push({
        kind: 'removed',
        package: k,
        before: depState(d),
        certainty: removalCertainty,
        evidence_ids: id(d),
      });
  return out;
}

function capabilityDeltas(a: Json, b: Json): CapabilityDelta[] {
  const norm = (r: Json): Map<string, CapabilityDelta['before']> => {
    const m = new Map<string, CapabilityDelta['before']>();
    for (const c of arr(obj(obj(r['code_analysis'])['capabilities'])['summary'])) {
      const observed = c['observed'] === true && c['mode'] !== 'POSSIBLE';
      m.set(str(c['capability']), {
        observed,
        risk: str(c['risk'], 'none'),
        contexts: strs(c['contexts']),
      });
    }
    return m;
  };
  const ma = norm(a);
  const mb = norm(b);
  const names = [...new Set([...ma.keys(), ...mb.keys()])].sort();
  const scanA = obj(obj(a['code_analysis'])['scan'])['performed'] === true;
  const scanB = obj(obj(b['code_analysis'])['scan'])['performed'] === true;
  const out: CapabilityDelta[] = [];
  for (const n of names) {
    const x = ma.get(n) ?? null;
    const y = mb.get(n) ?? null;
    const ox = x?.observed === true;
    const oy = y?.observed === true;
    // Without a scan on both sides nothing can be said about a capability.
    if (!scanA || !scanB) continue;
    let change: CapabilityDelta['change'] = 'unchanged';
    if (!ox && oy) change = 'new';
    else if (ox && !oy) change = 'removed';
    else if (ox && oy && x && y) {
      if (x.risk !== y.risk) change = 'risk_changed';
      else if (x.contexts.slice().sort().join() !== y.contexts.slice().sort().join())
        change = 'context_changed';
    }
    // "removed" is only an observation when both scans covered enough source; otherwise it may just be unread code.
    const certainty: Certainty =
      change === 'removed' && (incomplete(a) || incomplete(b) || lowScan(a) || lowScan(b))
        ? 'inconclusive'
        : 'observed';
    out.push({ capability: n, change, before: x, after: y, certainty });
  }
  return out;
}

function describeHook(h: Json, chains: Map<string, Json>): string {
  const parts = [`${str(h['ecosystem'])} ${str(h['name'])}`.trim()];
  const files = strs(h['files']);
  if (files.length > 0) parts.push(files.slice(0, 3).join(', '));
  for (const cid of strs(h['chain_ids']).slice(0, 2)) {
    const c = chains.get(cid);
    if (c) parts.push(strs(c['steps']).join(' -> '));
  }
  return parts.join(' -> ');
}

function executionDeltas(a: Json, b: Json): ExecutionDelta[] {
  const ex = (r: Json): { hooks: Map<string, Json>; chains: Map<string, Json> } => {
    const e = obj(obj(r['code_analysis'])['execution']);
    return {
      hooks: new Map(arr(e['hooks']).map((h) => [`${str(h['ecosystem'])}:${str(h['name'])}`, h])),
      chains: new Map(arr(e['chains']).map((c) => [str(c['id']), c])),
    };
  };
  const ea = ex(a);
  const eb = ex(b);
  const out: ExecutionDelta[] = [];
  const removalCertainty: Certainty =
    incomplete(a) || incomplete(b) || lowScan(a) || lowScan(b) ? 'inconclusive' : 'observed';
  for (const [k, h] of eb.hooks) {
    const o = ea.hooks.get(k);
    const base = {
      hook: k,
      for_dependents: h['runs_for_dependents'] === true,
      risk: str(h['risk'], 'none'),
      evidence_ids: [str(h['id']), ...strs(h['chain_ids'])].filter(Boolean),
    };
    if (!o) {
      out.push({ change: 'new', path: describeHook(h, eb.chains), certainty: 'observed', ...base });
    } else if (
      str(o['risk']) !== str(h['risk']) ||
      (o['runs_for_dependents'] === true) !== (h['runs_for_dependents'] === true) ||
      describeHook(o, ea.chains) !== describeHook(h, eb.chains)
    ) {
      out.push({
        change: 'changed',
        path: `${describeHook(o, ea.chains)}  =>  ${describeHook(h, eb.chains)}`,
        certainty: 'observed',
        ...base,
      });
    }
  }
  for (const [k, h] of ea.hooks)
    if (!eb.hooks.has(k))
      out.push({
        change: 'removed',
        hook: k,
        path: describeHook(h, ea.chains),
        for_dependents: h['runs_for_dependents'] === true,
        risk: str(h['risk'], 'none'),
        certainty: removalCertainty,
        evidence_ids: [str(h['id'])].filter(Boolean),
      });
  return out;
}

function findingDeltas(a: Json, b: Json): FindingDelta[] {
  const key = (f: Json): string => `${str(f['category'])}|${str(f['title'])}`;
  const idx = (r: Json): Map<string, Json> => new Map(arr(r['findings']).map((f) => [key(f), f]));
  const fa = idx(a);
  const fb = idx(b);
  const mk = (change: 'added' | 'removed', f: Json, certainty: Certainty): FindingDelta => ({
    change,
    id: str(f['id']),
    title: str(f['title']),
    severity: str(f['severity'], 'info'),
    dimension: str(f['dimension']),
    category: str(f['category']),
    evidence_ids: strs(f['evidence_ids']),
    certainty,
  });
  const out: FindingDelta[] = [];
  for (const [k, f] of fb) if (!fa.has(k)) out.push(mk('added', f, 'observed'));
  for (const [k, f] of fa)
    if (!fb.has(k))
      out.push(mk('removed', f, incomplete(a) || incomplete(b) ? 'inconclusive' : 'observed'));
  return out.sort(
    (x, y) => sevRank(y.severity) - sevRank(x.severity) || (x.title < y.title ? -1 : 1),
  );
}

function policyDeltas(a: Json, b: Json): PolicyDelta {
  const ids = (r: Json, f: string): Set<string> =>
    new Set(
      arr(obj(r['policy'])[f]).map((x) => str(x['id']) || str(x['rule_id']) || str(x['dimension'])),
    );
  const diff = (x: Set<string>, y: Set<string>): string[] => [...y].filter((v) => !x.has(v)).sort();
  const bva = ids(a, 'block_violations');
  const bvb = ids(b, 'block_violations');
  const va = ids(a, 'violations');
  const vb = ids(b, 'violations');
  const en = (r: Json): boolean | null =>
    typeof obj(r['policy'])['enforced'] === 'boolean'
      ? (obj(r['policy'])['enforced'] as boolean)
      : null;
  return {
    block_violations_added: diff(bva, bvb),
    block_violations_removed: diff(bvb, bva),
    violations_added: diff(va, vb),
    violations_removed: diff(vb, va),
    enforced: { before: en(a), after: en(b) },
  };
}

function complianceDeltas(a: Json, b: Json): ComplianceDelta[] {
  const out: ComplianceDelta[] = [];
  const packs = (r: Json): Map<string, string> =>
    new Map(
      arr(obj(r['regulatory'])['packs']).map((p) => [
        str(p['pack']),
        str(obj(p['applicability'])['state'], 'unknown'),
      ]),
    );
  const pa = packs(a);
  const pb = packs(b);
  for (const [k, v] of pb) {
    const o = pa.get(k);
    if (o !== undefined && o !== v)
      out.push({ subject: `pack ${k} applicability`, before: o, after: v });
  }
  const ind = (r: Json): Set<string> =>
    new Set(
      arr(obj(r['regulatory'])['indicators']).map(
        (i) => `${str(i['family'])}.${str(i['category'])}`,
      ),
    );
  const ia = ind(a);
  const ib = ind(b);
  for (const k of ib)
    if (!ia.has(k))
      out.push({ subject: `indicator ${k}`, before: 'not observed', after: 'observed' });
  for (const k of ia)
    if (!ib.has(k))
      out.push({ subject: `indicator ${k}`, before: 'observed', after: 'not observed' });
  return out;
}

function identityChanges(a: Json, b: Json): IdentityChange[] {
  const out: IdentityChange[] = [];
  const cmp = (field: string, x: unknown, y: unknown): void => {
    const sx = Array.isArray(x) ? x.join(', ') : str(x);
    const sy = Array.isArray(y) ? y.join(', ') : str(y);
    if (sx !== sy && (sx || sy)) out.push({ field, before: sx || '(none)', after: sy || '(none)' });
  };
  const v2a = obj(a['identity_v2']);
  const v2b = obj(b['identity_v2']);
  if (Object.keys(v2a).length > 0 && Object.keys(v2b).length > 0) {
    cmp(
      'primary_artifact',
      obj(v2a['primary_artifact'])['value'],
      obj(v2b['primary_artifact'])['value'],
    );
    cmp('packaging', obj(v2a['packaging'])['value'], obj(v2b['packaging'])['value']);
    cmp('secondary_roles', v2a['secondary_roles'], v2b['secondary_roles']);
    cmp('interfaces', v2a['interfaces'], v2b['interfaces']);
    cmp(
      'deployment_form',
      obj(v2a['deployment_form'])['value'],
      obj(v2b['deployment_form'])['value'],
    );
  } else
    cmp('artifact_type', obj(a['identity'])['artifact_type'], obj(b['identity'])['artifact_type']);
  cmp('domain', obj(a['identity'])['domain'], obj(b['identity'])['domain']);
  cmp('ecosystem', obj(a['identity'])['ecosystem'], obj(b['identity'])['ecosystem']);
  return out;
}

function riskDelta(
  a: Json,
  b: Json,
  c: Comparability,
  deps: DependencyDelta[],
  caps: CapabilityDelta[],
  exec: ExecutionDelta[],
  findings: FindingDelta[],
  policy: PolicyDelta,
  base: Change[],
  gov: GovernanceDelta,
): RiskDelta {
  const score = (r: Json, dimension: string): number | null => {
    if (dimension === 'overall') return num(obj(r['overall'])['score']);
    const d = arr(r['dimensions']).find((x) => x['dimension'] === dimension);
    return d ? num(d['score']) : null;
  };
  const dims = [
    ...new Set([...arr(a['dimensions']), ...arr(b['dimensions'])].map((d) => str(d['dimension']))),
  ]
    .filter(Boolean)
    .sort();
  const delta = (x: number | null, y: number | null): number | null =>
    c.score_deltas_meaningful && x !== null && y !== null ? Math.round((y - x) * 10) / 10 : null;
  const reasons: RiskReason[] = [];
  const up = (text: string, ...traces: string[]): void =>
    void reasons.push({ direction: 'increase', text, traces });
  const down = (text: string, ...traces: string[]): void =>
    void reasons.push({ direction: 'decrease', text, traces });
  for (const d of deps.filter((x) => x.kind === 'new_vulnerability'))
    up(
      `new vulnerability ${d.advisory_ids?.join(', ') ?? ''} in ${d.package}`,
      'dependency:new_vulnerability',
      ...d.evidence_ids,
    );
  for (const d of deps.filter((x) => x.kind === 'resolved_vulnerability'))
    down(
      `vulnerability ${d.advisory_ids?.join(', ') ?? ''} no longer affects ${d.package}`,
      'dependency:resolved_vulnerability',
      ...d.evidence_ids,
    );
  for (const d of deps.filter((x) => x.kind === 'new_git_or_path_dependency'))
    up(
      `${d.package} is now a git/path/URL dependency (mutable, not registry-verified)`,
      'dependency:new_git_or_path_dependency',
    );
  const unpinned = deps.filter((x) => x.kind === 'new_unpinned_dependency');
  if (unpinned.length > 0)
    up(
      `${unpinned.length} new unpinned runtime dependenc${unpinned.length === 1 ? 'y' : 'ies'} (${unpinned
        .slice(0, 3)
        .map((x) => x.package)
        .join(', ')}${unpinned.length > 3 ? ', ...' : ''})`,
      'dependency:new_unpinned_dependency',
    );
  for (const e of exec) {
    if (e.change === 'new' && e.for_dependents)
      up(`new install-time hook: ${e.path}`, 'execution:new', ...e.evidence_ids);
    else if (e.change === 'new' && (e.risk === 'high' || e.risk === 'medium'))
      up(`new ${e.risk}-risk execution path: ${e.path}`, 'execution:new', ...e.evidence_ids);
    else if (
      e.change === 'removed' &&
      e.certainty === 'observed' &&
      (e.for_dependents || e.risk === 'high')
    )
      down(`execution path removed: ${e.path}`, 'execution:removed', ...e.evidence_ids);
  }
  for (const k of caps) {
    if (k.change === 'new' && k.after && k.after.risk !== 'none' && k.after.risk !== 'low')
      up(`new capability ${k.capability} (${k.after.risk} risk)`, 'capability:new');
    else if (
      k.change === 'removed' &&
      k.certainty === 'observed' &&
      k.before &&
      k.before.risk !== 'none'
    )
      down(`capability ${k.capability} no longer observed`, 'capability:removed');
    else if (
      k.change === 'context_changed' &&
      k.after?.contexts.includes('install') &&
      !k.before?.contexts.includes('install')
    )
      up(
        `capability ${k.capability} now also occurs at install time`,
        'capability:context_changed',
      );
  }
  for (const f of findings) {
    if (f.change === 'added' && sevRank(f.severity) >= 2)
      up(`new ${f.severity} finding: ${f.title}`, 'finding:added', f.id, ...f.evidence_ids);
    if (f.change === 'removed' && f.certainty === 'observed' && sevRank(f.severity) >= 2)
      down(`${f.severity} finding gone: ${f.title}`, 'finding:removed', f.id);
  }
  if (gov.combined_sequence) up(gov.combined_sequence, 'governance:combined_sequence');
  for (const v of policy.block_violations_added)
    up(`policy block now violated: ${v}`, 'policy:block');
  for (const v of policy.block_violations_removed)
    down(`policy block no longer violated: ${v}`, 'policy:block');
  for (const ch of base) {
    if (ch.category === 'governance_changed' && ch.subject === 'github.branch.default_protected') {
      if (ch.after === 'true') down('default branch is now protected', 'governance_changed');
      else if (ch.after === 'false')
        up('default branch is no longer protected', 'governance_changed');
    }
    if (ch.category === 'sbom_changed') {
      if (ch.before === 'none') down(`SBOM added: ${ch.after ?? ''}`, 'sbom_changed');
      else if (ch.after === 'none') up('SBOM removed', 'sbom_changed');
    }
  }
  return {
    comparable: c.score_deltas_meaningful,
    overall: {
      before: score(a, 'overall'),
      after: score(b, 'overall'),
      delta: delta(score(a, 'overall'), score(b, 'overall')),
    },
    dimensions: dims.map((d) => ({
      dimension: d,
      before: score(a, d),
      after: score(b, d),
      delta: delta(score(a, d), score(b, d)),
    })),
    reasons,
  };
}

function governanceDelta(a: Json, b: Json, exec: ExecutionDelta[]): GovernanceDelta {
  const sig = (r: Json): Map<string, Json> =>
    new Map(
      arr(obj(r['governance'])['signals']).map((x) => [`${str(x['kind'])}|${str(x['at'])}`, x]),
    );
  const sa = sig(a);
  const sb = sig(b);
  const tk = (r: Json): boolean =>
    obj(obj(r['governance'])['takeover_indicators'])['observed'] === true;
  const newHook = exec.some(
    (e) => e.change === 'new' && e.for_dependents && e.certainty === 'observed',
  );
  return {
    new_signals: [...sb]
      .filter(([k]) => !sa.has(k))
      .map(([, x]) => ({
        kind: str(x['kind']),
        role: str(x['role']),
        detail: str(x['detail']).slice(0, 200),
      })),
    resolved_signals: [...sa].filter(([k]) => !sb.has(k)).map(([, x]) => str(x['kind'])),
    takeover_indicators_before: tk(a),
    takeover_indicators_after: tk(b),
    combined_sequence:
      newHook && tk(b)
        ? 'A new install-time hook appears in a revision whose recent history shows takeover risk indicators (dormancy, a new account, a release soon after). Intent is undetermined.'
        : null,
    note: 'Governance signals are computed from the commit window ending at each revision. Release authors and the contributor list reflect the CURRENT state of the repository, not the revision, so they are not compared here.',
  };
}

export function compareSnapshots(oldReport: unknown, newReport: unknown): HistoricalDiff {
  const a = obj(oldReport);
  const b = obj(newReport);
  const base = diffReports(a, b);
  const comparability = comparabilityOf(a, b, base.from, base.to);
  const dependencies = dependencyDeltas(a, b);
  const capabilities = capabilityDeltas(a, b);
  const execution = executionDeltas(a, b);
  const findings = findingDeltas(a, b);
  const policy = policyDeltas(a, b);
  const compliance = complianceDeltas(a, b);
  const identity = identityChanges(a, b);
  const risk = riskDelta(
    a,
    b,
    comparability,
    dependencies,
    capabilities,
    execution,
    findings,
    policy,
    base.changes,
    governanceDelta(a, b, execution),
  );
  return {
    ...base,
    caveats: [...new Set([...base.caveats, ...comparability.reasons])],
    comparability,
    identity,
    dependencies,
    capabilities,
    execution,
    findings,
    policy,
    compliance,
    risk,
    governance: governanceDelta(a, b, execution),
  };
}
