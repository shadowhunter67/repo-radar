import type { RepoSnapshot } from '../collectors/types.js';
import type { ParsedManifest } from '../collectors/manifests/parse.js';
import { round, sanitizeForTerminal } from '../util/text.js';
import { normalizeName } from './normalize.js';
import type { Taxonomy, TaxonomyEntry } from './taxonomy.js';
import type { IdentityClassifier, SemanticIdentity } from './types.js';

// Source weights: structured, author-declared fields outrank free text.
const W_TOPIC = 3;
const W_MANIFEST_DESC = 2.5;
const W_REPO_DESC = 2.5;
const W_DEP = 2;
const W_README = 1;
const README_WINDOW = 3000;
const MAX_REASONS = 12;
// Declared text comes from the (untrusted) repository: bound what the keyword regexes scan.
const TEXT_LIMIT = 4000;

const FRONTEND_DEPS = new Set([
  'react',
  'vue',
  'svelte',
  'solid-js',
  '@angular/core',
  'preact',
  'next',
  'nuxt',
  'astro',
  'lit',
]);
const SERVER_DEPS = new Set([
  'express',
  'fastify',
  'koa',
  'hono',
  '@nestjs/core',
  'flask',
  'fastapi',
  'django',
  'starlette',
  'aiohttp',
  'github.com/gin-gonic/gin',
  'github.com/labstack/echo',
  'github.com/gofiber/fiber',
  'actix-web',
  'axum',
  'rocket',
  'warp',
]);

interface Compiled {
  entry: TaxonomyEntry;
  keywordRes: { kw: string; re: RegExp }[];
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function compile(t: Taxonomy): Compiled[] {
  return t.types.map((entry) => ({
    entry,
    keywordRes: entry.keywords.map((kw) => ({
      kw,
      re: new RegExp(
        `(?<![\\p{L}\\p{N}])${escapeRe(kw.toLowerCase()).replace(/ /g, '[ -]')}(?![\\p{L}\\p{N}])`,
        'u',
      ),
    })),
  }));
}

export class HeuristicClassifier implements IdentityClassifier {
  readonly id = 'heuristic-v0.1';
  private readonly compiled: Compiled[];

  constructor(taxonomy: Taxonomy) {
    this.compiled = compile(taxonomy);
  }

  classify(s: RepoSnapshot): SemanticIdentity {
    const name = normalizeName(s.displayName);
    const manifestDesc = s.manifests
      .map((m) => m.description ?? '')
      .join(' \n ')
      .slice(0, TEXT_LIMIT)
      .toLowerCase();
    const repoDesc = (s.description ?? '').slice(0, TEXT_LIMIT).toLowerCase();
    const readmeHead = (s.readme ?? '').slice(0, README_WINDOW).toLowerCase();
    const topics = new Set(
      [...s.topics, ...s.manifests.flatMap((m) => m.keywords)].map((t) => t.toLowerCase()),
    );
    const depNames = s.manifests.flatMap((m) => m.dependencies.map((d) => d.name.toLowerCase()));

    const scored = this.compiled.map(({ entry, keywordRes }) => {
      let score = 0;
      const reasons: string[] = [];
      for (const t of entry.topics) {
        if (topics.has(t.toLowerCase())) {
          score += W_TOPIC;
          reasons.push(`topic "${t}"`);
        }
      }
      let kwHits = 0;
      for (const { kw, re } of keywordRes) {
        if (re.test(manifestDesc)) {
          score += W_MANIFEST_DESC;
          reasons.push(`package description mentions "${kw}"`);
        }
        if (re.test(repoDesc)) {
          score += W_REPO_DESC;
          reasons.push(`repository description mentions "${kw}"`);
        }
        if (kwHits < 4 && re.test(readmeHead)) {
          score += W_README;
          kwHits++;
          reasons.push(`README mentions "${kw}"`);
        }
      }
      let depHits = 0;
      for (const d of entry.deps) {
        const dl = d.toLowerCase();
        const match = dl.endsWith('*')
          ? depNames.some((n) => n.startsWith(dl.slice(0, -1)))
          : depNames.includes(dl);
        if (match && depHits < 3) {
          score += W_DEP;
          depHits++;
          reasons.push(`depends on "${d}"`);
        }
      }
      return { entry, score, reasons };
    });
    scored.sort((a, b) => b.score - a.score || (a.entry.id < b.entry.id ? -1 : 1));

    const top = scored[0];
    const second = scored[1];
    const interfaces = detectInterfaces(s);
    const ecosystem = detectEcosystem(s);
    const declared = declaredSummary(s);

    if (!top || top.score < 2) {
      return {
        repository_name: name.display,
        normalized_name: name.normalized,
        search_name: name.searchForm,
        canonical_type: 'unclassified',
        primary_function: declared ?? 'unknown',
        secondary_functions: [],
        declared_summary: declared ?? null,
        ecosystem,
        interfaces,
        target_users: [],
        search_aliases: [],
        confidence: round(Math.min(0.2, (top?.score ?? 0) / 10), 2),
        name_purpose_divergence: null,
        classifier: this.id,
        evidence: ['no taxonomy type matched strongly enough'],
      };
    }

    const strength = 1 - Math.exp(-top.score / 6);
    const margin = (top.score - (second?.score ?? 0)) / top.score;
    const confidence = round(Math.min(0.95, strength * (0.5 + 0.5 * margin)), 2);
    const secondary = scored
      .slice(1, 4)
      .filter((x) => x.score >= 3 && x.score >= 0.4 * top.score)
      .map((x) => x.entry.label);
    const lang = s.language ?? ecosystem[0];
    const aliases = [...top.entry.aliases];
    if (lang)
      for (const a of top.entry.aliases.slice(0, 2)) aliases.push(`${lang.toLowerCase()} ${a}`);

    const vocab = new Set(
      [
        top.entry.label,
        top.entry.function,
        ...top.entry.aliases,
        ...top.entry.keywords,
        declared ?? '',
      ]
        .join(' ')
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean),
    );
    const divergence = nameDivergence(name.tokens, vocab, confidence);

