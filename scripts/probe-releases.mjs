// Real-repository probe for release / provenance / governance intelligence.
//
//   npm run build && GITHUB_TOKEN=... node scripts/probe-releases.mjs [--out name] owner/repo ...
//
// Analyzes each repository's default-branch head WITHOUT enrichment and prints what the release and governance sections
// found: tag kind and signature state, assets, checksum files, provenance and the source correspondence class. Sequential.
// A probe, not a metric: nothing is tuned on it. Writes calibration/results/<name>.md.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { analyzeRepository } from '../dist/analyze.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const name = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'release-probe';
const repos = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
const token = process.env.GITHUB_TOKEN || undefined;
let md = `# Release probe: ${name}\n\nDefault-branch head at probe time (commit recorded per repository). No enrichment. Sequential.\n\n`;
for (const repo of repos) {
  const t0 = Date.now();
  try {
    const r = await analyzeRepository(repo, {
      ...(token ? { token } : {}),
      scorecard: false,
      osv: false,
      depsDev: false,
      sbom: false,
      scan: false,
      codeScan: false,
    });
    const ri = r.release_intel;
    md += `## ${repo} @ ${r.subject.ref}\n\n- ${Date.now() - t0} ms; release requests ${ri.requests}; status ${ri.status}; releases ${ri.releases_total}\n`;
    for (const rel of ri.releases.slice(0, 3)) {
      const kinds = {};
      for (const a of rel.assets) kinds[a.kind] = (kinds[a.kind] ?? 0) + 1;
      md += `- ${rel.tag} (${rel.published_at?.slice(0, 10)}, by ${rel.published_by}): tag ${rel.tag_kind}${rel.tag_commit ? ' ' + rel.tag_commit.slice(0, 10) : ''}; assets ${rel.assets_total} ${JSON.stringify(kinds)}; with digest ${rel.assets.filter((a) => a.digest).length}; checksum files ${rel.checksum_files.map((c) => `${c.asset}(${c.entries} entries, covers ${c.covers_assets})`).join(', ') || 'none'}; signatures ${rel.signatures.map((s) => `${s.subject}:${s.state}`).join(', ') || 'none'}; provenance ${rel.provenance.length}; correspondence **${rel.correspondence}**\n`;
    }
    if (ri.limits_hit.length) md += `- limits: ${ri.limits_hit.join('; ')}\n`;
    const g = r.governance;
    md += `- governance: ${g.status}; window ${g.window.commits} commits / ${g.window.commit_span_days} days / ${g.window.releases} releases; signals ${g.signals.map((s) => s.kind).join(', ') || 'none'}; takeover indicators ${g.takeover_indicators?.observed}\n\n`;
    process.stdout.write(`ok   ${repo}\n`);
  } catch (e) {
    md += `## ${repo}\n\nFAILED: ${String(e?.message ?? e).slice(0, 200)}\n\n`;
    process.stdout.write(`FAIL ${repo}\n`);
  }
}
writeFileSync(join(root, 'calibration', 'results', `${name}.md`), md);
process.stdout.write(`wrote calibration/results/${name}.md\n`);
