// Real probe of cryptographic verification on release attestations and bounded asset checks.
//
//   npm run build && GITHUB_TOKEN=... node scripts/probe-trust.mjs [--out name] [--assets] owner/repo ...
//
// Runs the analyzer with --verify-crypto (Sigstore public-good trust root; contacts the Sigstore TUF repository) on the
// default-branch head and records, per repository, the verification state of every attestation, the source-correspondence
// class and the SLSA-related observations. Failures and unavailable evidence are listed, not hidden. A probe, not a metric.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { analyzeRepository } from '../dist/analyze.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const name = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'trust-probe';
const assets = args.includes('--assets');
const repos = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
const token = process.env.GITHUB_TOKEN || undefined;
let md = `# Trust probe: ${name}\n\nSigstore public-good trust root via the library's TUF client. Time ${new Date().toISOString()}. Sequential.\n\n`;
for (const repo of repos) {
  const t0 = Date.now();
  try {
    const r = await analyzeRepository(repo, {
      ...(token ? { token } : {}),
      scorecard: false, osv: false, depsDev: false, sbom: false, codeScan: false, registry: false,
      verifyCrypto: true, verifyAssets: assets,
    });
    const rel = r.release_intel.releases.find((x) => x.provenance.length || x.attestations_listed || x.asset_checks.length) ?? r.release_intel.releases.find((x) => !x.prerelease) ?? r.release_intel.releases[0];
    md += `## ${repo} @ ${r.subject.ref}\n\n- ${Date.now() - t0} ms, release requests ${r.release_intel.requests}\n`;
    if (!rel) md += '- no release\n\n';
    else {
      md += `- release ${rel.tag} (${rel.published_at?.slice(0, 10)}), tag ${rel.tag_kind} ${rel.tag_commit?.slice(0, 10) ?? ''}; tag signature: ${rel.signatures.filter((s) => s.subject === 'tag').map((s) => `${s.state} via ${s.trust_root} (local: ${s.local_state})`).join(', ') || 'none'}\n`;
      md += `- attestations listed ${rel.attestations_listed}, readable ${rel.provenance.length}: ${rel.provenance.map((p) => `${p.verification}${p.verification_detail ? ` [${p.verification_detail.trust_root}; ${p.verification_detail.identity?.source_repository ?? 'no identity'}; ${p.verification_detail.detail.slice(0, 70)}]` : ''}`).join(' | ') || 'none'}\n`;
      md += `- correspondence **${rel.correspondence}**; slsa observations ${JSON.stringify(rel.slsa)}\n`;
      for (const c of rel.asset_checks) md += `- asset ${c.asset}: ${c.state} ${c.bytes ?? ''} ${c.inspection ? c.inspection.format + '/' + (c.inspection.architecture ?? '') : ''}\n`;
      for (const l of r.release_intel.limits_hit) md += `- limit: ${l}\n`;
      md += '\n';
    }
    process.stdout.write(`ok   ${repo}\n`);
  } catch (e) {
    md += `## ${repo}\n\nFAILED: ${String(e?.message ?? e).slice(0, 200)}\n\n`;
    process.stdout.write(`FAIL ${repo}\n`);
  }
}
writeFileSync(join(root, 'calibration', 'results', `${name}.md`), md);
process.stdout.write(`wrote calibration/results/${name}.md\n`);