    return {
      repository_name: name.display,
      normalized_name: name.normalized,
      search_name: name.searchForm,
      canonical_type: top.entry.id,
      primary_function: top.entry.function,
      secondary_functions: secondary,
      declared_summary: declared ?? null,
      ecosystem,
      interfaces,
      target_users: top.entry.audience,
      search_aliases: [...new Set(aliases)].slice(0, 8),
      confidence,
      name_purpose_divergence: divergence,
      classifier: this.id,
      evidence: [...new Set(top.reasons)]
        .slice(0, MAX_REASONS)
        .map((r) => sanitizeForTerminal(r, 120)),
    };
  }
}

const GENERIC_NAME_TOKENS = new Set([
  'py',
  'js',
  'ts',
  'go',
  'rs',
  'lib',
  'app',
  'the',
  'my',
  'new',
  'awesome',
  'pro',
  'plus',
  'core',
  'api',
  'dev',
  'io',
  'ng',
]);

function nameDivergence(tokens: string[], vocab: Set<string>, confidence: number): number | null {
  if (confidence < 0.3) return null;
  const meaningful = tokens.filter((t) => t.length >= 3 && !GENERIC_NAME_TOKENS.has(t));
  if (meaningful.length === 0) return null;
  const overlap = meaningful.filter((t) => vocab.has(t) || vocab.has(t.replace(/s$/, ''))).length;
  return round(1 - overlap / meaningful.length, 2);
}

export function declaredSummary(s: RepoSnapshot): string | undefined {
  const raw = s.manifests.find((m) => m.description?.trim())?.description ?? s.description;
  if (!raw?.trim()) return undefined;
  return sanitizeForTerminal(raw, 200);
}

function detectEcosystem(s: RepoSnapshot): string[] {
  const out: string[] = [];
  if (s.language) out.push(s.language);
  const label: Record<ParsedManifest['ecosystem'], string> = {
    npm: 'npm',
    PyPI: 'PyPI',
    Go: 'Go modules',
    'crates.io': 'crates.io',
  };
  for (const m of s.manifests) {
    const l = label[m.ecosystem];
    if (!out.includes(l)) out.push(l);
  }
  return out;
}

function detectInterfaces(s: RepoSnapshot): string[] {
  const out = new Set<string>();
  const paths = s.treePaths;
  const deps = new Set(
    s.manifests.flatMap((m) =>
      m.dependencies.map((d) => d.name.toLowerCase().replace(/^github\.com\//, 'github.com/')),
    ),
  );
  const has = (re: RegExp): boolean => paths.some((p) => re.test(p));
  if (
    s.manifests.some((m) => m.entrypoints.length > 0) ||
    has(/^cmd\/[^/]+\/main\.go$/) ||
    has(/(?:^|\/)__main__\.py$/) ||
    has(/^src\/bin\//) ||
    has(/^bin\/[^/]+$/) ||
    has(/^(?:src\/)?cli\.[a-z]+$/)
  )
    out.add('cli');
  if (s.manifests.some((m) => !m.isPrivate && (m.ecosystem !== 'PyPI' || !!m.name)))
    out.add('library');
  const server = [...deps].some((d) => SERVER_DEPS.has(d));
  const frontend = [...deps].some((d) => FRONTEND_DEPS.has(d));
  if (server && (s.hasDockerfile || s.manifests.some((m) => m.isPrivate))) out.add('server');
  if (frontend && s.manifests.some((m) => m.isPrivate)) out.add('web-app');
  if (s.hasActionYml) out.add('github-action');
  if (has(/(?:^|\/)openapi\.(?:json|ya?ml)$/i) || has(/(?:^|\/)swagger\.(?:json|ya?ml)$/i))
    out.add('api');
  if (s.hasDockerfile) out.add('container');
  return [...out].sort();
}
