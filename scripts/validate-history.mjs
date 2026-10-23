// Real-repository validation of the dependency-history engine against git-derived ground truth.
// Network: GitHub API through the central HttpClient; the token comes from GITHUB_TOKEN and is never printed or stored.
// Usage: GITHUB_TOKEN=... node scripts/validate-history.mjs [--budget default|large] [--only owner/repo]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import process from 'node:process';
import { HttpClient } from '../dist/util/http.js';
import { traceManifestHistory } from '../dist/history/dependency.js';

const args = process.argv.slice(2);
const flag = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const mode = flag('--budget', 'default');
const only = flag('--only', null);
const rawPath = resolve('calibration/history-validation/ground-truth-raw.json');
const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
const budget =
  mode === 'large'
    ? {
        maxCommits: 1500,
        maxRequests: 4000,
        maxElapsedMs: 900_000,
        maxChangedFiles: 1500,
        maxBytes: 256 * 1024 * 1024,
      }
    : {};
const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error('GITHUB_TOKEN is required (use `gh auth token` transiently)');
const http = new HttpClient({
  allowedHosts: ['api.github.com'],
  authHosts: ['api.github.com'],
  token,
  retryDelayMs: 2000,
});

// truth event sequence restricted to presence transitions, as [type, commit]
const truthSeq = (d) => d.transitions.map((t) => `${t.type}:${t.commit}`);
const kindOf = (k) => (k === 'introduced_within_window' ? 'introduced' : k);
const obsSeq = (e) =>
  (e.events ?? [])
    .filter((x) =>
      ['introduced', 'introduced_within_window', 'removed', 'reintroduced'].includes(x.kind),
    )
    .map((x) => `${kindOf(x.kind)}:${x.commit_sha}`);

