// Real-repository probe for the build/execution model (Python, Maven/Gradle, ...).
//
//   npm run build && GITHUB_TOKEN=... node scripts/probe-execution.mjs [--out name] owner/repo[@sha] ...
//
// Analyzes each repository (optionally at a pinned commit; the analyzed commit is always recorded) WITHOUT network
// enrichment (no OSV, no deps.dev, no Scorecard) and prints the build projects, hooks and entry points the execution
// model found. Sequential on purpose. Writes calibration/results/<name>.md; per-repository JSON goes to the
// git-ignored calibration/runs/exec-probe/. A probe, not a calibration metric: nothing is tuned on its output, and
// repositories of a fresh holdout must never be probed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { analyzeRepository } from '../dist/analyze.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const name = opt('--out', 'exec-probe');
const repos = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
const token = process.env.GITHUB_TOKEN || undefined;
const outDir = join(root, 'calibration', 'runs', 'exec-probe', name);
mkdirSync(outDir, { recursive: true });

const rows = [];
for (const spec of repos) {
  const [repo, sha] = spec.split('@');
  const t0 = Date.now();
  try {
    const r = await analyzeRepository(repo, {
      ...(sha ? { ref: sha } : {}),
      ...(token ? { token } : {}),
      scorecard: false,
      osv: false,
      depsDev: false,
      sbom: false,
    });
    const ms = Date.now() - t0;
    writeFileSync(join(outDir, `${repo.replace('/', '__')}.json`), JSON.stringify(r));
    const ex = r.code_analysis.execution;
    rows.push({
      repo,
      commit: (sha ?? r.subject.ref ?? '').slice(0, 10),
      ms,
      requests: r.stats.http_requests,
      scan: `${Math.round(r.code_analysis.scan.source_coverage * 100)}% / ${r.code_analysis.scan.files_scanned} files`,
      projects: ex.projects.map(
        (p) =>
          `${p.dir}: ${p.build_system ?? '?'} [${p.kind}]${p.repository_code_runs ? ' REPO-CODE' : ''}${p.native_build_systems.length ? ` native=${p.native_build_systems.join('+')}` : ''}${p.bypassed.length ? ` bypassed=${p.bypassed.length}` : ''}`,
      ),
      hooks: ex.hooks.map(
        (h) =>
          `${h.ecosystem}:${h.name}${h.runs_for_dependents ? '*' : ''} ${h.stage ?? ''} risk=${h.risk}${h.capabilities.length ? ` caps=${h.capabilities.join(',')}` : ''}`,
      ),
      entrypoints: ex.entrypoints.length,
      entrypointSample: ex.entrypoints
        .slice(0, 3)
        .map(
          (e) =>
            `${e.name}->${e.target}${e.callable_found === false ? ' (callable not found)' : ''}`,
        ),
      warnings: r.diagnostics
        .filter((d) => d.level !== 'info')
        .map((d) => d.code)
        .join(','),
    });
    process.stdout.write(`ok   ${repo} ${ms}ms\n`);
  } catch (e) {
    rows.push({ repo, error: String(e?.message ?? e).slice(0, 140) });
    process.stdout.write(`FAIL ${repo}: ${String(e?.message ?? e).slice(0, 100)}\n`);
  }
}
let md = `# Execution-model probe: ${name}\n\nAnalyzed commit shown per repository. Hook marked * runs for dependents when building from source. A probe, not a calibration metric.\n\n`;
for (const x of rows) {
  if (x.error) {
    md += `## ${x.repo}\n\nFAILED: ${x.error}\n\n`;
    continue;
  }
  md += `## ${x.repo} @ ${x.commit} (${x.ms} ms, ${x.requests} requests, scan ${x.scan})\n\n`;
  md += `- projects: ${x.projects.length ? '\n' + x.projects.map((p) => `  - ${p}`).join('\n') : 'none'}\n`;
  md += `- hooks: ${x.hooks.length ? '\n' + x.hooks.map((p) => `  - ${p}`).join('\n') : 'none'}\n`;
  md += `- entry points: ${x.entrypoints}${x.entrypointSample.length ? ` (e.g. ${x.entrypointSample.join('; ')})` : ''}\n`;
  if (x.warnings) md += `- warnings: ${x.warnings}\n`;
  md += '\n';
}
mkdirSync(join(root, 'calibration', 'results'), { recursive: true });
writeFileSync(join(root, 'calibration', 'results', `${name}.md`), md);
process.stdout.write(`summary written to calibration/results/${name}.md\n`);
