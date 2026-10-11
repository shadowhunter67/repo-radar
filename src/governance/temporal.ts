import { z } from 'zod';

/**
 * Temporal governance signals. They describe OBSERVABLE changes in who commits, who publishes releases and when, and never
 * rate people. Roles are kept apart because they are different facts: a contributor (appears in the contributor list), a
 * committer (authored commits in the sampled window), a release author (published a GitHub release) and, in future, a package
 * publisher or organization owner. "Maintainer changed" is never claimed.
 *
 * The inputs are small samples (the latest 100 commits, the latest 30 releases, the top 100 contributors), so every signal
 * carries the window it was computed from and a confidence that reflects it. A sequence of signals is reported as
 * "indicators observed; intent undetermined", never as an accusation.
 */
export const GovernanceInputSchema = z.object({
  /** Newest first. Logins are public GitHub handles; no e-mail addresses are kept. */
  commits: z.array(z.object({ date: z.string(), login: z.string().max(100).nullable() })).max(100),
  releases: z
    .array(
      z.object({
        tag: z.string().max(200),
        date: z.string(),
        author: z.string().max(100).nullable(),
      }),
    )
    .max(30),
  contributors: z
    .array(z.object({ login: z.string().max(100), contributions: z.number().int().min(0) }))
    .max(100),
});
export type GovernanceInput = z.infer<typeof GovernanceInputSchema>;

export const SIGNAL_KINDS = [
  'dormancy_gap',
  'release_after_dormancy',
  'new_committer_after_dormancy',
  'new_release_author',
  'release_author_not_committer',
  'release_cadence_change',
  'contributor_concentration',
] as const;
export const ROLES = [
  'contributor',
  'committer',
  'release_author',
  'package_publisher',
  'organization_owner',
] as const;

export const SignalSchema = z.object({
  id: z.string(),
  kind: z.enum(SIGNAL_KINDS),
  role: z.enum(ROLES),
  /** ISO date the signal is anchored at (when it happened), if known. */
  at: z.string().nullable(),
  detail: z.string().max(300),
  confidence: z.number().min(0).max(1),
  /** The window the signal was computed from, e.g. "latest 100 commits (2023-01-02..2026-09-30)". */
  window: z.string().max(200),
});
export type Signal = z.infer<typeof SignalSchema>;

export const GovernanceSchema = z.object({
  version: z.literal('1'),
  status: z.enum(['analyzed', 'insufficient_data', 'disabled']),
  window: z.object({
    commits: z.number().int().min(0),
    commit_span_days: z.number().min(0).nullable(),
    releases: z.number().int().min(0),
  }),
  signals: z.array(SignalSchema).max(30),
  /**
   * Set when dormancy, a new actor and a release follow each other closely. These are risk INDICATORS of a possible
   * takeover or hand-over; intent is undetermined and a legitimate maintainer change looks identical.
   */
  takeover_indicators: z
    .object({
      observed: z.boolean(),
      signal_ids: z.array(z.string()).max(10),
      statement: z.string().max(400),
    })
    .nullable(),
  limitations: z.array(z.string().max(200)).max(6),
});
export type Governance = z.infer<typeof GovernanceSchema>;

export const EMPTY_GOVERNANCE: Governance = {
  version: '1',
  status: 'disabled',
  window: { commits: 0, commit_span_days: null, releases: 0 },
  signals: [],
  takeover_indicators: null,
  limitations: [],
};

export const GOVERNANCE_THRESHOLDS = {
  /** A gap between two consecutive sampled commits at least this long is "dormancy". */
  dormancyDays: 180,
  /** A release this soon after the end of a dormancy counts as "sudden". */
  releaseWithinDays: 14,
  /** Two consecutive releases this far apart are a long release gap. */
  releaseGapDays: 365,
  /** A single committer above this share of the sampled commits is "concentrated". */
  concentration: 0.8,
  minCommits: 10,
} as const;

