import { z } from 'zod';
import type { ParsedManifest } from '../collectors/manifests/parse.js';
import { LIMITS } from '../limits.js';
import { sanitizeForTerminal } from '../util/text.js';
import { extractLocalRefs, resolveRef } from './refs.js';
import { scanFile, type FileScan } from './scan.js';
import {
  CAPABILITIES,
  CAPABILITY_RISK,
  RISK_ORDER,
  maxRisk,
  type Capability,
  type ExecContext,
  type RiskLevel,
  type ScannedFile,
} from './types.js';

export const ExecNodeSchema = z.object({
  id: z.string(),
  kind: z.enum(['hook', 'script', 'command', 'file', 'implicit']),
  label: z.string(),
  file: z.string().optional(),
  analyzed: z.boolean(),
});
export const ExecEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  relation: z.enum(['RUNS', 'EXECUTES', 'REFERENCES', 'DOWNLOADS']),
});
export const HookSchema = z.object({
  id: z.string(),
  ecosystem: z.enum(['npm', 'pypi', 'cargo', 'docker', 'make', 'shell']),
  name: z.string(),
  /** When the hook runs, in plain words. */
  trigger: z.string(),
  /** Runs when this package is installed as a dependency of someone else. */
  runs_for_dependents: z.boolean(),
  context: z.enum(['install', 'build']),
  script: z.string().optional(),
  risk: z.enum(['none', 'low', 'medium', 'high']),
  /** Risk is capability-based, never an intent judgement. */
  confidence: z.number().min(0).max(1),
  /** Whether every file on the path could be read; false lowers confidence. */
  analyzed: z.boolean(),
  capabilities: z.array(z.enum(CAPABILITIES)),
  chain_ids: z.array(z.string()),
  files: z.array(z.string()),
  unanalyzed_commands: z.number(),
  node_ids: z.array(z.string()),
});
export type ExecNode = z.infer<typeof ExecNodeSchema>;
export type ExecEdge = z.infer<typeof ExecEdgeSchema>;
export type Hook = z.infer<typeof HookSchema>;

interface HookSpec {
  name: string;
  dependents: boolean;
  trigger: string;
}
const NPM_HOOKS: HookSpec[] = [
  {
    name: 'preinstall',
    dependents: true,
    trigger: 'npm install (also when installed as a dependency)',
  },
  {
    name: 'install',
    dependents: true,
    trigger: 'npm install (also when installed as a dependency)',
  },
  {
    name: 'postinstall',
    dependents: true,
    trigger: 'npm install (also when installed as a dependency)',
  },
  {
    name: 'prepare',
    dependents: false,
    trigger: 'npm install in a clone of this repository, and when installed from git',
  },
  { name: 'preprepare', dependents: false, trigger: 'npm install in a clone of this repository' },
  { name: 'postprepare', dependents: false, trigger: 'npm install in a clone of this repository' },
  {
    name: 'prepublish',
    dependents: false,
    trigger: 'npm install in a clone (deprecated lifecycle)',
  },
];

/** Stable key linking a hook to a chain before global chain ids are assigned. */
export const chainKey = (file: string, kind: string, lines: number[]): string =>
  `${file}|${kind}|${lines.join(',')}`;

export interface ExecutionAnalysis {
  hooks: Hook[];
  nodes: ExecNode[];
  edges: ExecEdge[];
  truncated: boolean;
  /** Execution contexts per file, derived from graph reachability. */
  fileContexts: Map<string, Set<ExecContext>>;
  /** Scan results per path (hook scripts included as pseudo files). */
  scans: Map<string, FileScan>;
}

export interface ExecutionInput {
  manifests: ParsedManifest[];
  files: ScannedFile[];
  tree: ReadonlySet<string>;
}

