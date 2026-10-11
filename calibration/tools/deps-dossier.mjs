// Dependency/SBOM evidence dossier for ONE corpus repository, for the reviewer who writes the `dependencies:` label block.
//
// Independence: this script deliberately does NOT import anything from src/ (no analyzer code, no analyzer output). It uses
// crude, separate parsing so labels are not circular. Hits are leads to read, not labels.
//
// Safety: `git` is run with an argument array against a bare clone; nothing from the repository is checked out or executed.
// Usage: RR_CALIB_DIR=calibration/fresh-holdout-0.4 node calibration/tools/deps-dossier.mjs owner/repo
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repo = process.argv[2];
if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo))
  throw new Error('usage: deps-dossier.mjs owner/repo');
const here = dirname(fileURLToPath(import.meta.url));
const calib = process.env.RR_CALIB_DIR ?? join(here, '..');
const commit = JSON.parse(readFileSync(join(calib, 'pins.json'), 'utf8')).repos[repo]?.commit;
const dir = join(
  process.env.RR_CORPUS_DIR ?? join(tmpdir(), 'repo-radar-corpus'),
  repo.replace('/', '__'),
);
const git = (...a) =>
  spawnSync('git', a, {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: 120_000,
  });
const show = (p) => {
  const r = git('show', `${commit}:${p}`);
  return r.status === 0 ? r.stdout : null;
};
const files = (git('ls-tree', '-r', '--name-only', commit).stdout ?? '')
  .split('\n')
  .filter(Boolean);
const out = [];
const p = (s = '') => out.push(s);
p(`# ${repo} @ ${commit}   (${files.length} files)`);

const isAux = (f) =>
  /(?:^|\/)(?:examples?|docs?|website|tests?|tools|scripts|benchmarks?|e2e|fixtures?|testdata|samples?|demos?)\//i.test(
    f,
  );
const manifests = files.filter(
  (f) =>
    /(?:^|\/)(?:package\.json|pyproject\.toml|requirements[\w.-]*\.txt|Cargo\.toml|go\.mod|setup\.py|setup\.cfg|pom\.xml|build\.gradle(?:\.kts)?)$/.test(
      f,
    ) && !/node_modules|vendor\//.test(f),
);
const locks = files.filter((f) =>
  /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|go\.sum|Gemfile\.lock|composer\.lock)$/.test(
    f,
  ),
);
const sboms = files.filter((f) =>
  /(?:^|\/)(?:sbom|bom|cyclonedx|spdx)[\w.-]*\.json$|\.(?:cdx|spdx)\.json$/i.test(f),
);
p('\n## manifests (primary / auxiliary)');
for (const f of manifests.slice(0, 80)) p(`  ${isAux(f) ? 'aux ' : 'main'} ${f}`);
if (manifests.length > 80) p(`  ... ${manifests.length - 80} more`);
p('\n## lockfiles');
for (const f of locks.slice(0, 40)) p(`  ${isAux(f) ? 'aux ' : 'main'} ${f}`);
p('\n## sbom-like files');
for (const f of sboms) p(`  ${f}`);

