// Real-registry probe for dependency registry intelligence.
//
//   npm run build && node scripts/probe-dep-registry.mjs [--out name]
//
// Looks up a fixed, hand-picked list of real packages (npm, PyPI, crates.io) through the same collector the analyzer uses
// (priority model, budget, correspondence with deps.dev as the second source, publisher / maintainer / repository /
// provenance / install-script events) and writes calibration/results/<name>.md. The list mixes mature stable packages,
// packages with several maintainers, packages known to have been involved in public supply-chain incidents (to see what the
// registry still shows today), and registries that expose less (PyPI). It is a probe, not a calibration metric: nothing is
// tuned on its output, failures are kept in the file, and no claim about any package is made beyond what the registry says.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { collectDependencyRegistry } from '../dist/collectors/dependency-registry.js';
import { REGISTRY_HOSTS } from '../dist/collectors/registry.js';
import { DEPSDEV_HOSTS, enrichWithDepsDev } from '../dist/deps/depsdev.js';
import { systemClock } from '../dist/evidence/builder.js';
import { HttpClient } from '../dist/util/http.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const name = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'dep-registry-probe';

const PICKS = [
  // [ecosystem, name, resolved version, why it is here]
  ['npm', 'lodash', '4.17.21', 'mature, stable, one dominant publisher; no provenance expected'],
  ['npm', 'express', '4.18.2', 'several maintainers over time'],
  ['npm', 'react', '18.2.0', 'large organisation, many maintainers'],
  ['npm', 'sigstore', '3.1.0', 'publishes with npm provenance'],
  ['npm', 'left-pad', '1.3.0', 'deprecated, dormant for years'],
  [
    'npm',
    'event-stream',
    '3.3.4',
    'public incident in 2018 (publisher change, then a malicious dependency)',
  ],
  ['npm', 'ua-parser-js', '0.7.29', 'public account hijack in 2021'],
  ['npm', 'colors', '1.4.0', 'maintainer sabotage in 2022'],
  ['npm', 'rc', '1.2.8', 'public account hijack in 2021'],
  ['npm', 'node-ipc', '9.2.1', 'protestware in 2022'],
  ['pypi', 'requests', '2.31.0', 'PyPI exposes no publisher history'],
  ['pypi', 'urllib3', '2.0.7', 'PyPI exposes no publisher history'],
  ['pypi', 'django', '4.2.7', 'PyPI exposes no publisher history'],
  ['crates.io', 'serde', '1.0.190', 'publishers are visible per version on crates.io'],
  ['crates.io', 'tokio', '1.34.0', 'several publishers'],
  ['crates.io', 'rand', '0.8.5', 'long history'],
];
const ECO = { npm: 'npm', pypi: 'PyPI', 'crates.io': 'crates.io' };

const deps = PICKS.map(([registry, pkg, version], i) => ({
  id: `DEP-${String(i + 1).padStart(4, '0')}`,
  package: { ecosystem: ECO[registry], name: pkg },
  relationship: 'runtime',
  direct: true,
  resolution: 'resolved',
  resolved: { version, source: 'lockfile', file: 'probe', confidence: 0.9 },
  other_versions: [],
  context: 'primary',
  vulnerability: { state: 'not_checked', advisory_ids: [] },
  derived_from: ['probe'],
  confidence: 0.9,
}));

const userAgent = 'repo-radar-probe';
const t0 = Date.now();
// the second source for package <-> repository correspondence
const dd = await enrichWithDepsDev(
  deps,
  new HttpClient({ allowedHosts: DEPSDEV_HOSTS, userAgent }),
  systemClock,
);
const intel = await collectDependencyRegistry({
  http: new HttpClient({ allowedHosts: REGISTRY_HOSTS, userAgent }),
  dependencies: deps,
  clock: systemClock,
  note: (code, message) => process.stderr.write(`note ${code}: ${message}\n`),
});
const ms = Date.now() - t0;

let md = `# Dependency registry probe: ${name}\n\n`;
md += `Run ${new Date().toISOString()}. ${PICKS.length} hand-picked packages, one resolved version each; deps.dev as the second source (state ${dd.state}, ${dd.requests} requests, ${dd.enriched} enriched). Registry lookups through the analyzer's own collector: ${intel.requests} requests, ${intel.bytes} bytes, ${ms} ms in total (deps.dev included).\n\n`;
md += `Coverage: eligible ${intel.coverage.eligible}, queried ${intel.coverage.queried}, ok ${intel.coverage.ok}, failed ${intel.coverage.failed}, skipped ${intel.coverage.skipped}. Budget: ${JSON.stringify(intel.budget)}. Limits hit: ${intel.limits_hit.join('; ') || 'none'}.\n\n`;
md += `Events found (${intel.events_total}); correspondence is repository <-> package PERSPECTIVE only: "confirmed" means three pointers agree and the back-link was not checked.\n\n`;
for (const p of intel.packages) {
  const pick = PICKS.find(
    (x) => x[1] === p.name && ECO[x[0]] === (p.registry === 'pypi' ? 'PyPI' : p.registry),
  );
  md += `## ${p.registry}:${p.name}\n\n`;
  md += `- why: ${pick?.[3] ?? ''}\n`;
  md += `- status ${p.status}${p.status_detail ? ` (${p.status_detail})` : ''}; ${p.versions_total} versions, latest ${p.latest_version}; resolved ${p.resolved_versions.join(', ') || 'unknown'}\n`;
  md += `- repository: declared ${p.repository.declared_url ?? 'none'} -> ${p.repository.normalized ?? 'n/a'}; homepage ${p.repository.homepage_normalized ?? 'n/a'}; deps.dev ${p.corroboration.repositories.join(', ') || 'none'}; correspondence **${p.repository.match}** (${p.repository.reason})\n`;
  md += `- maintainers NOW (current state): ${p.maintainers.names.map((m) => m.name).join(', ') || 'unavailable'}; provenance reported on latest: ${p.versions[0]?.has_provenance ?? 'n/a'} (${p.provenance.versions_with} of the sampled versions)\n`;
  const events = intel.events.filter((e) => e.package === p.name && e.registry === p.registry);
  if (events.length === 0) md += '- events: none in the sampled window\n';
  for (const e of events)
    md += `- event ${e.at.slice(0, 10)} ${e.type} ${e.version} [${e.relative_to_resolved}]: ${e.detail}\n`;
  if (p.limits.length) md += `- limits: ${p.limits.join('; ')}\n`;
  md += '\n';
}
if (intel.skipped.length)
  md += `## Skipped\n\n${intel.skipped.map((s) => `- ${s.ecosystem}:${s.name} (${s.reason})`).join('\n')}\n`;
mkdirSync(join(root, 'calibration', 'results'), { recursive: true });
writeFileSync(join(root, 'calibration', 'results', `${name}.md`), md);
process.stdout.write(
  md.split('\n').slice(0, 12).join('\n') + `\n... wrote calibration/results/${name}.md\n`,
);
