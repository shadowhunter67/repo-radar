// Builds the git-derived ground truth for the dependency-history validation corpus.
// Independent of repo-radar's history engine: it uses a local blobless clone, `git log --follow` (which follows renames),
// and its own manifest parsers (JSON, smol-toml, go.mod lines). No repository code is executed.
// Usage: node scripts/build-history-ground-truth.mjs <clone-root> <out.json>
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { parse as parseToml } from 'smol-toml';

const [cloneRoot, out] = process.argv.slice(2);
const TARGETS = [
  {
    repo: 'expressjs/express',
    dir: 'express',
    path: 'package.json',
    eco: 'npm',
    kind: 'single-package',
  },
  { repo: 'chalk/chalk', dir: 'chalk', path: 'package.json', eco: 'npm', kind: 'single-package' },
  {
    repo: 'sindresorhus/got',
    dir: 'got',
    path: 'package.json',
    eco: 'npm',
    kind: 'single-package',
  },
  {
    repo: 'psf/requests',
    dir: 'requests',
    path: 'pyproject.toml',
    eco: 'pypi',
    kind: 'single-package',
  },
  {
    repo: 'pallets/flask',
    dir: 'flask',
    path: 'pyproject.toml',
    eco: 'pypi',
    kind: 'single-package',
  },
  {
    repo: 'BurntSushi/ripgrep',
    dir: 'ripgrep',
    path: 'Cargo.toml',
    eco: 'cargo',
    kind: 'workspace-root',
  },
  {
    repo: 'serde-rs/serde',
    dir: 'serde',
    path: 'serde/Cargo.toml',
    eco: 'cargo',
    kind: 'workspace-member',
  },
  {
    repo: 'tokio-rs/axum',
    dir: 'axum',
    path: 'axum/Cargo.toml',
    eco: 'cargo',
    kind: 'monorepo-member',
  },
  { repo: 'spf13/cobra', dir: 'cobra', path: 'go.mod', eco: 'go', kind: 'single-package' },
  { repo: 'gin-gonic/gin', dir: 'gin', path: 'go.mod', eco: 'go', kind: 'single-package' },
];
const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

