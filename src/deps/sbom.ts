import { sanitizeForTerminal } from '../util/text.js';
import {
  SBOM_COMPONENT_CATEGORIES,
  type SbomComponent,
  type SbomDocument,
  packageId,
  parsePurl,
} from './model.js';

/**
 * SBOM ingestion (CycloneDX JSON 1.2-1.6, SPDX JSON 2.2/2.3). An SBOM is attacker-controlled input and is evidence,
 * not ground truth: it is validated structurally, bounded, and later compared with what the repository itself shows.
 */
export const SBOM_LIMITS = {
  maxBytes: 5 * 1024 * 1024,
  maxComponents: 5000,
  maxRelationships: 50_000,
  maxString: 300,
  maxDepth: 64,
  maxNestedComponentDepth: 8,
} as const;

/** File names worth fetching. A name is never proof: the content is validated before use. */
export const SBOM_PATH =
  /(?:^|\/)(?:sbom|bom|cyclonedx|spdx)[\w.-]*\.json$|\.(?:cdx|spdx)\.json$|(?:^|\/)(?:sbom|bom)\.(?:cdx|spdx)\.json$/i;
export const isSbomPath = (p: string): boolean =>
  p.split('/').length <= 4 && SBOM_PATH.test(p) && !/(?:^|\/)node_modules\//.test(p);

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const clip = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? sanitizeForTerminal(v, SBOM_LIMITS.maxString) : undefined;

/** O(n) nesting check run before JSON.parse so a pathological document cannot exhaust the stack. */
export function jsonDepthExceeds(text: string, max: number): boolean {
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inStr) {
      if (c === 92) i++;
      else if (c === 34) inStr = false;
      continue;
    }
    if (c === 34) inStr = true;
    else if (c === 123 || c === 91) {
      if (++depth > max) return true;
    } else if (c === 125 || c === 93) depth--;
  }
  return false;
}

function empty(path: string, over: Partial<SbomDocument>): SbomDocument {
  return {
    path,
    format: 'unknown',
    status: 'not_an_sbom',
    component_count: 0,
    relationship_count: 0,
    truncated: false,
    components: [],
    ...over,
  };
}

export function parseSbom(path: string, text: string): SbomDocument {
  if (text.length > SBOM_LIMITS.maxBytes)
    return empty(path, {
      status: 'too_large',
      detail: `larger than ${SBOM_LIMITS.maxBytes} bytes; not processed`,
    });
  if (jsonDepthExceeds(text, SBOM_LIMITS.maxDepth))
    return empty(path, {
      status: 'malformed',
      detail: `JSON nested deeper than ${SBOM_LIMITS.maxDepth} levels; not processed`,
    });
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return empty(path, { status: 'malformed', detail: 'not valid JSON' });
  }
  if (!isObj(j))
    return empty(path, { status: 'not_an_sbom', detail: 'top level is not an object' });
  if (j['bomFormat'] === 'CycloneDX') return parseCycloneDx(path, j);
  if (typeof j['spdxVersion'] === 'string' && j['spdxVersion'].startsWith('SPDX-'))
    return parseSpdx(path, j);
  if (j['@context'] !== undefined && /spdx/i.test(JSON.stringify(j['@context']).slice(0, 300)))
    return empty(path, {
      format: 'SPDX',
      status: 'unsupported',
      detail: 'SPDX 3.x (JSON-LD) is not supported',
    });
  return empty(path, {
    status: 'not_an_sbom',
    detail: 'neither a CycloneDX nor an SPDX 2.x document',
  });
}

const CATEGORY: Record<string, SbomComponent['category']> = {
  library: 'library',
  framework: 'framework',
  application: 'application',
  container: 'container',
  'operating-system': 'operating-system',
  file: 'file',
  device: 'device',
  firmware: 'device',
  'device-driver': 'device',
  platform: 'other',
  data: 'data',
  'machine-learning-model': 'data',
};
// keep the enum in sync with the schema
void SBOM_COMPONENT_CATEGORIES;

function licenseNames(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const l of v.slice(0, 20)) {
    if (!isObj(l)) continue;
    const lic = isObj(l['license']) ? l['license'] : undefined;
    const s = clip(lic?.['id']) ?? clip(lic?.['name']) ?? clip(l['expression']);
    if (s) out.push(s);
  }
  return out;
}

