import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { packageRoot } from '../util/paths.js';
import { ProfileSchema, type Profile, type Rule } from '../scoring/types.js';

export function parseProfile(text: string): Profile {
  return ProfileSchema.parse(parseYaml(text, { schema: 'core', maxAliasCount: 10 }));
}

export function listProfiles(root = packageRoot()): Profile[] {
  const dir = join(root, 'profiles');
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => parseProfile(readFileSync(join(dir, f), 'utf8')));
}

export class UnknownProfileError extends Error {
  constructor(id: string, known: string[]) {
    super(`unknown profile "${id.slice(0, 40)}". Available: ${known.join(', ')}`);
    this.name = 'UnknownProfileError';
  }
}

/** Profile ids are matched against the loaded list; user input is never used as a file path. */
export function loadProfile(id: string, root = packageRoot()): Profile {
  const all = listProfiles(root);
  const p = all.find((x) => x.id === id);
  if (!p)
    throw new UnknownProfileError(
      id,
      all.map((x) => x.id),
    );
  return p;
}

/** Fail loudly if a profile refers to rules that do not exist (typos silently doing nothing). */
export function validateProfileAgainstRules(profile: Profile, rules: Rule[]): void {
  const ids = new Set(rules.map((r) => r.id));
  for (const id of Object.keys(profile.rule_weights)) {
    if (!ids.has(id))
      throw new Error(`profile ${profile.id}: unknown rule "${id}" in rule_weights`);
  }
}