function names(eco, path, text) {
  const set = new Set();
  try {
    if (path.endsWith('package.json')) {
      const j = JSON.parse(text);
      for (const s of [
        'dependencies',
        'devDependencies',
        'optionalDependencies',
        'peerDependencies',
      ])
        for (const k of Object.keys(j[s] ?? {})) set.add(k);
    } else if (path.endsWith('Cargo.toml')) {
      const t = parseToml(text);
      const sections = [
        t.dependencies,
        t['dev-dependencies'],
        t['build-dependencies'],
        t.workspace?.dependencies,
      ];
      for (const s of sections) for (const k of Object.keys(s ?? {})) set.add(k);
      for (const tgt of Object.values(t.target ?? {}))
        for (const k of Object.keys(tgt.dependencies ?? {})) set.add(k);
    } else if (path.endsWith('pyproject.toml')) {
      const t = parseToml(text);
      const add = (specs) => {
        for (const s of specs ?? []) {
          const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(String(s));
          if (m) set.add(m[1].toLowerCase().replace(/[-_.]+/g, '-'));
        }
      };
      add(t.project?.dependencies);
      for (const g of Object.values(t.project?.['optional-dependencies'] ?? {})) add(g);
      for (const g of Object.values(t['dependency-groups'] ?? {})) add(g);
    } else if (path.endsWith('go.mod')) {
      let inBlock = false;
      for (const line of text.split('\n')) {
        const l = line.replace(/\/\/.*$/, '').trim();
        if (/^require\s*\($/.test(l)) inBlock = true;
        else if (inBlock && l === ')') inBlock = false;
        else if (inBlock && l) set.add(l.split(/\s+/)[0]);
        else if (/^require\s+\S+\s+\S+/.test(l)) set.add(l.split(/\s+/)[1]);
      }
    }
  } catch {
    return null; // unparseable at this revision: presence unknown
  }
  return set;
}

const result = [];
const ONLY = process.env.HISTORY_TRUTH_ONLY;
for (const t of TARGETS) {
  if (ONLY && t.repo !== ONLY) continue;
  const dir = join(cloneRoot, t.dir);
  const head = git(dir, 'rev-parse', 'origin/HEAD').trim();
  // commits touching the path, following renames, oldest first, with the path at each commit
  // paths this manifest had over time: discovered with --follow (rename detection), then ALL path-touching commits are listed
  // with --full-history (no history simplification), merges included; merges are filtered by the TREESAME rule below.
  const followRaw = git(
    dir,
    'log',
    head,
    '--follow',
    '--format=tformat:C',
    '--name-status',
    '--',
    t.path,
  );
  const paths = new Set([t.path]);
  for (const line of followRaw.split('\n')) {
    const m = /^R\d*\t(.+)\t(.+)$/.exec(line);
    if (m) {
      paths.add(m[1]);
      paths.add(m[2]);
    }
  }
  const raw = git(
    dir,
    'log',
    head,
    '--full-history',
    '--topo-order',
    '-M',
    '--format=C\t%H\t%cI\t%an\t%cn\t%P',
    '--name-status',
    '--',
    ...paths,
  );
  const commits = [];
  let cur = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('C\t')) {
      const [, sha, date, an, cn, parents] = line.split('\t');
      cur = {
        sha,
        date,
        author: an,
        committer: cn,
        parents: parents.split(' ').filter(Boolean),
        path: null,
        status: null,
        previous_path: null,
      };
      commits.push(cur);
    } else if (cur && /^[AMDRC]\d*\t/.test(line)) {
      const f = line.split('\t');
      cur.status = f[0][0];
      cur.path = f[f.length - 1];
      cur.previous_path = f[0][0] === 'R' ? f[1] : null;
    }
  }
  // canonical definition (docs/dependency-introduction.md): presence transitions are measured by PARENT-DIFF per listed commit
  // (names at the commit vs names at its first parent), and ordered by (committer date, sha). Side branches are not hidden.
  const read = (sha, path) => {
    try {
      return names(t.eco, path, git(dir, 'show', `${sha}:${path}`));
    } catch {
      return undefined; // file absent at that revision
    }
  };
  const transitions = new Map();
  let current = [];
  const pathList = [...paths];
  const readAny = (sha, preferred) => {
    for (const p of [preferred, ...pathList].filter(Boolean)) {
      const v = read(sha, p);
      if (v !== undefined) return v;
    }
    return undefined;
  };
  current = [...(readAny(head) ?? [])];
  const rows2 = [];
  for (const c of commits) {
    const after = c.status === 'D' ? new Set() : readAny(c.sha, c.path);
    if (after === undefined || after === null) {
      rows2.push({ c, adds: new Set(), removes: new Set(), unknown: true });
      continue;
    }
    const parentSets = c.parents.map(
      (q, i) => readAny(q, i === 0 ? (c.previous_path ?? c.path) : undefined) ?? new Set(),
    );
    const adds = new Set();
    const removes = new Set();
    if (c.parents.length === 0 || c.status === 'A') {
      for (const n of after) adds.add(n);
    } else if (c.parents.length === 1) {
      for (const n of after) if (!parentSets[0].has(n)) adds.add(n);
      for (const n of parentSets[0]) if (!after.has(n)) removes.add(n);
    } else {
      // merge: TREESAME rule. A transition counts only when the merge differs from EVERY parent for that name.
      for (const n of after) if (parentSets.every((ps) => !ps.has(n))) adds.add(n);
      const all = new Set(parentSets.flatMap((ps) => [...ps]));
      for (const n of all) if (!after.has(n) && parentSets.every((ps) => ps.has(n))) removes.add(n);
    }
    rows2.push({ c, adds, removes, unknown: false });
  }
  rows2.sort((a, b) => a.c.date.localeCompare(b.c.date) || a.c.sha.localeCompare(b.c.sha));
  for (const { c, adds, removes } of rows2) {
    const note = {
      path: c.path,
      author: c.author,
      committer: c.committer,
      merge: c.parents.length > 1,
      path_created: c.status === 'A',
      renamed_from: c.previous_path,
    };
    for (const n of adds) {
      const list = transitions.get(n) ?? [];
      list.push({
        type:
          list.length === 0
            ? 'introduced'
            : list[list.length - 1].type === 'removed'
              ? 'reintroduced'
              : 'introduced_again_other_line',
        commit: c.sha,
        date: c.date,
        ...note,
      });
      transitions.set(n, list);
    }
    for (const n of removes) {
      const list = transitions.get(n) ?? [];
      list.push({
        type: 'removed',
        commit: c.sha,
        date: c.date,
        path: c.path,
        merge: c.parents.length > 1,
      });
      transitions.set(n, list);
    }
  }
  const renames = commits
    .filter((s) => s.status === 'R')
    .map((s) => ({ commit: s.sha, from: s.previous_path, to: s.path }));
  // deterministic sample of current dependencies (sha256 order, no cherry-picking) + every dependency with a non-simple history
  const byHash = [...current].sort((a, b) =>
    createHash('sha256')
      .update(t.repo + a)
      .digest('hex')
      .localeCompare(
        createHash('sha256')
          .update(t.repo + b)
          .digest('hex'),
      ),
  );
  const sampled = byHash.slice(0, 5);
  const hard = [...transitions.entries()]
    .filter(([, l]) => l.length > 1)
    .map(([n]) => n)
    .slice(0, 4);
  const chosen = [...new Set([...sampled, ...hard])];
  result.push({
    repo: t.repo,
    ecosystem: t.eco,
    kind: t.kind,
    target_sha: head,
    manifest_path: t.path,
    commits_touching_path: commits.length,
    renames,
    commit_order_oldest_first: rows2.map((x) => x.c.sha),
    history_start_commit: rows2[0]?.c.sha ?? null,
    dependencies: chosen.map((n) => ({
      name: n,
      selection: sampled.includes(n) ? 'hash_sample' : 'non_simple_history',
      present_at_target: current.includes(n),
      transitions: transitions.get(n) ?? [],
    })),
  });
  process.stderr.write(
    `${t.repo}: ${commits.length} commits, ${renames.length} renames, ${chosen.length} deps\n`,
  );
}
writeFileSync(
  out,
  JSON.stringify(
    {
      built_with: 'git log --follow --first-parent + own parsers; not repo-radar',
      generated: new Date().toISOString(),
      repos: result,
    },
    null,
    1,
  ),
);
