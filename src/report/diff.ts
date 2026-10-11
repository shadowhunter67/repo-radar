/**
 * Report comparison. Two reports of the same repository (different commits, different analysis versions, different
 * dates) are compared by stable keys, never by position or by generated ids. Reports of older schema versions are
 * read defensively: a missing section simply contributes no changes, and the comparison says so.
 *
 * Nothing here judges whether a change is good or bad; it states what is new, what is gone and what moved.
 */
export const CHANGE_CATEGORIES = [
  'dependency_added',
  'dependency_removed',
  'dependency_version_changed',
  'capability_added',
  'capability_removed',
  'hook_added',
  'hook_removed',
  'vulnerability_added',
  'vulnerability_removed',
  'persistence_added',
  'persistence_removed',
  'sbom_changed',
  'finding_added',
  'finding_removed',
  'governance_changed',
  'score_changed',
] as const;
export type ChangeCategory = (typeof CHANGE_CATEGORIES)[number];

export interface Change {
  category: ChangeCategory;
  subject: string;
  before?: string;
  after?: string;
}

export interface ReportKey {
  repository: string;
  commit: string | null;
  tool_version: string;
  schema_version: string;
  methodology: string;
  rules_digest: string;
  generated_at: string;
}

export interface ReportDiff {
  from: ReportKey;
  to: ReportKey;
  /** What limits the comparison (different repository, schema or methodology, missing sections). */
  caveats: string[];
  changes: Change[];
  summary: Partial<Record<ChangeCategory, number>>;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {};
const arr = (v: unknown): Json[] => (Array.isArray(v) ? v.map(obj) : []);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);

function keyOf(r: Json): ReportKey {
  const subject = obj(r['subject']);
  const tool = obj(r['tool']);
  const meth = obj(r['methodology']);
  return {
    repository: `${str(subject['owner'], '?')}/${str(subject['repo'], '?')}`,
    commit: typeof subject['ref'] === 'string' ? (subject['ref'] as string) : null,
    tool_version: str(tool['version'], '?'),
    schema_version: str(r['schema_version'], '?'),
    methodology: str(meth['version'], '?'),
    rules_digest: str(meth['rules_digest'], '?'),
    generated_at: str(r['generated_at'], '?'),
  };
}

function setDiff<T>(
  a: Map<string, T>,
  b: Map<string, T>,
  added: (k: string, v: T) => Change,
  removed: (k: string, v: T) => Change,
  out: Change[],
): void {
  for (const [k, v] of b) if (!a.has(k)) out.push(added(k, v));
  for (const [k, v] of a) if (!b.has(k)) out.push(removed(k, v));
}

