// Real-repository probe for the dependency subsystem.
//
//   npm run build && GITHUB_TOKEN=... node scripts/probe-deps.mjs [--dist dist] [--out name] [owner/repo ...]
//
// Analyzes each repository at its calibration-pinned commit (calibration/pins.json) with the live OSV and deps.dev
// APIs, and prints/writes a compact summary: dependency counts, resolution and vulnerability coverage, lockfiles,
// SBOMs, external request count and wall time. `--dist <dir>` lets you point at an older build (e.g. a git worktree
// of a previous commit) to measure before/after. Per-repository JSON goes to calibration/runs/deps-probe/ (git-ignored);
// the summary table goes to calibration/results/<name>.md. This is a probe, not a calibration metric: nothing is tuned on it.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const distDir = resolve(root, opt('--dist', 'dist'));
const name = opt('--out', 'deps-probe');
const repos = args.filter(
  (a, i) => !a.startsWith('--') && !['--dist', '--out'].includes(args[i - 1]),
);
const pins = JSON.parse(readFileSync(join(root, 'calibration', 'pins.json'), 'utf8')).repos;
const { analyzeRepository } = await import(pathToFileURL(join(distDir, 'analyze.js')).href);
const token = process.env.GITHUB_TOKEN || undefined;

const outDir = join(root, 'calibration', 'runs', 'deps-probe', name);
mkdirSync(outDir, { recursive: true });
const rows = [];
for (const repo of repos) {
  const commit = pins[repo]?.commit;
  const t0 = Date.now();
  try {
    const r = await analyzeRepository(repo, {
      ...(commit ? { ref: commit } : {}),
      ...(token ? { token } : {}),
      scorecard: false,
    });
    const ms = Date.now() - t0;
    writeFileSync(join(outDir, `${repo.replace('/', '__')}.json`), JSON.stringify(r));
    const d = r.dependency_intel;
    const s = d?.summary;
    const osvEv = (id) => r.evidence.find((e) => e.id === id)?.value;
    rows.push({
      repo,
      commit: (commit ?? r.subject.ref ?? '').slice(0, 10),
      ms,
      requests: r.stats.http_requests,
      discovered: s?.discovered ?? osvEv('osv.checked_packages') ?? null,
      direct: s?.direct ?? null,
      directRegistry: s?.direct_registry ?? null,
      exact: s?.direct_resolved_exact ?? null,
      unresolved: s ? s.direct_unresolved + s.direct_ambiguous : null,
      checkedTotal: s?.vulnerability_checked_total ?? osvEv('osv.checked_packages') ?? null,
      directChecked: s?.direct_vulnerability_checked ?? null,
      vulnerable: s?.vulnerable_total ?? osvEv('osv.vulnerable_packages') ?? null,
      osvCoverage: osvEv('osv.coverage_ratio') ?? null,
      vulnRule: r.dimensions
        .flatMap((x) => x.rules)
        .find((x) => x.rule_id === 'security.known-vulnerabilities'),
      locks: (d?.lockfiles ?? []).map((l) => `${l.format}(${l.packages})`).join(' '),
      sboms: (d?.sboms ?? []).map((x) => `${x.format}:${x.status}`).join(' '),
      sbomCmp: (d?.sbom_comparisons ?? []).map((x) => x.state).join(' '),
      depsDev: d
        ? `${d.deps_dev.state}/${d.deps_dev.enriched}+${d.deps_dev.registry_candidates}`
        : '',
      conflicts: d?.conflicts.length ?? 0,
      diag: r.diagnostics
        .filter((x) => x.level !== 'info')
        .map((x) => x.code)
        .join(','),
    });
    process.stdout.write(`ok   ${repo} ${ms}ms\n`);
  } catch (e) {
    rows.push({ repo, error: String(e?.message ?? e).slice(0, 120) });
    process.stdout.write(`FAIL ${repo}: ${String(e?.message ?? e).slice(0, 100)}\n`);
  }
}
const cell = (v) => (v === null || v === undefined ? '-' : String(v));
let md = `# Dependency probe: ${name}\n\nBuild: ${distDir.replace(root, '.')}. Real repositories at their calibration-pinned commits; live OSV${distDir.endsWith('dist') ? ' and deps.dev' : ''}. A probe, not a calibration metric.\n\n`;
md +=
  '| repo | commit | ms | req | discovered | direct | direct registry | exact | unresolved | direct checked | checked (all) | vulnerable | osv coverage | vuln rule | lockfiles | SBOM | deps.dev | conflicts | warnings |\n';
md +=
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n';
for (const x of rows) {
  if (x.error) {
    md += `| ${x.repo} | | | | | | | | | | | | | FAILED: ${x.error} | | | | | |\n`;
    continue;
  }
  const rule = x.vulnRule
    ? `${x.vulnRule.status}${x.vulnRule.score !== null ? ` ${x.vulnRule.score}` : ''}${x.vulnRule.missing_reason ? ` (${x.vulnRule.missing_reason})` : ''}`
    : '-';
  md += `| ${x.repo} | ${x.commit} | ${x.ms} | ${x.requests} | ${cell(x.discovered)} | ${cell(x.direct)} | ${cell(x.directRegistry)} | ${cell(x.exact)} | ${cell(x.unresolved)} | ${cell(x.directChecked)} | ${cell(x.checkedTotal)} | ${cell(x.vulnerable)} | ${cell(x.osvCoverage)} | ${rule} | ${x.locks || '-'} | ${[x.sboms, x.sbomCmp].filter(Boolean).join(' ') || '-'} | ${x.depsDev || '-'} | ${x.conflicts} | ${x.diag || '-'} |\n`;
}
mkdirSync(join(root, 'calibration', 'results'), { recursive: true });
writeFileSync(join(root, 'calibration', 'results', `${name}.md`), md);
process.stdout.write(`summary written to calibration/results/${name}.md\n`);