function parseCycloneDx(path: string, j: Record<string, unknown>): SbomDocument {
  const spec = clip(j['specVersion']);
  if (!spec || !/^1\.[2-6]$/.test(spec))
    return empty(path, {
      format: 'CycloneDX',
      status: 'unsupported',
      ...(spec ? { spec_version: spec } : {}),
      detail: `CycloneDX specVersion ${spec ?? '(missing)'} is not supported (1.2-1.6)`,
    });
  const components: SbomComponent[] = [];
  let truncated = false;
  const walk = (list: unknown, depth: number): void => {
    if (!Array.isArray(list)) return;
    for (const c of list) {
      if (!isObj(c)) continue;
      if (components.length >= SBOM_LIMITS.maxComponents) {
        truncated = true;
        return;
      }
      const name = clip(c['name']);
      if (name) {
        const purl = clip(c['purl']);
        const parsed = purl ? parsePurl(purl) : undefined;
        const version = clip(c['version']) ?? parsed?.version;
        const supplier = isObj(c['supplier']) ? clip(c['supplier']['name']) : undefined;
        const author = clip(c['author']);
        const scope = clip(c['scope']);
        components.push({
          ref: clip(c['bom-ref']) ?? `${name}@${version ?? ''}`,
          category: CATEGORY[String(c['type'])] ?? 'other',
          name,
          ...(version ? { version } : {}),
          ...(purl ? { purl } : {}),
          ...(parsed && parsed.ecosystem !== 'unknown'
            ? { package: packageId(parsed.ecosystem, parsed.name) }
            : {}),
          ...(scope ? { scope } : {}),
          licenses: licenseNames(c['licenses']),
          hash_count: Array.isArray(c['hashes']) ? Math.min(c['hashes'].length, 20) : 0,
          ...(supplier ? { supplier } : {}),
          ...(author ? { author } : {}),
        });
      }
      if (depth < SBOM_LIMITS.maxNestedComponentDepth) walk(c['components'], depth + 1);
    }
  };
  walk(j['components'], 0);
  let rels = 0;
  if (Array.isArray(j['dependencies']))
    for (const d of j['dependencies'].slice(0, SBOM_LIMITS.maxRelationships))
      if (isObj(d) && Array.isArray(d['dependsOn'])) rels += d['dependsOn'].length;
  return {
    path,
    format: 'CycloneDX',
    spec_version: spec,
    status: 'parsed',
    component_count: components.length,
    relationship_count: Math.min(rels, SBOM_LIMITS.maxRelationships),
    truncated,
    components,
    ...(truncated
      ? { detail: `only the first ${SBOM_LIMITS.maxComponents} components were read` }
      : {}),
  };
}

const SPDX_PURPOSE: Record<string, SbomComponent['category']> = {
  LIBRARY: 'library',
  FRAMEWORK: 'framework',
  APPLICATION: 'application',
  CONTAINER: 'container',
  'OPERATING-SYSTEM': 'operating-system',
  FILE: 'file',
  DEVICE: 'device',
  FIRMWARE: 'device',
  DATA: 'data',
};

function parseSpdx(path: string, j: Record<string, unknown>): SbomDocument {
  const spec = clip(j['spdxVersion']) ?? '';
  if (!/^SPDX-2\.[23]$/.test(spec))
    return empty(path, {
      format: 'SPDX',
      status: 'unsupported',
      spec_version: spec,
      detail: `${spec} is not supported (SPDX-2.2, SPDX-2.3)`,
    });
  const described = new Set<string>();
  let rels = 0;
  if (Array.isArray(j['relationships'])) {
    for (const r of j['relationships'].slice(0, SBOM_LIMITS.maxRelationships)) {
      if (!isObj(r)) continue;
      rels++;
      if (r['relationshipType'] === 'DESCRIBES' && typeof r['relatedSpdxElement'] === 'string')
        described.add(r['relatedSpdxElement']);
    }
  }
  const components: SbomComponent[] = [];
  let truncated = false;
  const pkgs = Array.isArray(j['packages']) ? j['packages'] : [];
  for (const p of pkgs) {
    if (!isObj(p)) continue;
    if (components.length >= SBOM_LIMITS.maxComponents) {
      truncated = true;
      break;
    }
    const name = clip(p['name']);
    if (!name) continue;
    let purl: string | undefined;
    if (Array.isArray(p['externalRefs']))
      for (const r of p['externalRefs'].slice(0, 20))
        if (isObj(r) && r['referenceType'] === 'purl') purl ??= clip(r['referenceLocator']);
    const parsed = purl ? parsePurl(purl) : undefined;
    const rawVersion = clip(p['versionInfo']);
    const version = rawVersion && rawVersion !== 'NOASSERTION' ? rawVersion : parsed?.version;
    const id = clip(p['SPDXID']) ?? `${name}@${version ?? ''}`;
    const purpose =
      typeof p['primaryPackagePurpose'] === 'string' ? p['primaryPackagePurpose'] : '';
    const category = described.has(id)
      ? 'application'
      : (SPDX_PURPOSE[purpose] ?? (purl ? 'library' : 'other'));
    const lic: string[] = [];
    for (const k of ['licenseConcluded', 'licenseDeclared']) {
      const v = clip(p[k]);
      if (v && v !== 'NOASSERTION' && v !== 'NONE' && !lic.includes(v)) lic.push(v);
    }
    const supplier = clip(p['supplier']);
    components.push({
      ref: id,
      category,
      name,
      ...(version ? { version } : {}),
      ...(purl ? { purl } : {}),
      ...(parsed && parsed.ecosystem !== 'unknown'
        ? { package: packageId(parsed.ecosystem, parsed.name) }
        : {}),
      licenses: lic,
      hash_count: Array.isArray(p['checksums']) ? Math.min(p['checksums'].length, 20) : 0,
      ...(supplier && supplier !== 'NOASSERTION' ? { supplier } : {}),
    });
  }
  return {
    path,
    format: 'SPDX',
    spec_version: spec,
    status: 'parsed',
    component_count: components.length,
    relationship_count: rels,
    truncated,
    components,
    ...(truncated
      ? { detail: `only the first ${SBOM_LIMITS.maxComponents} packages were read` }
      : {}),
  };
}