p('\n## declared dependency counts (crude)');
let primaryDirect = 0;
const names = new Set();
for (const f of manifests.filter((m) => !isAux(m)).slice(0, 40)) {
  const t = show(f);
  if (!t) continue;
  const base = f.split('/').pop();
  let n = 0;
  if (base === 'package.json') {
    try {
      const j = JSON.parse(t);
      const sec = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
      const parts = sec.map((s) => Object.keys(j[s] ?? {}));
      parts.forEach((a) => a.forEach((x) => names.add(`npm:${x}`)));
      n = parts.reduce((a, b) => a + b.length, 0);
      p(
        `  ${f}: deps=${parts[0].length} dev=${parts[1].length} peer=${parts[2].length} optional=${parts[3].length} private=${j.private === true} workspaces=${JSON.stringify(j.workspaces ?? null)}`,
      );
    } catch {
      p(`  ${f}: unparsable`);
    }
  } else if (base === 'go.mod') {
    const req = [
      ...t.matchAll(/^\s*(?:require\s+)?([\w./~-]+\.[\w./~-]+)\s+v[\w.+-]+(\s*\/\/\s*indirect)?/gm),
    ];
    n = req.length;
    req.forEach((m) => names.add(`go:${m[1]}`));
    p(`  ${f}: requires=${req.length} indirect=${req.filter((m) => m[2]).length}`);
  } else if (base === 'Cargo.toml') {
    const inDeps = [
      ...t.matchAll(
        /^\[(?:[\w.-]+\.)?(?:dev-|build-)?dependencies(?:\.([\w-]+))?\]([\s\S]*?)(?=^\[|$(?![\r\n]))/gm,
      ),
    ];
    let c = 0;
    for (const m of inDeps) c += m[1] ? 1 : (m[2].match(/^[\w-]+\s*=/gm) ?? []).length;
    n = c;
    p(`  ${f}: dependency entries~${c} workspace=${/^\[workspace\]/m.test(t)}`);
  } else if (base === 'pyproject.toml') {
    const deps = t.match(/^dependencies\s*=\s*\[([\s\S]*?)\]/m)?.[1] ?? '';
    const k = (deps.match(/"[^"]+"/g) ?? []).length;
    n = k;
    (deps.match(/"([A-Za-z0-9._-]+)/g) ?? []).forEach((x) =>
      names.add(`py:${x.slice(1).toLowerCase()}`),
    );
    p(
      `  ${f}: project.dependencies~${k} build-backend=${t.match(/build-backend\s*=\s*"([^"]+)"/)?.[1] ?? 'none'}`,
    );
  } else if (base?.startsWith('requirements')) {
    const k = t.split('\n').filter((l) => /^[A-Za-z0-9]/.test(l)).length;
    n = k;
    p(`  ${f}: lines~${k}`);
  } else p(`  ${f}: (not counted)`);
  primaryDirect += n;
}
p(`  TOTAL declared by primary manifests ~ ${primaryDirect}`);

for (const f of sboms.slice(0, 3)) {
  const t = show(f);
  p(`\n## ${f}`);
  if (!t) {
    p('  unreadable');
    continue;
  }
  try {
    const j = JSON.parse(t);
    if (j.bomFormat === 'CycloneDX') {
      const comps = j.components ?? [];
      p(
        `  CycloneDX ${j.specVersion}: components=${comps.length}, with purl=${comps.filter((c) => c.purl).length}, types=${[...new Set(comps.map((c) => c.type))].join(',')}`,
      );
      const sn = new Set(
        comps.map((c) =>
          (c.purl ?? '')
            .replace(/^pkg:(\w+)\//, '$1:')
            .replace(/@[^@]*$/, '')
            .replace(/%40/g, '@'),
        ),
      );
      const have = [...names].filter(
        (n) => sn.has(n.replace(/^go:/, 'golang:').replace(/^py:/, 'pypi:')) || sn.has(n),
      );
      p(
        `  declared-name matches in SBOM (crude): ${have.length} of ${names.size}; sample missing: ${[
          ...names,
        ]
          .filter((n) => !have.includes(n))
          .slice(0, 8)
          .join(', ')}`,
      );
      p(
        `  sample components: ${comps
          .slice(0, 6)
          .map((c) => `${c.name}@${c.version}`)
          .join(', ')}`,
      );
    } else if (typeof j.spdxVersion === 'string') {
      const pk = j.packages ?? [];
      p(
        `  ${j.spdxVersion}: packages=${pk.length}, with purl=${pk.filter((x) => (x.externalRefs ?? []).some((r) => r.referenceType === 'purl')).length}`,
      );
      const sn = new Set();
      for (const x of pk)
        for (const r of x.externalRefs ?? [])
          if (r.referenceType === 'purl')
            sn.add(
              r.referenceLocator
                .replace(/^pkg:(\w+)\//, '$1:')
                .replace(/@[^@]*$/, '')
                .replace(/%40/g, '@'),
            );
      const have = [...names].filter((n) => sn.has(n));
      p(
        `  declared-name matches in SBOM (crude): ${have.length} of ${names.size}; sample missing: ${[
          ...names,
        ]
          .filter((n) => !have.includes(n))
          .slice(0, 8)
          .join(', ')}`,
      );
      p(
        `  sample packages: ${pk
          .slice(0, 6)
          .map((x) => `${x.name}@${x.versionInfo}`)
          .join(', ')}`,
      );
    } else p(`  keys: ${Object.keys(j).slice(0, 8).join(',')}`);
  } catch {
    p('  not JSON');
  }
}
process.stdout.write(out.join('\n') + '\n');
