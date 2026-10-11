/**
 * Small, bounded semver implementation (npm and Cargo flavours). It exists to answer two questions only:
 *  - is this specification an exact pin?
 *  - does a given version satisfy a requested range (to detect lockfile/SBOM disagreements)?
 * Anything it cannot parse yields `undefined` ("cannot tell"), never `true`.
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
}

const MAX_LEN = 200;
const VERSION =
  /^v?(\d{1,9})(?:\.(\d{1,9}|[xX*]))?(?:\.(\d{1,9}|[xX*]))?(?:-([0-9A-Za-z.-]{1,80}))?(?:\+[0-9A-Za-z.-]{1,80})?$/;

interface Partial3 {
  major: number | undefined;
  minor: number | undefined;
  patch: number | undefined;
  pre: string[];
  /** number of explicit numeric parts (1..3) */
  parts: number;
}

function parsePartial(s: string): Partial3 | undefined {
  if (s.length > MAX_LEN) return undefined;
  if (s === '' || s === '*' || /^[xX]$/.test(s))
    return { major: undefined, minor: undefined, patch: undefined, pre: [], parts: 0 };
  const m = VERSION.exec(s);
  if (!m) return undefined;
  const num = (v: string | undefined): number | undefined =>
    v === undefined || /^[xX*]$/.test(v) ? undefined : Number(v);
  const major = num(m[1]);
  const minor = num(m[2]);
  const patch = num(m[3]);
  const parts = patch !== undefined ? 3 : minor !== undefined ? 2 : major !== undefined ? 1 : 0;
  return { major, minor, patch, pre: m[4] ? m[4].split('.') : [], parts };
}

export function parseVersion(s: string): SemVer | undefined {
  const p = parsePartial(s.trim());
  if (!p || p.parts !== 3) return undefined;
  return {
    major: p.major as number,
    minor: p.minor as number,
    patch: p.patch as number,
    pre: p.pre,
  };
}