const rows = [];
const perRepo = [];
for (const r of raw.repos) {
  if (only && r.repo !== only) continue;
  const [owner, repo] = r.repo.split('/');
  const names = r.dependencies.map((d) => d.name);
  const t0 = Date.now();
  let traced;
  try {
    traced = await traceManifestHistory({
      http,
      owner,
      repo,
      ref: r.target_sha,
      path: r.manifest_path,
      names,
      budget,
    });
  } catch (e) {
    const rc = traced.stats.request_classes ?? {};
    if ((rc.rate_limited ?? 0) > 0 || (rc.server_error ?? 0) > 0 || (rc.network ?? 0) > 0) {
      // a scan with API failures is not an observation of the history: never counted, and a rate limit stops the whole run
      perRepo.push({
        repo: r.repo,
        invalid_observation: true,
        request_classes: rc,
        rate_limit_reset_at: traced.stats.rate_limit_reset_at ?? null,
      });
      process.stderr.write(
        `${r.repo}: INVALID (API failures ${JSON.stringify(rc)}); not counted\n`,
      );
      if ((rc.rate_limited ?? 0) > 0) break;
      continue;
    }
    perRepo.push({
      repo: r.repo,
      error: String(e?.message ?? e)
        .replace(token, '***')
        .slice(0, 200),
    });
    continue;
  }
  perRepo.push({
    repo: r.repo,
    kind: r.kind,
    ecosystem: r.ecosystem,
    commits_touching_path: r.commits_touching_path,
    ...traced.stats,
    wall_ms: Date.now() - t0,
  });
  for (const d of r.dependencies) {
    const e = traced.entries.find(
      (x) =>
        x.dependency_id === d.name ||
        x.dependency_id.endsWith(`:${d.name}`) ||
        x.dependency_id.includes(d.name),
    );
    const truthFirst = d.transitions.find((t) => t.type === 'introduced');
    const order = r.commit_order_oldest_first;
    const idx = (sha) => order.indexOf(sha);
    // presence of the dependency at the pinned commit `sha`, from the ground-truth transitions
    const presentAt = (sha) => {
      let present = false;
      for (const t of d.transitions) {
        if (idx(t.commit) <= idx(sha)) present = t.type !== 'removed';
      }
      return present;
    };
    const seqT = truthSeq(d);
    const seqO = e ? obsSeq(e) : [];
    const complete = e?.window?.complete === true && e.history_status === 'history_complete';
    const oldest = e?.window?.oldest_scanned_sha ?? null;
    // the window the engine actually scanned: truth restricted to it (a dependency already present at the window start shows as introduced at the window start)
    let windowTruth = seqT;
    if (!complete && oldest && idx(oldest) >= 0) {
      windowTruth = d.transitions
        .filter((t) => idx(t.commit) > idx(oldest))
        .map((t) => `${t.type}:${t.commit}`);
      if (presentAt(oldest)) windowTruth.unshift(`introduced:${oldest}`);
    }
    const obsFirst = e?.first_introduced_at?.commit_sha ?? e?.introduced_at?.commit_sha ?? null;
    let commit;
    if (!e || e.introduction !== 'known' || !obsFirst) commit = 'unknown';
    else if (complete) commit = obsFirst === truthFirst?.commit ? 'exact' : 'incorrect';
    else if (obsFirst === truthFirst?.commit) commit = 'correct_within_defined_window';
    else if (oldest && obsFirst === oldest && presentAt(oldest))
      commit = 'correct_within_defined_window';
    else commit = 'incorrect';
    let events;
    if (!e) events = 'unknown';
    else if (complete)
      events = JSON.stringify(seqO) === JSON.stringify(seqT) ? 'exact' : 'incorrect';
    else if (JSON.stringify(seqO) === JSON.stringify(windowTruth))
      events = 'correct_within_defined_window';
    else if (seqO.length === 0) events = 'unknown';
    else events = seqO.every((x) => windowTruth.includes(x)) ? 'partial' : 'incorrect';
    const manifest = e?.evidence_file
      ? e.evidence_file === r.manifest_path ||
        (r.renames ?? []).some((x) => x.to === e.evidence_file || x.from === e.evidence_file)
        ? 'correct'
        : 'incorrect'
      : 'unknown';
    const relationship = 'not_assessed_by_traceManifestHistory';
    rows.push({
      repo: r.repo,
      kind: r.kind,
      ecosystem: r.ecosystem,
      dependency: d.name,
      selection: d.selection,
      truth_events: d.transitions.length,
      truth_first: truthFirst?.commit ?? null,
      observed_first: obsFirst,
      observed_status: e?.history_status ?? 'missing',
      window_complete: e?.window?.complete ?? null,
      commits_scanned: e?.window?.commits_scanned ?? null,
      classification: {
        introduction_commit: commit,
        event_sequence: events,
        manifest,
        relationship,
      },
      truth_seq: seqT,
      window_truth_seq: windowTruth,
      observed_seq: seqO,
    });
  }
  process.stderr.write(
    `${r.repo}: ${traced.stats.requests} requests, ${traced.stats.commits_scanned} commits, ${Date.now() - t0} ms\n`,
  );
}
const tally = (key) =>
  rows.reduce((a, x) => ((a[x.classification[key]] = (a[x.classification[key]] ?? 0) + 1), a), {});
const result = {
  result_kind: 'history-validation',
  engine: 'traceManifestHistory',
  budget_mode: mode,
  generated_at: new Date().toISOString(),
  ground_truth_sha256: createHash('sha256').update(readFileSync(rawPath)).digest('hex'),
  ground_truth_note: raw.built_with,
  summary: {
    cases_total: rows.length,
    introduction_commit: tally('introduction_commit'),
    event_sequence: tally('event_sequence'),
    manifest: tally('manifest'),
    relationship: tally('relationship'),
    budget_exhausted_repos: perRepo.filter((p) => p.budget_exhausted).length,
  },
  per_repo_cost: perRepo,
  cases: rows,
};
mkdirSync('calibration/history-validation/results', { recursive: true });
const out = `calibration/history-validation/results/validation-${mode}-${new Date().toISOString().slice(0, 10)}.json`;
writeFileSync(out, JSON.stringify(result, null, 1) + '\n');
process.stdout.write(`${JSON.stringify(result.summary, null, 1)}\n`);
