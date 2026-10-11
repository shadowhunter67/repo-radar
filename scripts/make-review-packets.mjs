// Generates BLIND review packets for human reviewers of a calibration corpus.
//
//   node scripts/make-review-packets.mjs --corpus calibration/fresh-holdout-0.4 [--out calibration/review/fresh-holdout-0.4]
//
// A packet contains only what a reviewer needs to form their own judgement: the repository, the exact pinned commit, a
// browsing link at that commit, the files worth reading (manifests, lockfiles, SBOM-like files, scripts, installers,
// top-level layout) and an EMPTY label form. It deliberately contains NEITHER repo-radar output NOR the existing
// AI-assisted labels, so a reviewer cannot be anchored by them. Compare with calibration/review/compare-reviews.mjs only
// AFTER the reviewer has submitted their own labels.
//
// Safety: `git` is run with an argument array against bare clones (see calibration/tools/fetch-corpus.mjs); nothing from
// a repository is checked out or executed.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const corpusRel = opt('--corpus', 'calibration');
const calib = join(root, corpusRel);
const dataset = parse(readFileSync(join(calib, 'dataset.yaml'), 'utf8'));
const pins = JSON.parse(readFileSync(join(calib, 'pins.json'), 'utf8')).repos;
const corpusId = dataset.corpus_id ?? 'calibration-v0';
const outDir = join(root, opt('--out', join('calibration', 'review', corpusId)));
const clones = process.env.RR_CORPUS_DIR ?? join(tmpdir(), 'repo-radar-corpus');
mkdirSync(join(outDir, 'packets'), { recursive: true });

const TRI = 'yes | no | unknown | disputed';
const CAPABILITIES = [
  'PROCESS_EXEC',
  'NETWORK_CLIENT',
  'NETWORK_SERVER',
  'REMOTE_DOWNLOAD',
  'FILESYSTEM_WRITE',
  'DYNAMIC_CODE_LOAD',
  'CREDENTIAL_ACCESS',
  'ENVIRONMENT_READ',
  'BACKGROUND_PROCESS',
];
const form = {
  reviewer: { id: '<your id>', kind: 'human-single', labelled_on: '<YYYY-MM-DD>' },
  artifact_type:
    '<library | application | cli | service | framework | plugin | extension | sdk | tooling | monorepo | ...>',
  artifact_also_acceptable: [],
  domain: '<free text slug, e.g. developer-tooling>',
  capabilities: Object.fromEntries(CAPABILITIES.map((c) => [c, `<${TRI}>`])),
  install_hooks: { automatic: `<${TRI}>`, names: [] },
  persistence: `<${TRI}>`,
  hard_coded_secrets: `<${TRI}>`,
  dependencies: {
    has_lockfile: '<yes | no | unknown | disputed | not_applicable>',
    lockfile_types: [],
    lockfile_scope: '<root | workspace | none | unknown>',
    dependency_manifest_count: '<number | unknown>',
    direct_dependency_count_expected: '<number | unknown>',
    exact_version_expected: '<yes | no | unknown | disputed | not_applicable>',
    osv_checkable: '<yes | no | unknown | disputed | not_applicable>',
    osv_expected_known_vulnerabilities: '<yes | no | unknown | disputed | not_applicable>',
    has_sbom: '<yes | no | unknown | disputed | not_applicable>',
    sbom_format: '<CycloneDX | SPDX | other | none | unknown>',
    sbom_scope: '<application | library | container | mixed | ci_workflow | none | unknown>',
    sbom_consistency:
      '<consistent | partial | mismatch | unable_to_compare | unknown | not_applicable | disputed>',
    manifest_sbom_missing: '<yes | no | unknown | disputed | not_applicable>',
    sbom_extra_components: '<yes | no | unknown | disputed | not_applicable>',
    auxiliary_dependency_presence: '<yes | no | unknown | disputed | not_applicable>',
    dependency_scope_ambiguity: '<yes | no | unknown | disputed | not_applicable>',
  },
  notes: '<free text: what you read, what you could not decide and why>',
};

const run = (dir, a) =>
  spawnSync('git', a, {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: 120_000,
  });
const index = [];
for (const { repo } of dataset.repositories) {
  const commit = pins[repo]?.commit;
  if (!commit) continue;
  const dir = join(clones, repo.replace('/', '__'));
  const files = (run(dir, ['ls-tree', '-r', '--name-only', commit]).stdout ?? '')
    .split('\n')
    .filter(Boolean);
  const pick = (re, max = 40) => files.filter((f) => re.test(f)).slice(0, max);
  const topLevel = [...new Set(files.map((f) => f.split('/')[0]))].slice(0, 60);
  const packet = {
    packet_version: 1,
    corpus: corpusId,
    repository: repo,
    commit,
    browse: `https://github.com/${repo}/tree/${commit}`,
    file_count: files.length,
    blind: 'This packet contains no analyzer output and no existing labels.',
    read_these: {
      manifests: pick(
        /(?:^|\/)(?:package\.json|pyproject\.toml|setup\.py|setup\.cfg|requirements[\w.-]*\.txt|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?)$/,
      ),
      lockfiles: pick(
        /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|go\.sum|Gemfile\.lock|composer\.lock)$/,
      ),
      sbom_like: pick(/(?:^|\/)(?:sbom|bom|cyclonedx|spdx)[\w.-]*\.json$|\.(?:cdx|spdx)\.json$/i),
      install_and_build_scripts: pick(
        /(?:^|\/)(?:install|setup|bootstrap)[\w.-]*\.(?:sh|ps1|py|js)$|(?:^|\/)(?:Dockerfile[\w.-]*|Makefile|build\.rs|binding\.gyp|CMakeLists\.txt)$/,
      ),
      ci_workflows: pick(/^\.github\/workflows\//, 15),
    },
    top_level_entries: topLevel,
    label_form: form,
  };
  writeFileSync(
    join(outDir, 'packets', `${repo.replace('/', '__')}.json`),
    JSON.stringify(packet, null, 2) + '\n',
  );
  index.push({ repository: repo, commit, packet: `packets/${repo.replace('/', '__')}.json` });
}
writeFileSync(
  join(outDir, 'index.json'),
  JSON.stringify(
    { corpus: corpusId, generated_for: 'blind human review', repositories: index },
    null,
    2,
  ) + '\n',
);
process.stdout.write(`wrote ${index.length} blind packets to ${outDir.replace(root, '.')}\n`);