const REMOTE_EXEC = /(?:^|[\s;&|(])(?:npx|npm\s+exec|pnpm\s+dlx|yarn\s+dlx|bunx)\s/;
const NPM_RUN = /^(?:npm|pnpm|yarn|bun)\s+(?:run-script\s+|run\s+)?([\w:.-]{1,100})(?:\s|$)/;
const SPLIT = /\s*(?:&&|\|\||;)\s*/;

export function analyzeExecution(input: ExecutionInput): ExecutionAnalysis {
  const nodes: ExecNode[] = [];
  const edges: ExecEdge[] = [];
  const hooks: Hook[] = [];
  const scans = new Map<string, FileScan>();
  const fileContexts = new Map<string, Set<ExecContext>>();
  const byPath = new Map(input.files.map((f) => [f.path, f]));
  let truncated = false;
  let seq = 0;

  const addNode = (n: Omit<ExecNode, 'id'>): string => {
    if (nodes.length >= LIMITS.maxGraphNodes) {
      truncated = true;
      return 'n-overflow';
    }
    const id = `n${++seq}`;
    nodes.push({ id, ...n });
    return id;
  };
  const addEdge = (e: ExecEdge): void => {
    if (e.from !== 'n-overflow' && e.to !== 'n-overflow') edges.push(e);
  };
  const scanOf = (f: ScannedFile): FileScan => {
    let s = scans.get(f.path);
    if (!s) {
      s = scanFile(f);
      scans.set(f.path, s);
    }
    return s;
  };
  const mark = (path: string, ctx: ExecContext): void => {
    const set = fileContexts.get(path) ?? new Set<ExecContext>();
    set.add(ctx);
    fileContexts.set(path, set);
  };

  /** Follow a file and the local files it references; returns visited paths. */
  function followFile(
    path: string,
    from: string,
    ctx: ExecContext,
    visited: Set<string>,
    depth: number,
  ): { unanalyzed: number } {
    let unanalyzed = 0;
    if (visited.has(path) || depth > LIMITS.maxScriptDepth) return { unanalyzed };
    visited.add(path);
    const f = byPath.get(path);
    const node = addNode({ kind: 'file', label: path, file: path, analyzed: !!f });
    addEdge({ from, to: node, relation: 'EXECUTES' });
    mark(path, ctx);
    if (!f) return { unanalyzed: 1 };
    scanOf(f);
    for (const ref of extractLocalRefs(f.content, path, input.tree)) {
      const r = followFile(ref, node, ctx, visited, depth + 1);
      unanalyzed += r.unanalyzed;
    }
    return { unanalyzed };
  }

  /** Resolve one npm script (and the scripts it calls) into nodes. */
  function walkNpmScript(
    m: ParsedManifest,
    scriptName: string,
    parent: string,
    ctx: ExecContext,
    visited: Set<string>,
    seen: Set<string>,
    depth: number,
    acc: { unanalyzed: number; commands: string[]; pseudo: string[] },
  ): void {
    const scripts = m.scripts ?? {};
    const body = scripts[scriptName];
    if (body === undefined || depth > LIMITS.maxScriptDepth || seen.has(scriptName)) return;
    seen.add(scriptName);
    const pseudoPath = `${m.file}#scripts.${scriptName}`;
    const pseudo: ScannedFile = {
      path: pseudoPath,
      content: body.replace(/\s*(?:&&|;)\s*/g, '\n'),
      size: body.length,
      role: 'script',
    };
    scanOf(pseudo);
    mark(pseudoPath, ctx);
    acc.pseudo.push(pseudoPath);
    const dir = m.file.includes('/') ? m.file.slice(0, m.file.lastIndexOf('/')) : '';
    for (const raw of body.split(SPLIT).slice(0, 20)) {
      const cmd = raw.trim();
      if (!cmd) continue;
      acc.commands.push(cmd);
      const nm = NPM_RUN.exec(cmd);
      const bare = cmd.split(/\s+/)[0] ?? '';
      if (
        nm &&
        (/^npm|pnpm|bun/.test(bare) ||
          (bare === 'yarn' && scripts[nm[1] as string] !== undefined)) &&
        scripts[nm[1] as string] !== undefined
      ) {
        const child = addNode({ kind: 'script', label: `npm run ${nm[1]}`, analyzed: true });
        addEdge({ from: parent, to: child, relation: 'RUNS' });
        walkNpmScript(m, nm[1] as string, child, ctx, visited, seen, depth + 1, acc);
        continue;
      }
      if (REMOTE_EXEC.test(` ${cmd}`)) {
        const n = addNode({ kind: 'command', label: sanitizeForTerminal(cmd, 80), analyzed: true });
        addEdge({ from: parent, to: n, relation: 'DOWNLOADS' });
        continue;
      }
      // Local files named by the command (node x.js, sh x.sh, ./x ...).
      const refs = extractLocalRefs(cmd, dir ? `${dir}/package.json` : 'package.json', input.tree);
      if (refs.length > 0) {
        for (const r of refs) {
          const res = followFile(r, parent, ctx, visited, depth + 1);
          acc.unanalyzed += res.unanalyzed;
        }
        continue;
      }
      const direct = /^(?:node|sh|bash|python3?)\s+(\S+)/.exec(cmd);
      if (direct && resolveRef(direct[1] as string, dir, input.tree) === undefined)
        acc.unanalyzed++;
      const n = addNode({ kind: 'command', label: sanitizeForTerminal(cmd, 80), analyzed: true });
      addEdge({ from: parent, to: n, relation: 'RUNS' });
    }
  }

  function finishHook(
    h: Omit<Hook, 'risk' | 'confidence' | 'capabilities' | 'chain_ids' | 'files' | 'analyzed'>,
    paths: string[],
    unanalyzed: number,
    anyAnalyzed: boolean,
  ): void {
    const caps = new Set<Capability>();
    let drivers = 0;
    let maxConf = 0;
    let risk: RiskLevel = 'none';
    const chainPaths: string[] = [];
    for (const p of paths) {
      const s = scans.get(p);
      if (!s) continue;
      for (const d of s.detections) {
        if (d.mode === 'POSSIBLE') continue;
        caps.add(d.capability);
        const r = CAPABILITY_RISK[d.capability];
        if (RISK_ORDER[r] >= 2) {
          drivers++;
          maxConf = Math.max(maxConf, d.confidence);
        }
        risk = maxRisk(
          risk,
          d.capability === 'ENVIRONMENT_READ' ||
            d.capability === 'FILESYSTEM_WRITE' ||
            d.capability === 'NETWORK_CLIENT'
            ? 'low'
            : r,
        );
      }
      for (const c of s.chains) {
        chainPaths.push(chainKey(p, c.kind, c.lines));
        // A directly observed pipe-to-shell is high; a multi-step inference needs strong confidence to be.
        risk = maxRisk(risk, c.mode === 'DIRECT' || c.confidence >= 0.7 ? 'high' : 'medium');
        maxConf = Math.max(maxConf, c.confidence);
        drivers++;
      }
    }
    if (paths.length > 0 && risk === 'none') risk = 'low';
    const analyzed = anyAnalyzed && unanalyzed === 0;
    const base = drivers > 0 ? maxConf : anyAnalyzed ? 0.8 : 0.2;
    const confidence = Math.max(0.1, Math.min(0.99, analyzed ? base : base * 0.6));
    hooks.push({
      ...h,
      risk: anyAnalyzed ? risk : 'low',
      confidence: Math.round(confidence * 100) / 100,
      analyzed,
      capabilities: [...caps].sort() as Capability[],
      chain_ids: chainPaths,
      files: paths.slice(0, 20),
      unanalyzed_commands: unanalyzed,
    });
  }

  // ---- npm lifecycle hooks -----------------------------------------------------------------
  for (const m of input.manifests.filter((x) => x.ecosystem === 'npm')) {
    const dir = m.file.includes('/') ? m.file.slice(0, m.file.lastIndexOf('/')) : '';
    const scripts = m.scripts ?? {};
    for (const spec of NPM_HOOKS) {
      if (scripts[spec.name] === undefined) continue;
      const ctx: ExecContext = 'install';
      const hookNode = addNode({
        kind: 'hook',
        label: `npm:${spec.name}${dir ? ` (${dir})` : ''}`,
        analyzed: true,
      });
      const acc = { unanalyzed: 0, commands: [] as string[], pseudo: [] as string[] };
      const visited = new Set<string>();
      walkNpmScript(m, spec.name, hookNode, ctx, visited, new Set(), 0, acc);
      const paths = [...visited, ...acc.pseudo];
      finishHook(
        {
          id: `HOOK-${hooks.length + 1}`,
          ecosystem: 'npm',
          name: spec.name,
          trigger: spec.trigger,
          // A private package is never published, so nobody installs it as a dependency.
          runs_for_dependents: spec.dependents && !m.isPrivate,
          context: 'install',
          script: sanitizeForTerminal(scripts[spec.name] as string, 200),
          unanalyzed_commands: 0,
          node_ids: [hookNode],
        },
        paths,
        acc.unanalyzed,
        true,
      );
    }
    if (
      input.tree.has(dir ? `${dir}/binding.gyp` : 'binding.gyp') &&
      scripts['install'] === undefined &&
      scripts['preinstall'] === undefined
    ) {
      const n = addNode({
        kind: 'implicit',
        label: 'npm:install (implicit node-gyp rebuild, binding.gyp present)',
        analyzed: true,
      });
      hooks.push({
        id: `HOOK-${hooks.length + 1}`,
        ecosystem: 'npm',
        name: 'install (implicit node-gyp)',
        trigger:
          'npm install: a native addon is compiled when binding.gyp exists and no install script is set',
        runs_for_dependents: true,
        context: 'install',
        risk: 'medium',
        confidence: 0.7,
        analyzed: true,
        capabilities: ['PROCESS_EXEC'],
        chain_ids: [],
        files: [],
        unanalyzed_commands: 0,
        node_ids: [n],
      });
    }
  }

  // ---- other ecosystems: root-level build/install files ------------------------------------
  const roots: {
    path: string;
    ecosystem: Hook['ecosystem'];
    name: string;
    trigger: string;
    dependents: boolean;
    ctx: Hook['context'];
  }[] = [];
  for (const f of input.files) {
    const base = f.path.slice(f.path.lastIndexOf('/') + 1);
    const depth = f.path.split('/').length - 1;
    if (depth > 1) continue;
    if (base === 'setup.py') {
      // pip only runs setup.py when the PEP 517 backend is setuptools (or none is declared).
      const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : '';
      const backend = input.manifests.find((x) => x.file === `${dir}pyproject.toml`)?.buildBackend;
      const runs = backend === undefined || /^setuptools(?:\.|:|$)/.test(backend);
      roots.push({
        path: f.path,
        ecosystem: 'pypi',
        name: 'setup.py',
        trigger: runs
          ? 'pip install of a source distribution or `pip install .` (runs setup.py)'
          : `legacy setup.py; the declared build backend (${sanitizeForTerminal(backend, 60)}) does not run it`,
        dependents: runs,
        ctx: runs ? 'install' : 'build',
      });
    } else if (base === 'build.rs')
      roots.push({
        path: f.path,
        ecosystem: 'cargo',
        name: 'build.rs',
        trigger: 'cargo build / cargo install (runs at compile time, also for dependents)',
        dependents: true,
        ctx: 'build',
      });
    else if (/^Dockerfile(?:\.[\w.-]+)?$/i.test(base))
      roots.push({
        path: f.path,
        ecosystem: 'docker',
        name: base,
        trigger: 'docker build',
        dependents: false,
        ctx: 'build',
      });
    else if (/^(?:GNUmakefile|Makefile|makefile)$/.test(base))
      roots.push({
        path: f.path,
        ecosystem: 'make',
        name: base,
        trigger: 'make (default target)',
        dependents: false,
        ctx: 'build',
      });
    else if (/^(?:install|setup|bootstrap)\.sh$/i.test(base) || base === 'configure')
      roots.push({
        path: f.path,
        ecosystem: 'shell',
        name: base,
        trigger: 'documented/manual install script',
        dependents: false,
        ctx: 'install',
      });
  }
  for (const r of roots) {
    const hookNode = addNode({ kind: 'hook', label: `${r.ecosystem}:${r.name}`, analyzed: true });
    const visited = new Set<string>();
    // Only hooks that run automatically for dependents count as "install" for the files they reach;
    // scripts a user starts by hand (install.sh, Makefile, Dockerfile) are "build" context.
    const res = followFile(r.path, hookNode, r.dependents ? 'install' : 'build', visited, 0);
    finishHook(
      {
        id: `HOOK-${hooks.length + 1}`,
        ecosystem: r.ecosystem,
        name: r.name,
        trigger: r.trigger,
        runs_for_dependents: r.dependents,
        context: r.ctx,
        unanalyzed_commands: 0,
        node_ids: [hookNode],
      },
      [...visited],
      res.unanalyzed,
      true,
    );
  }

  return { hooks, nodes, edges, truncated, fileContexts, scans };
}
