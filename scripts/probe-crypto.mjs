// Real-release probe for cryptographic verification.
//
//   npm run build && GITHUB_TOKEN=... node scripts/probe-crypto.mjs [--out name]
//
// Runs the analyzer's release verification on real releases of real projects and records EVERY outcome, including the ones
// that did not verify: verified, invalid, verification_failed, verification_unavailable, verification_skipped_resource_limit,
// present_unverified. Trust material is supplied the way a user would supply it (a public key fetched out of band from the
// project's own documentation, with a pinned fingerprint), never taken from the analyzed repository's contents. Nothing here
// is tuned: a case that cannot be verified stays in the file as what it is. Writes calibration/results/<name>.md.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { analyzeRepository } from '../dist/analyze.js';
import { gpgKey, minisignKey } from '../dist/trust/config.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const name = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'crypto-probe';
const token = process.env.GITHUB_TOKEN || undefined;

async function fetchText(url) {
  const r = await globalThis.fetch(url, { headers: { 'user-agent': 'repo-radar-probe' } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}

const RESTIC_FPR = 'CF8F18F2844575973F79D4E191A6868BD3F7A907';
// Key sources a user would use: the project's own site / documentation, with a fingerprint printed in that documentation.
const resticKey = await fetchText('https://restic.net/gpg-key-alex.asc').catch(() =>
  fetchText(`https://keys.openpgp.org/vks/v1/by-fingerprint/${RESTIC_FPR}`),
);
const DNSCRYPT_MINISIGN = 'RWTk1xXqcTODeYttYMCMLo0YJHaFEHn7a3akqHlb/7QvIQXHVPxKbjB5';

const CASES = [
  {
    repo: 'goreleaser/goreleaser',
    why: 'Sigstore keyless BLOB bundle over checksums.txt (message signature, GitHub Actions identity)',
    options: { verifyCrypto: true, verifyAssets: true },
  },
  {
    repo: 'goreleaser/goreleaser',
    why: 'the same release with an EXPECTED identity that is wrong (a valid signature by someone else is invalid)',
    options: {
      verifyCrypto: true,
      trust: { keys: [], expectedIdentity: { sourceRepository: 'someone-else/other-repo' } },
    },
  },
  {
    repo: 'restic/restic',
    why: 'OpenPGP detached signature (SHA256SUMS.asc), verified against the key pinned by fingerprint',
    options: {
      verifyAssets: true,
      trust: { keys: [gpgKey(resticKey, 'project_pinned', RESTIC_FPR)] },
    },
  },
  {
    repo: 'restic/restic',
    why: 'the same release, WRONG pinned fingerprint (the key must be rejected, nothing may verify)',
    options: {
      trust: {
        keys: [gpgKey(resticKey, 'project_pinned', '0000000000000000000000000000000000000000')],
      },
    },
  },
  {
    repo: 'restic/restic',
    why: 'the same release with NO trust configured: signatures present but unverified',
    options: {},
  },
  {
    repo: 'DNSCrypt/dnscrypt-proxy',
    why: 'minisign signatures next to release archives, verified against the key published in the project README',
    options: { trust: { keys: [minisignKey(DNSCRYPT_MINISIGN)] } },
  },
  {
    repo: 'cli/cli',
    why: 'GitHub artifact attestations (Sigstore DSSE bundles), with asset checksum verification',
    options: { verifyCrypto: true, verifyAssets: true },
  },
  {
    repo: 'sharkdp/fd',
    why: 'checksum-only release (no signature, no attestation expected)',
    options: { verifyAssets: true },
  },
];

const base = {
  scorecard: false,
  osv: false,
  depsDev: false,
  registry: false,
  sbom: false,
  codeScan: false,
  compliance: false,
  ...(token ? { token } : {}),
};

const STATES = {};
let md = `# Cryptographic verification probe: ${name}\n\nRun ${new Date().toISOString()}. Every case is recorded as it came out. Trust material is supplied as a user would supply it; nothing is read from the analyzed repository.\n\n`;
for (const c of CASES) {
  const t0 = Date.now();
  md += `## ${c.repo} - ${c.why}\n\n`;
  try {
    const r = await analyzeRepository(c.repo, { ...base, ...c.options });
    const rel = r.release_intel.releases.find((x) => !x.prerelease) ?? r.release_intel.releases[0];
    md += `- time ${Date.now() - t0} ms; release ${rel?.tag ?? 'none'}; verification run ${JSON.stringify(r.release_intel.verification_run)}; repository key files: ${(r.release_intel.key_material_in_repository ?? []).map((k) => `${k.path} (${k.state}, trusted=${k.trusted})`).join(', ') || 'none'}\n`;
    for (const s of rel?.signatures ?? []) {
      STATES[s.local_state] = (STATES[s.local_state] ?? 0) + 1;
      md += `- signature ${s.subject.slice(0, 60)} [${s.kind}]: state ${s.state}, local ${s.local_state}, basis ${s.basis}, root ${s.trust_root}${s.local_detail ? ` / engine ${s.local_detail.engine}, local root ${s.local_detail.trust_root}: ${s.local_detail.detail}` : ''}\n`;
    }
    for (const p of rel?.provenance ?? []) {
      STATES[p.verification] = (STATES[p.verification] ?? 0) + 1;
      md += `- attestation ${p.predicate_type.slice(0, 50)}: ${p.verification}${p.verification_detail ? ` (${p.verification_detail.trust_root}; ${p.verification_detail.detail.slice(0, 120)}; signer ${p.verification_detail.identity?.source_repository ?? 'n/a'})` : ''}\n`;
    }
    if (rel && rel.signatures.length === 0 && rel.provenance.length === 0)
      md += `- no signature and no attestation observed (attestations listed by GitHub: ${rel.attestations_listed})\n`;
    for (const a of rel?.asset_checks ?? [])
      md += `- asset ${a.asset.slice(0, 50)}: ${a.state}${a.bytes ? `, ${a.bytes} bytes` : ''}\n`;
    md += `- correspondence ${rel?.correspondence ?? 'n/a'}; limits: ${r.release_intel.limits_hit.join('; ') || 'none'}\n\n`;
    process.stdout.write(`ok   ${c.repo} (${Date.now() - t0} ms)\n`);
  } catch (e) {
    md += `- FAILED: ${String(e?.message ?? e).slice(0, 200)}\n\n`;
    process.stdout.write(`FAIL ${c.repo}: ${String(e?.message ?? e).slice(0, 100)}\n`);
  }
}
md += `## Tally of states seen\n\n${
  Object.entries(STATES)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n') || '- none'
}\n`;
mkdirSync(join(root, 'calibration', 'results'), { recursive: true });
writeFileSync(join(root, 'calibration', 'results', `${name}.md`), md);
process.stdout.write(`wrote calibration/results/${name}.md\n`);
