# Governance, timeline and temporal correlation

## Signals (`governance`)

From a small sample (latest 100 commits, 30 releases, top 100 contributors): dormancy gaps, new committers after a gap, releases soon after activity resumed, new release authors, release-cadence breaks, commit concentration. Roles are distinct (contributor, committer, release author; package publisher and organization owner are reserved). `takeover_indicators` is set when dormancy, a new account and a release follow each other: "supply-chain takeover risk indicators observed; intent undetermined".

## Unified timeline (`timeline`)

Every observation with a time is one event: id, type, timestamp (or null), subject, source (`git`, `github_release`, `registry`, `analysis_diff`), detail, confidence, evidence ids. Types: commit, dormancy_end, new_committer, release, new_release_author, tag, registry_publish, new_publisher, publisher_change, maintainer_change, ownership_change, dependency_change, install_hook_introduced, capability_introduced, external_domain_introduced, provenance_change, signature_change. The report states which types it could not produce (`not_available`: external domains and maintainer/ownership history today). An event without a timestamp can never be correlated: unknown time is not "close in time".

## Correlation (`src/events/correlate.ts`)

A pattern is DATA: ordered steps, each satisfied by any of several event types, within a window. The engine finds the tightest match per pattern with a hard search budget. Built-in patterns:

| Pattern | Steps | Window |
| ------- | ----- | ------ |
| `new-publisher-then-release` | new publisher/publisher change, then release/registry publish | 7 days |
| `dormancy-new-actor-release` | dormancy end, then a new committer/publisher/release author/maintainer, then a release | 45 days |
| `actor-change-then-install-hook` | an actor change or dormancy end, then a new install-time hook | 60 days |
| `release-with-new-capability-or-domain` | new capability/domain/hook, then a release | 14 days |

Every correlation carries the statement "pattern of events observed within the time window; supply-chain risk indicator only. Intent is undetermined." A legitimate maintainer hand-over produces the same pattern; nothing here says "hijacked".

In a revision diff the later revision's timeline is extended with `install_hook_introduced` and `capability_introduced` events stamped with that revision's commit date, so "new publisher, then a release, then a new postinstall" can be observed across a change. Release authors, contributor lists and registry maintainers are current-state, so they are not used to claim what the maintainers were at an old revision.

## Policy

`temporal_block` rules in a profile reference a built-in pattern id or carry a custom pattern; they fire only on a matched correlation (see [policy.md](policy.md)).

## Known false positives and negatives

False positives: legitimate hand-overs, bots and shared accounts, release-bot publishers, long-lived projects with seasonal activity. False negatives: anything outside the 100-commit window, attacks that keep a normal cadence, compromised accounts of existing publishers, and ownership changes (no history from registries).
