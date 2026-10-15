import type { ArtifactInspection } from './inspect.js';
export interface StaticArtifactFacts {
  hooks: { name: string; text: string }[];
  metadata: string[];
  domains: string[];
  mismatches: string[];
}
const decode = (b?: Uint8Array): string => (b ? new TextDecoder().decode(b) : '');
export function extractStaticFacts(
  i: ArtifactInspection,
  registry: { name: string; version: string; hasInstallScript?: boolean },
): StaticArtifactFacts {
  const hooks: { name: string; text: string }[] = [],
    metadata: string[] = [],
    domains: string[] = [],
    mismatches: string[] = [];
  for (const e of i.entries) {
    const t = decode(e.content);
    if (!t) continue;
    if (e.path.toLowerCase().endsWith('package.json')) {
      try {
        const j = JSON.parse(t) as Record<string, unknown>;
        const scripts =
          typeof j['scripts'] === 'object' && j['scripts'] !== null
            ? (j['scripts'] as Record<string, unknown>)
            : j;
        for (const k of ['preinstall', 'install', 'postinstall'])
          if (typeof scripts[k] === 'string')
            hooks.push({ name: k, text: (scripts[k] as string).slice(0, 65536) });
        if (j['version'] !== undefined && j['version'] !== registry.version)
          mismatches.push('manifest_version');
        if (registry.hasInstallScript === false && hooks.length)
          mismatches.push('registry_install_script_absent');
      } catch {
        metadata.push('package_json_unparsed');
      }
    }
    if (/METADATA$|pyproject\.toml$|entry_points\.txt$|RECORD$|setup\.py$/i.test(e.path))
      metadata.push(e.path.slice(-80));
    if (/Cargo\.toml$|build\.rs$/i.test(e.path)) metadata.push(e.path.slice(-80));
    for (const m of t.matchAll(/https?:\/\/([^\s/'"<>]+)/g)) domains.push(m[1]!.toLowerCase());
  }
  return {
    hooks,
    metadata: [...new Set(metadata)].slice(0, 50),
    domains: [...new Set(domains)].slice(0, 100),
    mismatches: [...new Set(mismatches)],
  };
}
