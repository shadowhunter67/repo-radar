import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { packageRoot } from '../util/paths.js';
import { DIMENSIONS, METHODOLOGY_VERSION, RuleFileSchema, type Rule } from './types.js';

export interface RuleSet {
  methodology: string;
  rules: Rule[];
  /** sha256 over the canonical JSON of all rules: changes whenever any standard changes. */
  digest: string;
}

export function parseRuleFile(text: string, fileLabel: string): Rule[] {
  const doc = parseYaml(text, { schema: 'core', maxAliasCount: 10 });
  const parsed = RuleFileSchema.parse(doc);
  if (parsed.methodology !== METHODOLOGY_VERSION) {
    throw new Error(
      `${fileLabel}: methodology ${parsed.methodology} != engine ${METHODOLOGY_VERSION}`,
    );
  }
  return parsed.rules;
}

export function buildRuleSet(rules: Rule[]): RuleSet {
  const seen = new Set<string>();
  for (const r of rules) {
    if (seen.has(r.id)) throw new Error(`duplicate rule id: ${r.id}`);
    seen.add(r.id);
  }
  const sorted = [...rules].sort((a, b) => (a.id < b.id ? -1 : 1));
  const digest = createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
  return { methodology: METHODOLOGY_VERSION, rules: sorted, digest };
}

/** Loads standards/<dimension>/*.yaml. A file may only define rules for its own directory's dimension. */
export function loadRuleSet(root = packageRoot()): RuleSet {
  const all: Rule[] = [];
  for (const dim of DIMENSIONS) {
    const dir = join(root, 'standards', dim);
    let files: string[];
    try {
      files = readdirSync(dir)
        .filter((f) => /\.ya?ml$/.test(f) && statSync(join(dir, f)).isFile())
        .sort();
    } catch {
      continue;
    }
    for (const f of files) {
      const rules = parseRuleFile(readFileSync(join(dir, f), 'utf8'), `${dim}/${f}`);
      for (const r of rules) {
        if (r.dimension !== dim)
          throw new Error(`${dim}/${f}: rule ${r.id} belongs to dimension ${r.dimension}`);
        all.push(r);
      }
    }
  }
  return buildRuleSet(all);
}
