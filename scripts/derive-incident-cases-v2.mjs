import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import process from 'node:process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'calibration', 'incidents');
const rawRoot = join(root, 'raw');
const old = JSON.parse(readFileSync(join(root, 'cases.json'), 'utf8'));
const incident = [
  [
    'npm-ledgerhq-connect-kit',
    '@ledgerhq/connect-kit',
    'https://www.npmjs.com/package/@ledgerhq/connect-kit',
  ],
  [
    'npm-lottiefiles-lottie-player',
    '@lottiefiles/lottie-player',
    'https://www.npmjs.com/package/@lottiefiles/lottie-player',
  ],
  ['npm-xrpl', 'xrpl', 'https://www.npmjs.com/package/xrpl'],
  [
    'npm-eslint-config-prettier',
    'eslint-config-prettier',
    'https://www.npmjs.com/package/eslint-config-prettier',
  ],
  ['npm-ctrl-tinycolor', '@ctrl/tinycolor', 'https://www.npmjs.com/package/@ctrl/tinycolor'],
  ['npm-is', 'is', 'https://www.npmjs.com/package/is'],
  ['npm-rand-user-agent', 'rand-user-agent', 'https://www.npmjs.com/package/rand-user-agent'],
];
const benign = [
  ['npm-vue', 'vue', 'https://www.npmjs.com/package/vue'],
  ['npm-axios', 'axios', 'https://www.npmjs.com/package/axios'],
  ['npm-commander', 'commander', 'https://www.npmjs.com/package/commander'],
  ['npm-yargs', 'yargs', 'https://www.npmjs.com/package/yargs'],
  ['npm-glob', 'glob', 'https://www.npmjs.com/package/glob'],
  ['npm-semver', 'semver', 'https://www.npmjs.com/package/semver'],
  ['npm-uuid', 'uuid', 'https://www.npmjs.com/package/uuid'],
  ['npm-rimraf', 'rimraf', 'https://www.npmjs.com/package/rimraf'],
  ['npm-cross-env', 'cross-env', 'https://www.npmjs.com/package/cross-env'],
  ['npm-ms', 'ms', 'https://www.npmjs.com/package/ms'],
  ['npm-qs', 'qs', 'https://www.npmjs.com/package/qs'],
  ['npm-body-parser', 'body-parser', 'https://www.npmjs.com/package/body-parser'],
  ['npm-cookie', 'cookie', 'https://www.npmjs.com/package/cookie'],
  ['npm-inherits', 'inherits', 'https://www.npmjs.com/package/inherits'],
  ['crates-regex', 'regex', 'https://crates.io/crates/regex'],
  ['crates-clap', 'clap', 'https://crates.io/crates/clap'],
  ['crates-time', 'time', 'https://crates.io/crates/time'],
  ['crates-log', 'log', 'https://crates.io/crates/log'],
];
const split = (ecosystem, pkg) => {
  const n = createHash('sha256').update(`${ecosystem}:${pkg}`).digest()[0] % 10;
  return n < 6 ? 'development' : n < 8 ? 'validation' : 'holdout';
};
const iso = (v) => new Date(v).toISOString();
const npmEvents = (pkg, raw) => {
  const versions = Object.entries(raw.versions ?? {})
    .map(([version, value]) => ({ version, value, date: raw.time?.[version] }))
    .filter((x) => x.date && Number.isFinite(Date.parse(x.date)))
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const events = [];
  let previous;
  for (const current of versions) {
    const v = current.value ?? {};
    const publisher = v._npmUser?.name ?? null;
    const maintainers = (v.maintainers ?? [])
      .map((x) => x.name ?? x.login ?? '')
      .sort()
      .join('|');
    const repository =
      typeof v.repository === 'string' ? v.repository : (v.repository?.url ?? null);
    const hook = Object.keys(v.scripts ?? {}).some((x) =>
      ['preinstall', 'install', 'postinstall'].includes(x),
    );
    const provenance = !!v.dist?.attestations;
    if (previous) {
      const add = (type) =>
        events.push({ type, version: current.version, date: iso(current.date) });
      if (publisher && previous.publisher && publisher !== previous.publisher)
        add('dependency_publisher_changed');
      if (maintainers && previous.maintainers && maintainers !== previous.maintainers)
        add('dependency_maintainer_changed');
      if (repository && previous.repository && repository !== previous.repository)
        add('dependency_repository_changed');
      if (hook && !previous.hook) add('dependency_install_hook_introduced');
      if (provenance !== previous.provenance)
        add(provenance ? 'dependency_provenance_added' : 'dependency_provenance_removed');
      if (Date.parse(current.date) - Date.parse(previous.date) > 180 * 86400000)
        add('dependency_dormancy_ended');
    }
    previous = { publisher, maintainers, repository, hook, provenance };
  }
  return { versions, events };
};
const crateCase = (name, raw) => {
  const versions = Array.isArray(raw.versions) ? raw.versions : [];
  return {
    versions: versions
      .map((v) => ({ version: v.num, date: v.created_at }))
      .filter((v) => v.version && v.date),
    events: [],
    notes: `${name} crates.io snapshot has version timestamps but no publisher, maintainer, repository, install-script, or provenance history; those labels are insufficient_evidence rather than inferred false.`,
  };
};
const labelsFor = (events, unknown = false) =>
  Object.fromEntries([
    [
      'publisher_change',
      unknown ? 'unknown' : String(events.some((e) => e.type === 'dependency_publisher_changed')),
    ],
    [
      'maintainer_change',
      unknown ? 'unknown' : String(events.some((e) => e.type === 'dependency_maintainer_changed')),
    ],
    [
      'repository_change',
      unknown ? 'unknown' : String(events.some((e) => e.type === 'dependency_repository_changed')),
    ],
    [
      'dormancy_end',
      unknown ? 'unknown' : String(events.some((e) => e.type === 'dependency_dormancy_ended')),
    ],
    ['release_cadence_change', 'unknown'],
    [
      'install_script_introduced',
      unknown
        ? 'unknown'
        : String(events.some((e) => e.type === 'dependency_install_hook_introduced')),
    ],
    [
      'provenance_changed',
      unknown
        ? 'unknown'
        : String(
            events.some(
              (e) =>
                e.type === 'dependency_provenance_added' ||
                e.type === 'dependency_provenance_removed',
            ),
          ),
    ],
    ['external_domain_introduced', 'unknown'],
  ]);
