import type { ArtifactInspection } from './inspect.js';
export interface StaticArtifactFacts {
  hooks: { name: string; text: string }[];
  metadata: string[];
  domains: string[];
  mismatches: string[];
  executable_entry_present: boolean | null;
  native_binary_present: boolean | null;
  repository_host: 'github.com' | 'gitlab.com' | 'bitbucket.org' | 'other' | 'unknown' | null;
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
  let executable_entry_present: boolean | null = null;
  let native_binary_present: boolean | null = null;
  let repository_host: StaticArtifactFacts['repository_host'] = null;
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
        if (typeof j['bin'] === 'string' || (typeof j['bin'] === 'object' && j['bin'] !== null))
          executable_entry_present = true;
        const repository =
          typeof j['repository'] === 'string'
            ? j['repository']
            : typeof j['repository'] === 'object' &&
                j['repository'] !== null &&
                typeof (j['repository'] as Record<string, unknown>)['url'] === 'string'
              ? (j['repository'] as Record<string, string>)['url']
              : '';
        if (repository) repository_host = hostClass(repository);
      } catch {
        metadata.push('package_json_unparsed');
      }
    }
    if (/METADATA$|pyproject\.toml$|entry_points\.txt$|RECORD$|setup\.py$/i.test(e.path))
      metadata.push(e.path.slice(-80));
    if (/Cargo\.toml$|build\.rs$/i.test(e.path)) metadata.push(e.path.slice(-80));
    for (const m of t.matchAll(/https?:\/\/([^\s/'"<>]+)/g)) domains.push(m[1]!.toLowerCase());
    if (/\.(?:node|so|dll|dylib|pyd)$/i.test(e.path)) native_binary_present = true;
    const bytes = e.content;
    if (
      bytes &&
      ((bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) ||
        (bytes[0] === 0x4d && bytes[1] === 0x5a) ||
        (bytes[0] === 0xcf && bytes[1] === 0xfa && bytes[2] === 0xed && bytes[3] === 0xfe) ||
        (bytes[0] === 0xfe && bytes[1] === 0xed && bytes[2] === 0xfa && bytes[3] === 0xcf))
    )
      native_binary_present = true;
  }
  return {
    hooks,
    metadata: [...new Set(metadata)].slice(0, 50),
    domains: [...new Set(domains)].slice(0, 100),
    mismatches: [...new Set(mismatches)],
    executable_entry_present,
    native_binary_present,
    repository_host,
  };
}

function hostClass(value: string): StaticArtifactFacts['repository_host'] {
  try {
    const host = new URL(value.replace(/^git\+/, '')).hostname.toLowerCase();
    if (host === 'github.com') return 'github.com';
    if (host === 'gitlab.com') return 'gitlab.com';
    if (host === 'bitbucket.org') return 'bitbucket.org';
    return 'other';
  } catch {
    return 'unknown';
  }
}
