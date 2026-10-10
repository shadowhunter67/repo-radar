import type { RepoSnapshot } from '../collectors/types.js';
import { round } from '../util/text.js';
import type { ArtifactType, TaxonomyEntry } from './taxonomy.js';

const NOISE_DIR =
  /(?:^|\/)(?:examples?|samples?|demos?|tests?|__tests__|e2e|fixtures?|testdata|docs?|benchmarks?)\//i;

export interface ArtifactResult {
  type: ArtifactType;
  confidence: number;
  alternatives: ArtifactType[];
}

/**
 * Layer 1 of identity: what KIND of software artifact this is (library, CLI, service, ...), kept separate from
 * the domain (what it is about). Evidence order: taxonomy hint for the winning domain entry, then
 * observable structure (bin entries, servers, Dockerfile, action.yml, workspaces). Ambiguity is exposed as
 * `alternatives` instead of being forced into one label.
 */
export function classifyArtifact(
  s: RepoSnapshot,
  interfaces: string[],
  entry: TaxonomyEntry | undefined,
  domainConfidence: number,
): ArtifactResult {
  const has = (i: string): boolean => interfaces.includes(i);
  const alternatives: ArtifactType[] = [];
  const add = (t: ArtifactType): void => void (!alternatives.includes(t) && alternatives.push(t));
  // Manifests under examples/tests/docs/fixtures are samples, not packages of this repository.
  const nested = s.manifests.filter((m) => m.file.includes('/') && !NOISE_DIR.test(m.file));

  // Strong workspace evidence wins; a few nested manifests only win when the taxonomy gives no artifact hint.
  // A publishable root package that itself ships a command-line tool is that tool, with a workspace layout
  // (e.g. a Cargo workspace of internal crates); a private or absent root is just a container for packages.
  const root = s.manifests.find((m) => !m.file.includes('/'));
  const rootShipsCli = !!root && !root.isPrivate && root.entrypoints.length > 0 && has('cli');
  if (rootShipsCli && nested.length >= 3) {
    add('monorepo');
    return { type: 'cli', confidence: 0.6, alternatives };
  }
  if (nested.length >= 6 || (nested.length >= 3 && !entry?.artifact)) {
    add('library');
    return { type: 'monorepo', confidence: nested.length >= 6 ? 0.65 : 0.5, alternatives };
  }
  if (has('github-action')) return { type: 'plugin', confidence: 0.85, alternatives };

  // Observable structure outranks the domain hint when they disagree about CLI vs library:
  // "command-line" wording in a description does not make a package without a bin entry a CLI.
  if (entry?.artifact === 'cli' && !has('cli') && has('library')) {
    add('cli');
    return {
      type: 'library',
      confidence: round(Math.min(0.7, 0.3 + 0.4 * domainConfidence + 0.1), 2),
      alternatives,
    };
  }
  if (entry?.artifact === 'library' && has('cli') && !has('library')) {
    add('library');
    return {
      type: 'cli',
      confidence: round(Math.min(0.7, 0.3 + 0.4 * domainConfidence + 0.1), 2),
      alternatives,
    };
  }

  if (entry?.artifact) {
    if (has('cli') && entry.artifact !== 'cli') add('cli');
    if (has('library') && entry.artifact !== 'library') add('library');
    const structural =
      (entry.artifact === 'cli' && has('cli')) || (entry.artifact === 'library' && has('library'));
    return {
      type: entry.artifact,
      confidence: round(Math.min(0.9, 0.35 + 0.5 * domainConfidence + (structural ? 0.1 : 0)), 2),
      alternatives,
    };
  }

  if (has('server')) {
    if (has('library')) add('library');
    return { type: 'service', confidence: 0.6, alternatives };
  }
  if (has('web-app')) return { type: 'application', confidence: 0.6, alternatives };
  if (has('cli') && has('library')) {
    add('cli');
    return { type: 'library', confidence: 0.5, alternatives };
  }
  if (has('cli')) return { type: 'cli', confidence: 0.65, alternatives };
  if (has('library')) return { type: 'library', confidence: 0.6, alternatives };
  if (s.hasDockerfile && s.manifests.length === 0)
    return { type: 'container', confidence: 0.5, alternatives };
  return { type: 'unknown', confidence: 0.2, alternatives };
}

const ARTICLE_LABEL: Record<ArtifactType, string> = {
  library: 'Library',
  application: 'Application',
  cli: 'Command-line tool',
  service: 'Service',
  framework: 'Framework',
  plugin: 'Plugin / integration',
  extension: 'Extension',
  sdk: 'SDK / client library',
  driver: 'Driver',
  container: 'Container image',
  infrastructure: 'Infrastructure tooling',
  dataset: 'Dataset',
  model: 'Model',
  documentation: 'Documentation / learning resource',
  template: 'Template / configuration',
  monorepo: 'Monorepo',
  tooling: 'Developer tooling',
  unknown: 'Software artifact',
};

/** Deterministic, evidence-based purpose sentence. Not a model-generated summary. */
export function purposeSummary(
  type: ArtifactType,
  primaryFunction: string,
  canonical: string,
  declared: string | undefined,
): string {
  if (canonical === 'unclassified')
    return declared
      ? `Purpose not determined from available metadata. Declared: "${declared}"`
      : 'Purpose not determined from available metadata.';
  return `${ARTICLE_LABEL[type]} for ${primaryFunction}.`;
}