const make = ([fileName, pkg, source], kind) => {
  const ecosystem = fileName.startsWith('crates-') ? 'crates.io' : 'npm';
  const rawFile = `raw/${fileName}.json`;
  const raw = JSON.parse(readFileSync(join(rawRoot, `${fileName}.json`), 'utf8'));
  const derived = ecosystem === 'npm' ? npmEvents(pkg, raw) : crateCase(pkg, raw);
  const versions = derived.versions;
  const dates = versions
    .map((v) => v.date)
    .filter(Boolean)
    .sort();
  const events = derived.events;
  const incidentDates = events
    .map((e) => e.date)
    .filter((d) => d >= '2023-01-01' && d <= '2025-12-31');
  const hasIncidentEvidence = kind === 'incident' && incidentDates.length > 0;
  const from = incidentDates[0] ?? dates[0] ?? '2010-01-01T00:00:00Z';
  const to = incidentDates.at(-1) ?? dates.at(-1) ?? '2026-01-01T00:00:00Z';
  const id = `${ecosystem}-${pkg.replaceAll('/', '-')}-v2-history`;
  const pattern = Object.fromEntries(
    [
      'dependency-takeover-indicators',
      'dependency-dormancy-publisher-hook',
      'dependency-publisher-change-then-new-domain',
    ].map((x) => [
      x,
      {
        should_fire: kind === 'incident' ? null : false,
        justification:
          kind === 'incident'
            ? 'Abstention: registry history cannot establish the package incident pattern without the removed payload, install behavior, or domain evidence.'
            : 'Benign control; no compromise conclusion is inferred from this pinned registry history.',
      },
    ]),
  );
  return {
    id,
    package: pkg,
    ecosystem,
    raw_file: rawFile,
    split: split(ecosystem, pkg),
    kind: kind === 'incident' ? 'incident' : 'benign_control',
    incident_window: { from, to },
    known_good_window: { from: '2010-01-01T00:00:00Z', to: from },
    resolved_version_candidates: versions.slice(-3).map((v) => v.version),
    labels: labelsFor(events, ecosystem === 'crates.io'),
    expected_events: events,
    pattern_expectations: pattern,
    conclusion:
      kind === 'incident' && hasIncidentEvidence
        ? 'known_compromise'
        : kind === 'incident'
          ? 'insufficient_evidence'
          : 'known_benign_control',
    incident_confidence: kind === 'incident' && hasIncidentEvidence ? 'low' : 'low',
    sources: [source],
    notes:
      derived.notes ??
      'Labels and events were independently derived from the pinned raw registry response by scripts/derive-incident-cases-v2.mjs; no production parser output was copied into this case.',
  };
};
const histories = [
  ...incident.map((x) => make(x, 'incident')),
  ...benign.map((x) => make(x, 'benign')),
];
const windows = histories
  .filter((c) => c.kind === 'incident' && c.conclusion === 'known_compromise')
  .map((c) => ({
    ...c,
    id: c.id.replace(/-history$/, '-incident-window'),
    expected_events: c.expected_events.filter(
      (e) => e.date >= '2023-01-01T00:00:00.000Z' && e.date <= '2025-12-31T23:59:59.999Z',
    ),
    notes: `${c.notes} This separate incident-window case is limited to versions and events actually present in the pinned 2023-2025 raw history.`,
  }));
const additions = [...histories, ...windows];
const keep = old
  .filter((c) => !additions.some((x) => x.ecosystem === c.ecosystem && x.package === c.package))
  .map((c) =>
    ['express', 'faker', 'flatmap-stream'].includes(c.package) ? { ...c, holdout_spent: true } : c,
  );
writeFileSync(join(root, 'cases.json'), JSON.stringify([...keep, ...additions], null, 2) + '\n');
process.stdout.write(
  `wrote ${additions.length} v2 cases; total ${keep.length + additions.length}\n`,
);
