import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { packageRoot } from '../util/paths.js';

export const ARTIFACT_TYPES = [
  'library',
  'application',
  'cli',
  'service',
  'framework',
  'plugin',
  'extension',
  'sdk',
  'driver',
  'container',
  'infrastructure',
  'dataset',
  'model',
  'documentation',
  'template',
  'monorepo',
  'tooling',
  'unknown',
] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export const TaxonomyEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  label: z.string(),
  function: z.string(),
  /** Subject area of the software (web, database, security, ...). */
  domain: z.string().default('general'),
  /** Artifact type this entry usually implies (library, cli, framework, ...). */
  artifact: z.enum(ARTIFACT_TYPES).optional(),
  audience: z.array(z.string()).default(['developers']),
  keywords: z.array(z.string().min(2)).min(1),
  deps: z.array(z.string()).default([]),
  topics: z.array(z.string()).default([]),
  aliases: z.array(z.string()).default([]),
});
export const TaxonomySchema = z.object({
  version: z.string(),
  types: z.array(TaxonomyEntrySchema).min(1),
});
export type Taxonomy = z.infer<typeof TaxonomySchema>;
export type TaxonomyEntry = z.infer<typeof TaxonomyEntrySchema>;

export function parseTaxonomy(text: string): Taxonomy {
  const doc = parseYaml(text, { schema: 'core', maxAliasCount: 10 });
  return TaxonomySchema.parse(doc);
}

export function loadDefaultTaxonomy(root = packageRoot()): Taxonomy {
  return parseTaxonomy(readFileSync(join(root, 'standards', 'identity', 'taxonomy.yaml'), 'utf8'));
}