export function diffReports(oldReport: unknown, newReport: unknown): ReportDiff {
  const a = obj(oldReport);
  const b = obj(newReport);
  const from = keyOf(a);
  const to = keyOf(b);
  const caveats: string[] = [];
  const changes: Change[] = [];
  if (from.repository !== to.repository)
    caveats.push(
      `different repositories (${from.repository} vs ${to.repository}); the comparison is structural only`,
    );
  if (from.schema_version !== to.schema_version)
    caveats.push(
      `schema versions differ (${from.schema_version} vs ${to.schema_version}); sections missing from the older report contribute no changes`,
    );
  if (from.methodology !== to.methodology || from.rules_digest !== to.rules_digest)
    caveats.push(
      'methodology or rule set differs: score changes may come from the method, not from the repository',
    );
  if (from.commit && to.commit && from.commit === to.commit)
    caveats.push('both reports describe the same commit');

  // dependencies (direct ones listed in the report), vulnerabilities, SBOM
  const depMap = (r: Json): Map<string, { version: string; advisories: string[] }> => {
    const m = new Map<string, { version: string; advisories: string[] }>();
    for (const d of arr(obj(r['dependency_intel'])['dependencies'])) {
      const pkg = obj(d['package']);
      const key = `${str(pkg['ecosystem'])}:${str(pkg['name'])}`;
      const resolved = obj(d['resolved']);
      const requested = obj(d['requested']);
      m.set(key, {
        version: str(resolved['version']) || `range ${str(requested['spec'])}`,
        advisories: Array.isArray(obj(d['vulnerability'])['advisory_ids'])
          ? (obj(d['vulnerability'])['advisory_ids'] as unknown[]).filter(
              (x): x is string => typeof x === 'string',
            )
          : [],
      });
    }
    return m;
  };
  const da = depMap(a);
  const db = depMap(b);
  setDiff(
    da,
    db,
    (k, v) => ({ category: 'dependency_added', subject: k, after: v.version }),
    (k, v) => ({ category: 'dependency_removed', subject: k, before: v.version }),
    changes,
  );
  for (const [k, v] of db) {
    const o = da.get(k);
    if (!o) {
      // A newly added dependency that already carries advisories is also a new vulnerability.
      for (const adv of v.advisories)
        changes.push({ category: 'vulnerability_added', subject: `${k} ${adv}`, after: v.version });
      continue;
    }
    if (o.version !== v.version)
      changes.push({
        category: 'dependency_version_changed',
        subject: k,
        before: o.version,
        after: v.version,
      });
    for (const adv of v.advisories)
      if (!o.advisories.includes(adv))
        changes.push({ category: 'vulnerability_added', subject: `${k} ${adv}`, after: v.version });
    for (const adv of o.advisories)
      if (!v.advisories.includes(adv))
        changes.push({
          category: 'vulnerability_removed',
          subject: `${k} ${adv}`,
          before: o.version,
        });
  }

  const sb = (r: Json): string => {
    const docs = arr(obj(r['dependency_intel'])['sboms']).filter((d) => d['status'] === 'parsed');
    const cmp = arr(obj(r['dependency_intel'])['sbom_comparisons'])[0];
    return docs.length === 0
      ? 'none'
      : `${docs.map((d) => `${str(d['format'])} ${str(d['path'])}`).join(', ')}${cmp ? ` [${str(cmp['state'])}]` : ''}`;
  };
  if (sb(a) !== sb(b))
    changes.push({ category: 'sbom_changed', subject: 'SBOM', before: sb(a), after: sb(b) });

  // capabilities, hooks, persistence
  const caps = (r: Json): Map<string, string> => {
    const m = new Map<string, string>();
    for (const c of arr(obj(obj(r['code_analysis'])['capabilities'])['summary']))
      if (c['observed'] === true && c['mode'] !== 'POSSIBLE')
        m.set(str(c['capability']), str(c['risk']));
    return m;
  };
  setDiff(
    caps(a),
    caps(b),
    (k, v) => ({ category: 'capability_added', subject: k, after: `risk ${v}` }),
    (k, v) => ({ category: 'capability_removed', subject: k, before: `risk ${v}` }),
    changes,
  );
  const hooks = (r: Json): Map<string, string> => {
    const m = new Map<string, string>();
    for (const h of arr(obj(obj(r['code_analysis'])['execution'])['hooks']))
      m.set(
        `${str(h['ecosystem'])}:${str(h['name'])}`,
        `${h['runs_for_dependents'] === true ? 'for dependents, ' : ''}risk ${str(h['risk'])}`,
      );
    return m;
  };
  setDiff(
    hooks(a),
    hooks(b),
    (k, v) => ({ category: 'hook_added', subject: k, after: v }),
    (k, v) => ({ category: 'hook_removed', subject: k, before: v }),
    changes,
  );
  const pers = (r: Json): string[] => {
    const p = obj(obj(r['code_analysis'])['persistence']);
    return p['observed'] === true && Array.isArray(p['kinds'])
      ? (p['kinds'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
  };
  const pa = new Set(pers(a));
  const pb = new Set(pers(b));
  for (const k of pb) if (!pa.has(k)) changes.push({ category: 'persistence_added', subject: k });
  for (const k of pa) if (!pb.has(k)) changes.push({ category: 'persistence_removed', subject: k });

  // findings (by category + title: ids are not stable between runs)
  const fnd = (r: Json): Map<string, string> => {
    const m = new Map<string, string>();
    for (const f of arr(r['findings']))
      m.set(`${str(f['category'])}: ${str(f['title'])}`, str(f['severity']));
    return m;
  };
  setDiff(
    fnd(a),
    fnd(b),
    (k, v) => ({ category: 'finding_added', subject: k, after: v }),
    (k, v) => ({ category: 'finding_removed', subject: k, before: v }),
    changes,
  );

  // governance-ish evidence and scores
  const ev = (r: Json, id: string): unknown =>
    arr(r['evidence']).find((e) => e['id'] === id)?.['value'];
  for (const id of [
    'github.contributors.bus_factor',
    'github.contributors.top_share',
    'github.contributors.count',
    'github.branch.default_protected',
  ]) {
    const x = ev(a, id);
    const y = ev(b, id);
    if (x !== undefined && y !== undefined && JSON.stringify(x) !== JSON.stringify(y))
      changes.push({
        category: 'governance_changed',
        subject: id,
        before: JSON.stringify(x),
        after: JSON.stringify(y),
      });
  }
  const scores = (r: Json): Map<string, number | null> => {
    const m = new Map<string, number | null>();
    for (const d of arr(r['dimensions']))
      m.set(str(d['dimension']), typeof d['score'] === 'number' ? (d['score'] as number) : null);
    const ov = obj(r['overall']);
    m.set('overall', typeof ov['score'] === 'number' ? (ov['score'] as number) : null);
    return m;
  };
  const sa = scores(a);
  const sbm = scores(b);
  for (const [k, v] of sbm) {
    const o = sa.get(k);
    if (o !== undefined && o !== v)
      changes.push({ category: 'score_changed', subject: k, before: String(o), after: String(v) });
  }

  const summary: ReportDiff['summary'] = {};
  for (const c of changes) summary[c.category] = (summary[c.category] ?? 0) + 1;
  return { from, to, caveats, changes, summary };
}

export function renderDiffText(d: ReportDiff): string {
  const clip = (s: string, n = 120): string => s.replace(/[^\x20-\x7e]/g, '?').slice(0, n);
  const lines = [
    `repo-radar diff: ${clip(d.from.repository)} ${clip(d.from.commit?.slice(0, 10) ?? 'unpinned')} (${clip(d.from.generated_at, 24)}) -> ${clip(d.to.repository)} ${clip(d.to.commit?.slice(0, 10) ?? 'unpinned')} (${clip(d.to.generated_at, 24)})`,
    `analysis: tool ${clip(d.from.tool_version, 20)} schema ${clip(d.from.schema_version, 10)} methodology ${clip(d.from.methodology, 10)} -> tool ${clip(d.to.tool_version, 20)} schema ${clip(d.to.schema_version, 10)} methodology ${clip(d.to.methodology, 10)}`,
  ];
  for (const c of d.caveats) lines.push(`caveat: ${clip(c, 200)}`);
  if (d.changes.length === 0) lines.push('no changes in the compared sections');
  for (const cat of CHANGE_CATEGORIES) {
    const items = d.changes.filter((c) => c.category === cat);
    if (items.length === 0) continue;
    lines.push('', `${cat} (${items.length})`);
    for (const c of items.slice(0, 40))
      lines.push(
        `  ${clip(c.subject)}${c.before !== undefined ? `  ${clip(c.before, 60)}` : ''}${c.after !== undefined ? `  ->  ${clip(c.after, 60)}` : ''}`,
      );
    if (items.length > 40) lines.push(`  ... ${items.length - 40} more`);
  }
  return lines.join('\n') + '\n';
}
