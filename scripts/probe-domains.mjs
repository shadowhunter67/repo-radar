// Real-repository probe for external domain extraction.
//
//   npm run build && GITHUB_TOKEN=... node scripts/probe-domains.mjs [--out name] [owner/repo[@sha] ...]
//
// Analyzes real repositories WITHOUT network enrichment and lists every external hostname found in an ACTIVE context
// (install, build, CI, container, release, runtime) with the file and line it came from, plus counts of what was filtered
// (localhost, private and documentation hosts). A human reads the listing and labels each row; the labels and the resulting
// precision are recorded by hand in docs/domains.md. Nothing is tuned on these repositories. Writes
// calibration/results/<name>.md.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { analyzeRepository } from '../dist/analyze.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const name = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'domain-probe';
const repos = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
const token = process.env.GITHUB_TOKEN || undefined;
const DEFAULT = [
  'puppeteer/puppeteer',
  'lovell/sharp',
  'zloirock/core-js',
  'evanw/esbuild',
  'typicode/husky',
  'sass/node-sass',
  'prisma/prisma',
  'microsoft/playwright',
];

async function headSha(repo) {
  const r = await globalThis.fetch(`https://api.github.com/repos/${repo}/commits/HEAD`, {
    headers: {
      Accept: 'application/vnd.github+json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!r.ok) throw new Error(`cannot resolve HEAD of ${repo}: HTTP ${r.status}`);
  return (await r.json()).sha;
}

const ACTIVE = new Set(['install', 'build', 'release', 'ci', 'container', 'runtime']);
let md = `# External domain probe: ${name}\n\nRun ${new Date().toISOString()}. Static extraction only; no observed host was resolved or contacted. A row is a REFERENCE in a file, not a connection.\n\n`;
for (const spec of repos.length ? repos : DEFAULT) {
  const [repo, pinned] = spec.split('@');
  const t0 = Date.now();
  try {
    const sha = pinned ?? (await headSha(repo));
    const r = await analyzeRepository(repo, {
      ref: sha,
      ...(token ? { token } : {}),
      scorecard: false,
      osv: false,
      depsDev: false,
      sbom: false,
      registry: false,
      releases: false,
      compliance: false,
    });
    const d = r.external_domains;
    md += `## ${repo} @ ${sha.slice(0, 10)}\n\n- ${Date.now() - t0} ms; scan ${Math.round(r.code_analysis.scan.source_coverage * 100)}% of source, ${d.files_scanned} files read; ${d.domains_total} external hosts (${d.domains.filter((x) => ACTIVE.has(x.strongest_context)).length} in active contexts); filtered ${JSON.stringify(d.filtered)}; unparsed ${d.unparsed}\n`;
    const byCtx = {};
    for (const x of d.domains) (byCtx[x.strongest_context] ??= []).push(x);
    for (const [ctx, list] of Object.entries(byCtx)) {
      md += `- **${ctx}** (${list.length})\n`;
      for (const x of list.slice(0, 25)) {
        const o = x.observations[0];
        md += `  - \`${x.hostname}\` [${x.category}${x.ambiguity !== 'none' ? ', ' + x.ambiguity : ''}] ${o ? o.file + ':' + o.line : ''} conf ${x.confidence}\n`;
      }
      if (list.length > 25) md += `  - ... ${list.length - 25} more\n`;
    }
    md += '\n';
    process.stdout.write(`ok   ${repo} (${Date.now() - t0} ms): ${d.domains_total} hosts\n`);
  } catch (e) {
    md += `## ${repo}\n\nFAILED: ${String(e?.message ?? e).slice(0, 200)}\n\n`;
    process.stdout.write(`FAIL ${repo}: ${String(e?.message ?? e).slice(0, 100)}\n`);
  }
}
mkdirSync(join(root, 'calibration', 'results'), { recursive: true });
writeFileSync(join(root, 'calibration', 'results', `${name}.md`), md);
process.stdout.write(`wrote calibration/results/${name}.md\n`);
