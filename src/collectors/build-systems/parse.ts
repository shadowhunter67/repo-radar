import { BuildSourcesSchema, type BuildSources, type BuildDependency } from './model.js';
const cap = (s: string): string => s.slice(0, 256);
const dynamic = (s: string): number =>
  [...s.matchAll(/\b(?:load|macro|let|import)\b|\$\{|\+\s*["']/g)].length;
/** Remove whole-line comments before structural matching. A comment is repository text, not a declaration. */
const withoutCommentLines = (s: string): string =>
  s
    .split(/\r?\n/)
    .map((line) => (/^\s*#/.test(line) ? '' : line))
    .join('\n');
function bazel(path: string, text: string): BuildSources['files'][number] {
  const deps: BuildDependency[] = [];
  const sourceText = withoutCommentLines(text);
  for (const m of sourceText
    .slice(0, 1024 * 1024)
    .matchAll(
      /(?:^|\n)\s*bazel_dep\s*\(\s*name\s*=\s*["']([^"']+)["'](?:[^)]*?version\s*=\s*["']([^"']*)["'])?/g,
    ))
    deps.push({
      name: m[1]!,
      source: null,
      checksum: null,
      pinned: !!m[2],
      mutable_ref: false,
      dynamic: false,
    });
  for (const m of sourceText.matchAll(
    /(?:^|\n)\s*(?:http_archive|http_file|git_repository|new_git_repository|local_repository)\s*\(([\s\S]{0,2000}?)\)/g,
  )) {
    const b = m[1]!;
    const name = /name\s*=\s*["']([^"']+)/.exec(b)?.[1] ?? 'unnamed';
    const url = /urls?\s*=\s*(?:\[[^\]]*?["']([^"']+)|["']([^"']+))/s.exec(b);
    const source = url?.[1] ?? url?.[2] ?? null;
    const checksum = /(?:sha256|integrity)\s*=\s*["']([^"']+)/.exec(b)?.[1] ?? null;
    deps.push({
      name,
      source: source ? cap(source) : null,
      checksum,
      pinned: !!checksum,
      mutable_ref: /\b(?:branch|tag|latest|main)\s*=/.test(b),
      dynamic: dynamic(b) > 0,
    });
  }
  const targets = [...sourceText.matchAll(/^\s*([\w.]+)\s*\(/gm)]
    .map((m) => m[1]!)
    .filter(
      (x) =>
        ![
          'load',
          'module',
          'bazel_dep',
          'http_archive',
          'git_repository',
          'use_extension',
        ].includes(x),
    );
  return {
    system: 'bazel',
    support: 'structural',
    path,
    dependencies: deps.slice(0, 500),
    target_count: targets.length,
    rule_kinds: [...new Set(targets)].slice(0, 100),
    remote_source_count: deps.filter((d) => !!d.source).length,
    unparsed_dynamic: dynamic(text),
    signals: signals(deps),
  };
}
function nix(path: string, text: string): BuildSources['files'][number] {
  const deps: BuildDependency[] = [];
  const sourceText = withoutCommentLines(text);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    /* flake.nix is not JSON */
  }
  if (json && typeof json === 'object' && json !== null) {
    const nodes = (json as { nodes?: Record<string, unknown> }).nodes ?? {};
    for (const [name, raw] of Object.entries(nodes)) {
      const locked = (raw as { locked?: Record<string, unknown> }).locked;
      if (!locked) continue;
      const source =
        typeof locked.url === 'string'
          ? locked.url
          : typeof locked.repo === 'string'
            ? `github:${String(locked.owner ?? '')}/${locked.repo}`
            : null;
      deps.push({
        name,
        source,
        checksum: typeof locked.narHash === 'string' ? locked.narHash : null,
        pinned: !!locked.rev || !!locked.narHash,
        mutable_ref: false,
        dynamic: false,
      });
    }
  }
  for (const m of sourceText.matchAll(/inputs\.([\w-]+)\.url\s*=\s*["']([^"']+)/g))
    deps.push({
      name: m[1]!,
      source: cap(m[2]!),
      checksum: null,
      pinned: false,
      mutable_ref: /(?:branch|main|latest|master)/i.test(m[2]!),
      dynamic: false,
    });
  for (const m of sourceText.matchAll(
    /(?:^|\n)\s*(fetchurl|fetchFromGitHub|fetchzip|fetchgit)\b([\s\S]{0,500})/g,
  ))
    deps.push({
      name: m[1]!,
      source: null,
      checksum: /(?:hash|sha256)\s*=\s*["']([^"']+)/.exec(m[2]!)?.[1] ?? null,
      pinned: false,
      mutable_ref: false,
      dynamic: dynamic(m[2]!) > 0,
    });
  return {
    system: 'nix',
    support: json ? 'structural' : 'unsupported_dynamic',
    path,
    dependencies: deps.slice(0, 500),
    target_count: 0,
    rule_kinds: [],
    remote_source_count: deps.filter((d) => !!d.source).length,
    unparsed_dynamic: dynamic(text),
    signals: signals(deps),
  };
}
function buck(path: string, text: string): BuildSources['files'][number] {
  const deps: BuildDependency[] = [];
  const sourceText = withoutCommentLines(text);
  for (const m of sourceText.matchAll(
    /(?:^|\n)\s*(http_archive|git_repository)\s*\(([\s\S]{0,1500}?)\)/g,
  )) {
    const b = m[2]!;
    deps.push({
      name: /name\s*=\s*["']([^"']+)/.exec(b)?.[1] ?? m[1]!,
      source: /url\s*=\s*["']([^"']+)/.exec(b)?.[1] ?? null,
      checksum: /(?:sha256|integrity)\s*=\s*["']([^"']+)/.exec(b)?.[1] ?? null,
      pinned: /(?:sha256|integrity|commit)\s*=/.test(b),
      mutable_ref: /\b(?:branch|tag|main|latest)\s*=/.test(b),
      dynamic: dynamic(b) > 0,
    });
  }
  const targets = [...sourceText.matchAll(/^\s*([\w.]+)\s*\(/gm)].map((m) => m[1]!);
  return {
    system: 'buck',
    support: 'structural',
    path,
    dependencies: deps.slice(0, 500),
    target_count: targets.length,
    rule_kinds: [...new Set(targets)].slice(0, 100),
    remote_source_count: deps.length,
    unparsed_dynamic: dynamic(text),
    signals: signals(deps),
  };
}
function signals(ds: BuildDependency[]): string[] {
  const out: string[] = [];
  if (ds.some((d) => d.pinned)) out.push('lock_by_commit_or_hash_present');
  if (ds.some((d) => d.mutable_ref)) out.push('mutable_ref');
  if (ds.some((d) => !d.checksum && !!d.source)) out.push('missing_checksum');
  if (ds.some((d) => d.source?.startsWith('http://'))) out.push('http_url');
  if (ds.some((d) => !!d.source && !d.checksum)) out.push('remote_source_unpinned');
  return out;
}
export function parseBuildSource(path: string, text: string): BuildSources['files'][number] {
  if (text.length > 2 * 1024 * 1024)
    return {
      system: 'bazel',
      support: 'unsupported_dynamic',
      path,
      dependencies: [],
      target_count: 0,
      rule_kinds: [],
      remote_source_count: 0,
      unparsed_dynamic: 1,
      signals: ['file_too_large'],
    };
  if (/MODULE\.bazel$|WORKSPACE(?:\.bazel)?$|BUILD(?:\.bazel)?$/i.test(path))
    return bazel(path, text);
  if (/flake\.lock$|flake\.nix$|default\.nix$|shell\.nix$/i.test(path)) return nix(path, text);
  return buck(path, text);
}
export function parseBuildSources(files: { path: string; content: string }[]): BuildSources {
  const parsed = files.slice(0, 40).map((f) => parseBuildSource(f.path, f.content));
  const all = parsed.flatMap((f) => f.dependencies);
  const remote = all.filter((d) => d.source);
  return BuildSourcesSchema.parse({
    version: '1',
    status: 'analyzed',
    files: parsed,
    remote_source_unpinned: remote.length ? remote.some((d) => !d.pinned) : null,
    declared_paths: [],
    rejected_paths: 0,
    not_available: ['structural parsing does not evaluate Starlark, Nix or Buck macros'],
  });
}
