import { parse as parseYaml } from 'yaml';

export interface WorkflowFacts {
  parsed: boolean;
  externalActions: number;
  pinnedActions: number;
  /** Top-level `permissions:` or every job declares its own. */
  hasPermissions: boolean;
  pullRequestTarget: boolean;
  /** pull_request_target + checkout of the PR head: the classic "pwn request" shape. */
  dangerousCheckout: boolean;
  /** `${{ github.event.<untrusted> }}` interpolated directly inside a `run:` script. */
  expressionInjection: boolean;
  runsTests: boolean;
  usesSast: boolean;
  usesProvenance: boolean;
}

const TEST_CMD =
  /\b(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?(?:test|unit|spec|e2e|integration|ci|check)[\w:-]*|\bnpx?\s+(?:vitest|jest|mocha|ava|tap|c8)\b|\bnode\s+--test\b|\bdeno\s+test\b|\bpytest\b|\bpython3?\s+-m\s+(?:pytest|unittest)\b|\bgo\s+test\b|\bcargo\s+(?:test|nextest)\b|\bmvnw?\b[^\n]{0,200}?\btest\b|\bgradlew?\b[^\n]{0,200}?\btest\b|\bctest\b|\bmake\s+(?:test|check)\b|\bdotnet\s+test\b|\brspec\b|\bphpunit\b|\btox\b/;

const RUN_SCAN_LIMIT = 20_000;

const INJECTION =
  /\$\{\{\s*(?:github\.event\.(?:issue|pull_request|comment|review|review_comment|discussion|head_commit|commits|pages|release)\.[a-z_.[\]*]{0,60}?(?:title|body|name|email|label|ref|message|page_name)|github\.head_ref)\s*\}\}/i;

const SHA_PIN = /@[0-9a-f]{40}$/i;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function analyzeWorkflow(text: string): WorkflowFacts {
  const facts: WorkflowFacts = {
    parsed: false,
    externalActions: 0,
    pinnedActions: 0,
    hasPermissions: false,
    pullRequestTarget: false,
    dangerousCheckout: false,
    expressionInjection: false,
    runsTests: false,
    usesSast: false,
    usesProvenance: false,
  };
  let doc: unknown;
  try {
    // Core schema: no custom tags; alias cap blocks "billion laughs" style expansion.
    doc = parseYaml(text, { schema: 'core', maxAliasCount: 50, strict: false });
  } catch {
    return facts;
  }
  if (!isObj(doc)) return facts;
  facts.parsed = true;

  const on = doc['on'] ?? doc['true'];
  const triggers: string[] =
    typeof on === 'string'
      ? [on]
      : Array.isArray(on)
        ? on.map(String)
        : isObj(on)
          ? Object.keys(on)
          : [];
  facts.pullRequestTarget = triggers.includes('pull_request_target');

  const jobs = isObj(doc['jobs']) ? Object.values(doc['jobs']).filter(isObj) : [];
  // `write-all` is a declaration, but not a least-privilege one.
  const declared = (p: unknown): boolean => p !== undefined && p !== 'write-all';
  facts.hasPermissions =
    declared(doc['permissions']) ||
    (jobs.length > 0 && jobs.every((j) => declared(j['permissions'])));

  for (const job of jobs.slice(0, 200)) {
    const steps = Array.isArray(job['steps']) ? job['steps'].filter(isObj).slice(0, 500) : [];
    const jobUses = typeof job['uses'] === 'string' ? [job['uses']] : [];
    for (const u of jobUses) countUses(u, facts);
    for (const step of steps) {
      const uses = typeof step['uses'] === 'string' ? step['uses'] : undefined;
      if (uses) {
        countUses(uses, facts);
        if (/^github\/codeql-action\//i.test(uses) || /^(?:returntocorp|semgrep)\//i.test(uses)) {
          facts.usesSast = true;
        }
        if (
          /^slsa-framework\/slsa-github-generator/i.test(uses) ||
          /^actions\/attest/i.test(uses)
        ) {
          facts.usesProvenance = true;
        }
        if (facts.pullRequestTarget && /^actions\/checkout@/i.test(uses) && isObj(step['with'])) {
          // Either the ref or the repository can point at attacker-controlled PR code.
          const target = `${String(step['with']['ref'] ?? '')} ${String(step['with']['repository'] ?? '')}`;
          if (/head|pull_request|refs\/pull\/|github\.event\.pull_request/i.test(target))
            facts.dangerousCheckout = true;
        }
      }
      const run = typeof step['run'] === 'string' ? step['run'] : undefined;
      if (run) {
        // Hostile workflows can carry huge single-line scripts: bound both the scan window and the
        // regex look-ahead so matching stays linear (see tests/unit/regressions.test.ts).
        const script = run.slice(0, RUN_SCAN_LIMIT);
        if (TEST_CMD.test(script)) facts.runsTests = true;
        if (INJECTION.test(script)) facts.expressionInjection = true;
      }
    }
  }
  return facts;
}

function countUses(uses: string, facts: WorkflowFacts): void {
  if (uses.startsWith('./')) return; // local action: reviewed in the same repo
  facts.externalActions++;
  if (uses.startsWith('docker://') ? /@sha256:[0-9a-f]{64}$/i.test(uses) : SHA_PIN.test(uses)) {
    facts.pinnedActions++;
  }
}
