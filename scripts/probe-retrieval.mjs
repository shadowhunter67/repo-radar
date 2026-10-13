// Real-repository probe for tree retrieval on large repositories.
//
//   npm run build && GITHUB_TOKEN=... node scripts/probe-retrieval.mjs [--out name] [--no-targeted] owner/repo[@sha] ...
//
// Resolves the default-branch head to an exact commit when no @sha is given (and records it), analyzes WITHOUT network
// enrichment, and prints how the tree was obtained, the requests/time spent, the coverage map and what structural
// evidence was recovered (manifests, workflows, execution projects, identity). Sequential on purpose. Writes
// calibration/results/<name>.md. A probe, not a calibration metric: nothing is tuned on its output.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { analyzeRepository } from '../dist/analyze.js';
import { DEFAULT_RETRIEVAL_BUDGET } from '../dist/collectors/github/retrieval.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const name = opt('--out', 'retrieval-probe');
const targeted = !args.includes('--no-targeted');
// --v2: the 0.6 behaviour (no declared-path pool, no manifest seeking) for a same-revision baseline
const v2 = args.includes('--v2');
const repos = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
const token = process.env.GITHUB_TOKEN || undefined;
const outDir = join(root, 'calibration', 'runs', 'retrieval-probe', name);
mkdirSync(outDir, { recursive: true });

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

const rows = [];
for (const spec of repos) {
  const [repo, pinned] = spec.split('@');
  const t0 = Date.now();
  try {
    const sha = pinned ?? (await headSha(repo));
    const r = await analyzeRepository(repo, {
      ref: sha,
      ...(token ? { token } : {}),
      targetedTree: targeted,
      ...(v2
        ? {
            retrievalBudget: {
              ...DEFAULT_RETRIEVAL_BUDGET,
              declared: { maxRequests: 0, maxHintReads: 0 },
              seek: { enabled: false },
            },
          }
        : {}),
      scorecard: false,
      osv: false,
      depsDev: false,
      sbom: false,
    });
    const ms = Date.now() - t0;
    writeFileSync(join(outDir, `${repo.replace('/', '__')}.json`), JSON.stringify(r));
    rows.push({
      repo,
      sha,
      ms,
      requests: r.stats.http_requests,
      retrieval: r.retrieval,
      coverage: Object.fromEntries(Object.entries(r.coverage_map).map(([k, v]) => [k, v.state])),
      manifests: r.identity_v2.packaging.package_count,
      packaging: r.identity_v2.packaging.value,
      bytes: r.retrieval.bytes,
      manifestPaths: r.retrieval.manifest_paths,
      seek: r.retrieval.manifest_seek,
      declared: r.retrieval.declared_paths,
      primary: `${r.identity_v2.primary_artifact.value} (${r.identity_v2.primary_artifact.confidence})`,
      workflows: r.evidence.find((e) => e.id === 'github.workflows.count')?.value ?? null,
      scan: `${Math.round(r.code_analysis.scan.source_coverage * 100)}% / ${r.code_analysis.scan.files_scanned} files`,
      projects: r.code_analysis.execution.projects.length,
      hooks: r.code_analysis.execution.hooks.length,
      deps: r.dependency_intel.summary.discovered,
    });
    process.stdout.write(`ok   ${repo}@${sha.slice(0, 10)} ${ms}ms\n`);
  } catch (e) {
    rows.push({ repo, error: String(e?.message ?? e).slice(0, 200), ms: Date.now() - t0 });
    process.stdout.write(`FAIL ${repo}: ${String(e?.message ?? e).slice(0, 120)}\n`);
  }
}

let md = `# Retrieval probe: ${name}\n\nTargeted retrieval: ${targeted ? (v2 ? 'ON, 0.6 behaviour (no declared-path pool, no manifest seeking)' : 'ON, v3') : 'OFF (baseline)'}. No enrichment (OSV, deps.dev, Scorecard). Sequential.\n\n`;
for (const x of rows) {
  if (x.error) {
    md += `## ${x.repo}\n\nFAILED: ${x.error}\n\n`;
    continue;
  }
  const t = x.retrieval;
  md += `## ${x.repo} @ ${x.sha}\n\n`;
  md += `- time ${x.ms} ms, ${x.requests} HTTP requests\n`;
  md += `- tree: ${t.method}, complete=${t.complete}, reason=${t.reason}, github_truncated=${t.github_truncated}, tree requests=${t.requests}, nodes=${t.nodes}, directories listed=${t.explored.length}, unread=${t.unexplored_count}, stopped_by=${t.stopped_by}, failed=${t.failed_requests}\n`;
  md += `- coverage: ${Object.entries(x.coverage)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ')}\n`;
  md += `- recovered: ${x.manifests} manifests (${x.packaging}), ${x.workflows ?? 0} workflows, ${x.projects} build projects, ${x.hooks} execution hooks, ${x.deps} dependencies; source scan ${x.scan}\n`;
  md += `- identity v2 primary: ${x.primary}\n`;
  if (t.unexplored.length) md += `- first unread: ${t.unexplored.slice(0, 10).join(', ')}\n`;
  md += '\n';
}
writeFileSync(join(root, 'calibration', 'results', `${name}.md`), md);
process.stdout.write(`wrote calibration/results/${name}.md\n`);
