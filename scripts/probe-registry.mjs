// Real-registry probe: npm, PyPI, crates.io packages published by the given repositories.
//
//   npm run build && GITHUB_TOKEN=... node scripts/probe-registry.mjs [--out name] owner/repo[@sha] ...
//
// Prints, per package, the registry lookup status, repository correspondence, latest version, publisher history signals
// and what the registry does NOT expose. Nothing is installed or executed; sequential on purpose. Observations are time
// dependent (the registry's current state): the lookup time is recorded. A probe, not a metric.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { analyzeRepository } from '../dist/analyze.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const name = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'registry-probe';
const repos = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
const token = process.env.GITHUB_TOKEN || undefined;
let md = `# Registry probe: ${name}\n\nLookup time ${new Date().toISOString()} (registry state is current-state; publish times are history). Sequential.\n\n`;
for (const spec of repos) {
  const [repo, sha] = spec.split('@');
  try {
    const t0 = Date.now();
    const r = await analyzeRepository(repo, {
      ...(sha ? { ref: sha } : {}),
      ...(token ? { token } : {}),
      scorecard: false,
      osv: false,
      depsDev: false,
      sbom: false,
      codeScan: false,
      releases: false,
    });
    const ri = r.registry_intel;
    md += `## ${repo} @ ${r.subject.ref}\n\n- ${Date.now() - t0} ms; registry requests ${ri.requests}; status ${ri.status}\n`;
    for (const p of ri.packages)
      md += `- **${p.registry}:${p.name}** (declared by ${p.declared_by}): ${p.status}${p.status_detail ? ' (' + p.status_detail + ')' : ''}; repository **${p.repository.match}** (${p.repository.reason}); latest ${p.latest_version}; ${p.versions_total} versions; newest ${p.versions[0]?.published_at?.slice(0, 10)} by ${p.versions[0]?.publisher?.name ?? 'n/a'}; maintainers now ${p.maintainers.names.length}; provenance ${p.provenance.reported}\n`;
    for (const s of ri.signals) md += `  - signal ${s.kind} [${s.scope}] ${s.detail}\n`;
    md += '\n';
    process.stdout.write(`ok   ${repo}\n`);
  } catch (e) {
    md += `## ${repo}\n\nFAILED: ${String(e?.message ?? e).slice(0, 200)}\n\n`;
    process.stdout.write(`FAIL ${repo}\n`);
  }
}
writeFileSync(join(root, 'calibration', 'results', `${name}.md`), md);
process.stdout.write(`wrote calibration/results/${name}.md\n`);