const DAY = 86_400_000;
const t = (s: string): number => Date.parse(s);
const ok = (s: string): boolean => Number.isFinite(t(s));
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function analyzeGovernance(input: GovernanceInput): Governance {
  const commits = input.commits.filter((c) => ok(c.date)).sort((a, b) => t(a.date) - t(b.date));
  const releases = input.releases.filter((r) => ok(r.date)).sort((a, b) => t(a.date) - t(b.date));
  const limitations = [
    'commits: only the latest 100 are sampled, so dormancy is only visible inside that window',
    'a release author is the account that published the release, not necessarily a maintainer or committer',
    'logins are GitHub accounts; shared or renamed accounts and bots are not distinguished',
  ];
  const span =
    commits.length > 1 ? (t(commits[commits.length - 1]!.date) - t(commits[0]!.date)) / DAY : null;
  const window = {
    commits: commits.length,
    commit_span_days: span === null ? null : Math.round(span),
    releases: releases.length,
  };
  if (commits.length < GOVERNANCE_THRESHOLDS.minCommits && releases.length < 2)
    return {
      version: '1',
      status: 'insufficient_data',
      window,
      signals: [],
      takeover_indicators: null,
      limitations,
    };

  const signals: Signal[] = [];
  let n = 0;
  const add = (s: Omit<Signal, 'id'>): string => {
    const id = `GOV-${String(++n).padStart(2, '0')}`;
    signals.push({ id, ...s });
    return id;
  };
  const cw =
    commits.length > 0
      ? `latest ${commits.length} commits (${day(t(commits[0]!.date))}..${day(t(commits[commits.length - 1]!.date))})`
      : 'no commits';
  const sampleConf = Math.min(0.8, 0.3 + commits.length / 250);

  // dormancy: the largest gap that is long enough, and who shows up after it
  let gapIdx = -1;
  let gapDays = 0;
  for (let i = 1; i < commits.length; i++) {
    const g = (t(commits[i]!.date) - t(commits[i - 1]!.date)) / DAY;
    if (g >= GOVERNANCE_THRESHOLDS.dormancyDays && g > gapDays) {
      gapDays = g;
      gapIdx = i;
    }
  }
  const ids: string[] = [];
  let dormancyEnd: number | null = null;
  if (gapIdx > 0) {
    dormancyEnd = t(commits[gapIdx]!.date);
    ids.push(
      add({
        kind: 'dormancy_gap',
        role: 'committer',
        at: day(dormancyEnd),
        detail: `no sampled commits for ${Math.round(gapDays)} days (${day(t(commits[gapIdx - 1]!.date))} to ${day(dormancyEnd)})`,
        confidence: sampleConf,
        window: cw,
      }),
    );
    const before = new Set(
      commits
        .slice(0, gapIdx)
        .map((c) => c.login)
        .filter((x): x is string => !!x),
    );
    const afterNew = [
      ...new Set(
        commits
          .slice(gapIdx)
          .map((c) => c.login)
          .filter((x): x is string => !!x && !before.has(x)),
      ),
    ];
    if (afterNew.length > 0)
      ids.push(
        add({
          kind: 'new_committer_after_dormancy',
          role: 'committer',
          at: day(dormancyEnd),
          detail: `${afterNew.length} account(s) commit after the gap that had not committed before it in the sample (${afterNew.slice(0, 3).join(', ')})`,
          confidence: Math.min(0.6, sampleConf),
          window: cw,
        }),
      );
    const firstRelAfter = releases.find(
      (r) =>
        t(r.date) >= dormancyEnd! &&
        (t(r.date) - dormancyEnd!) / DAY <= GOVERNANCE_THRESHOLDS.releaseWithinDays,
    );
    if (firstRelAfter)
      ids.push(
        add({
          kind: 'release_after_dormancy',
          role: 'release_author',
          at: day(t(firstRelAfter.date)),
          detail: `release ${firstRelAfter.tag} was published ${Math.round((t(firstRelAfter.date) - dormancyEnd) / DAY)} day(s) after commits resumed`,
          confidence: sampleConf,
          window: cw,
        }),
      );
  }

  // release authority
  const rw =
    releases.length > 0
      ? `latest ${releases.length} releases (${day(t(releases[0]!.date))}..${day(t(releases[releases.length - 1]!.date))})`
      : 'no releases';
  if (releases.length >= 3) {
    const last = releases[releases.length - 1]!;
    const earlier = new Set(
      releases
        .slice(0, -1)
        .map((r) => r.author)
        .filter((x): x is string => !!x),
    );
    if (last.author && earlier.size > 0 && !earlier.has(last.author))
      ids.push(
        add({
          kind: 'new_release_author',
          role: 'release_author',
          at: day(t(last.date)),
          detail: `the latest release ${last.tag} was published by an account that published none of the ${releases.length - 1} earlier releases in the sample`,
          confidence: Math.min(0.7, 0.3 + releases.length / 40),
          window: rw,
        }),
      );
    const prev = releases[releases.length - 2]!;
    const relGap = (t(last.date) - t(prev.date)) / DAY;
    if (relGap >= GOVERNANCE_THRESHOLDS.releaseGapDays)
      add({
        kind: 'release_cadence_change',
        role: 'release_author',
        at: day(t(last.date)),
        detail: `${Math.round(relGap)} days passed between the last two releases`,
        confidence: 0.6,
        window: rw,
      });
  }
  const committers = new Set(commits.map((c) => c.login).filter((x): x is string => !!x));
  const lastRel = releases[releases.length - 1];
  if (
    lastRel?.author &&
    commits.length >= GOVERNANCE_THRESHOLDS.minCommits &&
    !committers.has(lastRel.author)
  )
    add({
      kind: 'release_author_not_committer',
      role: 'release_author',
      at: day(t(lastRel.date)),
      detail: 'the latest release was published by an account with no commit in the sampled window',
      confidence: Math.min(0.5, sampleConf),
      window: `${cw}; ${rw}`,
    });

  // concentration (a descriptive fact, not a sequence member)
  if (commits.length >= GOVERNANCE_THRESHOLDS.minCommits) {
    const counts = new Map<string, number>();
    for (const c of commits) if (c.login) counts.set(c.login, (counts.get(c.login) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] / commits.length >= GOVERNANCE_THRESHOLDS.concentration)
      add({
        kind: 'contributor_concentration',
        role: 'committer',
        at: null,
        detail: `one account authored ${Math.round((100 * top[1]) / commits.length)}% of the sampled commits`,
        confidence: sampleConf,
        window: cw,
      });
  }

  // sequence: dormancy + (new actor) + a release soon after
  const hasDormancy = signals.some((s) => s.kind === 'dormancy_gap');
  const hasActor = signals.some(
    (s) => s.kind === 'new_committer_after_dormancy' || s.kind === 'new_release_author',
  );
  const hasRelease = signals.some((s) => s.kind === 'release_after_dormancy');
  const takeover =
    hasDormancy && hasRelease && hasActor
      ? {
          observed: true,
          signal_ids: signals
            .filter((s) =>
              [
                'dormancy_gap',
                'new_committer_after_dormancy',
                'new_release_author',
                'release_after_dormancy',
              ].includes(s.kind),
            )
            .map((s) => s.id),
          statement:
            'Supply-chain takeover risk indicators observed: a dormancy gap, a new committing or releasing account, and a release soon after activity resumed. Intent is undetermined; a legitimate hand-over looks the same.',
        }
      : {
          observed: false,
          signal_ids: [],
          statement:
            'No dormancy-then-new-actor-then-release sequence observed in the sampled window.',
        };
  void ids;
  return {
    version: '1',
    status: 'analyzed',
    window,
    signals,
    takeover_indicators: takeover,
    limitations,
  };
}