function cmpPre(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (nx !== ny) return nx ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function compareVersions(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return cmpPre(a.pre, b.pre);
}

type Op = '<' | '<=' | '>' | '>=' | '=';
interface Comparator {
  op: Op;
  v: SemVer;
}

const lower = (p: Partial3): SemVer => ({
  major: p.major ?? 0,
  minor: p.minor ?? 0,
  patch: p.patch ?? 0,
  pre: p.pre,
});

/** Expand one token (`^1.2`, `~1`, `>=1.0.0`, `1.x`, `1.2.3`) into comparators; undefined if unparseable. */
function expand(token: string, flavor: 'npm' | 'cargo'): Comparator[] | undefined {
  const m = /^(\^|~>?|>=|<=|>|<|=)?\s*(.*)$/.exec(token);
  if (!m) return undefined;
  const op = m[1] ?? '';
  const p = parsePartial((m[2] ?? '').trim());
  if (!p) return undefined;
  if (p.parts === 0)
    return op === '<' ? [{ op: '<', v: { major: 0, minor: 0, patch: 0, pre: [] } }] : [];
  const lo = lower(p);
  const next = (kind: 'major' | 'minor' | 'patch'): SemVer =>
    kind === 'major'
      ? { major: lo.major + 1, minor: 0, patch: 0, pre: [] }
      : kind === 'minor'
        ? { major: lo.major, minor: lo.minor + 1, patch: 0, pre: [] }
        : { major: lo.major, minor: lo.minor, patch: lo.patch + 1, pre: [] };
  const bare = op === '' || op === '=';
  if (op === '^' || (op === '' && flavor === 'cargo')) {
    let hi: SemVer;
    if (p.major !== 0 || p.parts === 1) hi = next('major');
    else if (p.minor !== 0 || p.parts === 2) hi = next('minor');
    else hi = next('patch');
    return [
      { op: '>=', v: lo },
      { op: '<', v: hi },
    ];
  }
  if (op === '~' || op === '~>') {
    const hi = p.parts === 1 ? next('major') : next('minor');
    return [
      { op: '>=', v: lo },
      { op: '<', v: hi },
    ];
  }
  if (bare) {
    if (p.parts === 3) return [{ op: '=', v: lo }];
    return [
      { op: '>=', v: lo },
      { op: '<', v: p.parts === 1 ? next('major') : next('minor') },
    ];
  }
  // comparison operators with partial versions
  if (op === '>')
    return p.parts === 3
      ? [{ op: '>', v: lo }]
      : [{ op: '>=', v: p.parts === 1 ? next('major') : next('minor') }];
  if (op === '<=')
    return p.parts === 3
      ? [{ op: '<=', v: lo }]
      : [{ op: '<', v: p.parts === 1 ? next('major') : next('minor') }];
  return [{ op: op as Op, v: lo }];
}

function holds(c: Comparator, v: SemVer): boolean {
  const r = compareVersions(v, c.v);
  switch (c.op) {
    case '<':
      return r < 0;
    case '<=':
      return r <= 0;
    case '>':
      return r > 0;
    case '>=':
      return r >= 0;
    default:
      return r === 0;
  }
}

/**
 * true/false when the range could be parsed, undefined when it could not (including tags and non-semver specs).
 * npm rule kept: a pre-release only satisfies a range that mentions a pre-release of the same major.minor.patch.
 */
export function satisfies(
  range: string,
  version: string,
  flavor: 'npm' | 'cargo',
): boolean | undefined {
  if (range.length > MAX_LEN) return undefined;
  const v = parseVersion(version);
  if (!v) return undefined;
  const alternatives = flavor === 'npm' ? range.split('||') : [range];
  if (alternatives.length > 20) return undefined;
  let parsedAny = false;
  for (const alt of alternatives) {
    let text = alt.trim();
    if (flavor === 'cargo') text = text.replace(/,/g, ' ');
    // hyphen range "1.2.3 - 2.3.4"
    text = text.replace(/^(\S+)\s+-\s+(\S+)$/, '>=$1 <=$2');
    // "^ 1.2" / ">= 1.2" operator separated from the version
    text = text.replace(/(\^|~>?|>=|<=|>|<|=)\s+/g, '$1');
    const tokens = text === '' ? [''] : text.split(/\s+/);
    if (tokens.length > 10) return undefined;
    const comps: Comparator[] = [];
    let ok = true;
    for (const t of tokens) {
      const e = expand(t, flavor);
      if (!e) {
        ok = false;
        break;
      }
      comps.push(...e);
    }
    if (!ok) continue;
    parsedAny = true;
    if (!comps.every((c) => holds(c, v))) continue;
    if (v.pre.length > 0) {
      const allowed = comps.some(
        (c) =>
          c.v.pre.length > 0 &&
          c.v.major === v.major &&
          c.v.minor === v.minor &&
          c.v.patch === v.patch,
      );
      if (!allowed) continue;
    }
    return true;
  }
  return parsedAny ? false : undefined;
}

/** `1.2.3`, `=1.2.3`, `v1.2.3`, `1.2.3-beta.1` (npm). Ranges, tags and x-ranges are not exact. */
export function exactNpmVersion(spec: string): string | undefined {
  const t = spec.trim().replace(/^[=v]+/, '');
  const m = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(-[0-9A-Za-z.-]{1,80})?(\+[0-9A-Za-z.-]{1,80})?$/.exec(
    t,
  );
  return m ? t : undefined;
}

/** Highest stable version satisfying `range` among `versions`; undefined if none or unparseable. */
export function maxSatisfying(
  range: string,
  versions: string[],
  flavor: 'npm' | 'cargo',
): string | undefined {
  let best: { s: string; v: SemVer } | undefined;
  for (const s of versions.slice(0, 5000)) {
    const v = parseVersion(s);
    if (!v || v.pre.length > 0) continue;
    if (satisfies(range, s, flavor) !== true) continue;
    if (!best || compareVersions(v, best.v) > 0) best = { s, v };
  }
  return best?.s;
}
