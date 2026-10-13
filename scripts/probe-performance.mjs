// Performance probe for the 0.7 subsystems.
//
//   npm run build && GITHUB_TOKEN=... node scripts/probe-performance.mjs [--out name] [owner/repo ...]
//
// Real part: the same repositories analyzed with the 0.7 additions (dependency registry, domains) on and off, so their
// cost in requests and time is a difference, not a guess. Synthetic part: micro-benchmarks at the documented caps (domain
// extraction over a full scan sample, event correlation over a full timeline, trust-graph construction and serialization at
// the node and edge limits, priority ranking of thousands of dependencies). Sequential on purpose; wall-clock numbers depend
// on the machine and the network and are recorded, not asserted. Writes calibration/results/<name>.md.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { analyzeRepository } from '../dist/analyze.js';
import { extractDomains } from '../dist/domains/extract.js';
import { correlate, BUILTIN_PATTERNS } from '../dist/events/correlate.js';
import { GRAPH_LIMITS, buildTrustGraph } from '../dist/graph/trust.js';
import { selectCandidates } from '../dist/registry/dependency-priority.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const name = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'performance-probe';
const repos = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
const token = process.env.GITHUB_TOKEN || undefined;
const REPOS = repos.length ? repos : ['sharkdp/fd', 'BurntSushi/ripgrep', 'expressjs/express'];
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MiB`;
const ms = (n) => `${Math.round(n)} ms`;

let md = `# Performance probe: ${name}\n\nRun ${new Date().toISOString()} on ${process.platform}, Node ${process.version}. Wall-clock times include the network and vary; request counts are exact.\n\n## Real repositories: cost of the 0.7 additions\n\n| repository | configuration | time | HTTP requests | dep. registry (queried/eligible, requests) | domains | graph nodes/edges |\n| --- | --- | --- | --- | --- | --- | --- |\n`;
const base = {
  scorecard: false,
  osv: false,
  depsDev: false,
  sbom: false,
  ...(token ? { token } : {}),
};
let lastReport;
for (const repo of REPOS) {
  for (const [label, opts] of [
    ['0.7 defaults', {}],
    ['--no-dep-registry --no-domains', { dependencyRegistry: false, domains: false }],
    ['--no-registry --no-domains', { registry: false, domains: false }],
  ]) {
    const t0 = performance.now();
    try {
      const r = await analyzeRepository(repo, { ...base, ...opts });
      const t = performance.now() - t0;
      const g = buildTrustGraph(r);
      const d = r.dependency_registry_intel;
      lastReport = r;
      md += `| ${repo} | ${label} | ${ms(t)} | ${r.stats.http_requests} | ${d.status === 'analyzed' ? `${d.coverage.queried}/${d.coverage.eligible}, ${d.requests} req, ${mb(d.bytes)}` : d.status} | ${r.external_domains.status === 'analyzed' ? `${r.external_domains.domains_total} hosts` : r.external_domains.status} | ${g.nodes.length}/${g.edges.length} |\n`;
    } catch (e) {
      md += `| ${repo} | ${label} | FAILED | ${String(e?.message ?? e).slice(0, 80)} | | | |\n`;
    }
  }
}

md += '\n## Synthetic: the documented caps\n\n';
// domain extraction over a full scan sample (40 files, 6,000 lines each)
{
  const files = Array.from({ length: 40 }, (_, i) => ({
    path: `src/f${i}.ts`,
    role: 'source',
    size: 0,
    content: Array.from({ length: 6000 }, (_, l) =>
      l % 7 === 0
        ? `fetch('https://h${i}-${l}.vendor.io/api/v1') // https://doc${l}.vendor.io`
        : `const x${l} = compute(${l}, 'a/b/c');`,
    ).join('\n'),
  }));
  const t0 = performance.now();
  const r = extractDomains({ files, hooks: [], detections: [] });
  md += `- domain extraction, 40 files x 6,000 lines (${mb(files.reduce((n, f) => n + f.content.length, 0))} of text): ${ms(performance.now() - t0)}; ${r.domains_total} hosts kept (cap ${300} reported), limits hit: ${r.limits_hit.join('; ') || 'none'}\n`;
}
// correlation over a full timeline
{
  const types = [
    'commit',
    'dormancy_end',
    'new_committer',
    'release',
    'registry_publish',
    'new_publisher',
    'dependency_publisher_changed',
    'dependency_install_hook_introduced',
    'dependency_dormancy_ended',
    'external_domain_introduced',
    'install_hook_introduced',
  ];
  const events = Array.from({ length: 200 }, (_, i) => ({
    id: `EV-${i}`,
    type: types[i % types.length],
    at: new Date(Date.UTC(2025, 0, 1) + i * 3 * 86400000).toISOString(),
    subject: 'x',
    source: 'git',
    detail: 'd',
    confidence: 0.5,
    evidence: [],
    entity: `npm:p${i % 9}`,
  }));
  const t0 = performance.now();
  const c = correlate(events, BUILTIN_PATTERNS);
  md += `- correlation, 200 events x ${BUILTIN_PATTERNS.length} patterns: ${ms(performance.now() - t0)}; ${c.length} correlations (the search budget is 200,000 steps per pattern)\n`;
}
// priority ranking
{
  const deps = Array.from({ length: 5000 }, (_, i) => ({
    id: `DEP-${i}`,
    package: { ecosystem: 'npm', name: `pkg-${i}` },
    relationship: i % 3 ? 'runtime' : 'development',
    direct: i % 5 === 0,
    resolution: 'resolved',
    resolved: { version: '1.0.0' },
    context: 'primary',
    vulnerability: { state: 'checked', advisory_ids: i % 50 === 0 ? ['X'] : [] },
  }));
  const t0 = performance.now();
  const s = selectCandidates(deps);
  md += `- dependency priority ranking, 5,000 dependencies: ${ms(performance.now() - t0)}; ${s.ranked.length} candidates\n`;
}
// trust graph at the limits
if (lastReport) {
  const big = JSON.parse(JSON.stringify(lastReport));
  big.external_domains.domains = Array.from({ length: 5000 }, (_, i) => ({
    hostname: `h${i}.vendor.io`,
    display: `h${i}.vendor.io`,
    ports: [],
    schemes: ['https'],
    category: 'generic_external',
    ambiguity: 'none',
    strongest_context: 'runtime',
    contexts: ['runtime'],
    confidence: 0.6,
    observations: [{ context: 'runtime', file: 'src/a.ts', line: 1, confidence: 0.6, bare: false }],
    observations_total: 1,
    credentials_in_url: false,
    notes: [],
  }));
  const before = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  const g = buildTrustGraph(big);
  const t = performance.now() - t0;
  const json = JSON.stringify(g);
  md += `- trust graph, 5,000 domains offered (limit ${GRAPH_LIMITS.domains}): ${ms(t)}; ${g.nodes.length} nodes, ${g.edges.length} edges, truncated=${g.truncated}, ${g.dropped_without_evidence} edges dropped for lack of evidence, ${mb(json.length)} serialized, heap +${mb(Math.max(0, process.memoryUsage().heapUsed - before))}\n`;
}
mkdirSync(join(root, 'calibration', 'results'), { recursive: true });
writeFileSync(join(root, 'calibration', 'results', `${name}.md`), md);
process.stdout.write(md + `\nwrote calibration/results/${name}.md\n`);
