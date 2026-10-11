import { sanitizeForTerminal } from '../util/text.js';
import type { DepEcosystem, Requested } from './model.js';
import { exactNpmVersion, parseVersion, satisfies } from './semver.js';

const MAX_SPEC = 200;
const HEX_COMMIT = /^[0-9a-f]{7,40}$/i;

/**
 * Classify what a manifest asks for. Parsers normalize non-string forms (Cargo tables, PEP 508 direct references)
 * into prefixed strings first: `path:<p>`, `git:<url>#<rev>`, `url:<u>`, `workspace`.
 * The original text is always preserved (bounded, control characters removed).
 */
export function classifySpec(ecosystem: DepEcosystem, rawSpec: string): Requested {
  const spec = sanitizeForTerminal(rawSpec.trim(), MAX_SPEC);
  const s = rawSpec.trim();
  const out = (kind: Requested['kind'], extra: Partial<Requested> = {}): Requested => ({
    spec,
    kind,
    ...extra,
  });

  if (s === 'workspace' || s.startsWith('workspace:')) return out('workspace');
  if (s.startsWith('inherited:')) return out('range');
  if (/^(?:path:|file:|link:|portal:)/.test(s) || /^(?:\.{1,2}\/|\/|~\/)/.test(s))
    return out('path');
  if (/^(?:git\+|git:|ssh:|github:|gitlab:|bitbucket:|gist:)/.test(s)) return out(gitKind(s));
  if (/^https?:\/\//.test(s) || s.startsWith('url:')) return out('url');

  switch (ecosystem) {
    case 'npm':
      return classifyNpm(s, out);
    case 'PyPI':
      return classifyPypi(s, out);
    case 'crates.io':
      return classifyCargo(s, out);
    case 'Maven':
      return classifyMaven(s, out);
    case 'Go':
      return /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(s)
        ? out('exact', { exact_version: s })
        : out('unknown');
    default:
      return out(s ? 'unknown' : 'range');
  }
}

function gitKind(s: string): Requested['kind'] {
  const frag = s.includes('#') ? s.slice(s.indexOf('#') + 1) : '';
  if (!frag) return 'branch'; // default branch: mutable
  if (/^(?:rev=)?[0-9a-f]{40}$/i.test(frag) || /^rev=[0-9a-f]{7,40}$/i.test(frag)) return 'commit';
  if (frag.startsWith('semver:')) return 'range';
  if (/^tag=/.test(frag)) return 'tag';
  return HEX_COMMIT.test(frag) && frag.length >= 12 ? 'commit' : 'branch';
}

function classifyNpm(
  s: string,
  out: (k: Requested['kind'], e?: Partial<Requested>) => Requested,
): Requested {
  if (s.startsWith('npm:')) {
    const inner = s.slice(4);
    const at = inner.lastIndexOf('@');
    const aliasOf = at > 0 ? inner.slice(0, at) : inner;
    const innerSpec = at > 0 ? inner.slice(at + 1) : '';
    const r = classifyNpm(innerSpec, (k, e) => ({
      spec: sanitizeForTerminal(s, MAX_SPEC),
      kind: k,
      ...e,
    }));
    return { ...r, alias_of: sanitizeForTerminal(aliasOf, 214) };
  }
  // GitHub shorthand: user/repo[#ref]
  if (/^[A-Za-z0-9][\w.-]*\/[\w.-]+(?:#\S+)?$/.test(s)) return out(gitKind(s));
  const exact = exactNpmVersion(s);
  if (exact) return out('exact', { exact_version: exact });
  if (s === '' || s === '*' || /^[xX]$/.test(s)) return out('range');
  if (/^[A-Za-z][\w.-]*$/.test(s) && !/^[xX]$/.test(s)) return out('tag');
  return satisfies(s, '0.0.0', 'npm') === undefined ? out('unknown') : out('range');
}

function classifyPypi(
  s: string,
  out: (k: Requested['kind'], e?: Partial<Requested>) => Requested,
): Requested {
  const eq = /^===?\s*([0-9][0-9A-Za-z.!+_-]*)$/.exec(s);
  if (eq && eq[1] && !eq[1].includes('*')) return out('exact', { exact_version: eq[1] });
  // Poetry bare version is a pin; PEP 440 never writes a bare version.
  if (/^[0-9]+(?:\.[0-9]+){1,3}(?:(?:a|b|rc|\.post|\.dev)[0-9]+)?$/.test(s))
    return out('exact', { exact_version: s });
  if (s === '' || s === '*') return out('range');
  return /^[\^~<>=!,.\s0-9A-Za-z*+_-]+$/.test(s) ? out('range') : out('unknown');
}

function classifyCargo(
  s: string,
  out: (k: Requested['kind'], e?: Partial<Requested>) => Requested,
): Requested {
  const eq = /^=\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(s);
  if (eq && eq[1]) return out('exact', { exact_version: eq[1] });
  if (s === '' || s === '*') return out('range');
  // A bare `1.2.3` in Cargo is a caret requirement, not a pin.
  return parseVersion(s) ||
    satisfies(s, '0.0.0', 'cargo') !== undefined ||
    /^[\^~<>=,.\s0-9*xX-]+$/.test(s)
    ? out('range')
    : out('unknown');
}

function classifyMaven(
  s: string,
  out: (k: Requested['kind'], e?: Partial<Requested>) => Requested,
): Requested {
  if (s === '') return out('range'); // version managed elsewhere (parent POM, BOM, platform)
  if (s.includes('${')) return out('unknown'); // unresolved property
  if (/^[[(]/.test(s)) return out('range'); // Maven version range [1.0,2.0)
  if (/^(?:LATEST|RELEASE|latest\.(?:release|integration))$/i.test(s) || /-SNAPSHOT$/i.test(s))
    return out('tag');
  if (/\+$/.test(s)) return out('range'); // Gradle dynamic version 1.+
  return /^\d[\w.-]{0,80}$/.test(s) ? out('exact', { exact_version: s }) : out('unknown');
}

/** Specification kinds that cannot be looked up in a registry (no vulnerability conclusion is possible by name). */
export const NON_REGISTRY_KINDS = new Set<Requested['kind']>([
  'workspace',
  'path',
  'git',
  'commit',
  'branch',
  'url',
]);

/** Mutable git references and bare tags are supply-chain signals of their own. */
export const MUTABLE_KINDS = new Set<Requested['kind']>(['branch', 'tag']);
