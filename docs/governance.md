# Governance, timeline and temporal correlation

## Signals (`governance`)

From a small sample (latest 100 commits, 30 releases, top 100 contributors): dormancy gaps, new committers after a gap, releases soon after activity resumed, new release authors, release-cadence breaks, commit concentration. Roles are distinct (contributor, committer, release author; package publisher and organization owner are reserved). `takeover_indicators` is set when dormancy, a new account and a release follow each other: "supply-chain takeover risk indicators observed; intent undetermined".

## Unified timeline (`timeline`)

Every observation with a time is one event: id, type, timestamp (or null), subject, source (`git`, `github_release`, `registry`, `dependency_registry`, `analysis_diff`), detail, confidence, evidence ids. Types: commit, dormancy_end, new_committer, release, new_release_author, tag, registry_publish, new_publisher, publisher_change, maintainer_change, ownership_change, dependency_change, install_hook_introduced, capability_introduced, external_domain_introduced, provenance_change, signature_change; since 0.7 also `dependency_publisher_changed`, `dependency_maintainer_changed`, `dependency_repository_changed`, `dependency_dormancy_ended`, `dependency_release_cadence_changed`, `dependency_provenance_added`, `dependency_provenance_removed`, `dependency_install_hook_introduced`, `external_domain_removed`, `external_domain_context_changed`, `provenance_added`, `provenance_removed`, `provenance_verification_changed`, `source_binding_changed`, `signature_state_changed`, `registry_repository_correspondence_changed`. The report states which types it could not produce (`not_available`). Every event has a timestamp or is never correlated; an optional `entity` (`npm:left-pad`, absent = the repository) says what it is about. An event without a timestamp can never be correlated: unknown time is not "close in time".

## Correlation (`src/events/correlate.ts`)

A pattern is DATA: ordered steps, each satisfied by any of several event types, within a window. The engine finds the tightest match per pattern with a hard search budget. Built-in patterns:

| Pattern | Steps | Window |
| ------- | ----- | ------ |
| `new-publisher-then-release` | new publisher/publisher change, then release/registry publish | 7 days |
| `dormancy-new-actor-release` | dormancy end, then a new committer/publisher/release author/maintainer, then a release | 45 days |
| `actor-change-then-install-hook` | an actor change or dormancy end, then a new install-time hook | 60 days |
| `release-with-new-capability-or-domain` | new capability/domain/hook, then a release | 14 days |
| `dependency-takeover-indicators` (same dependency) | dormancy end / publisher change / maintainer change, then a new install script, a different source repository or lost provenance | 90 days |
| `dependency-dormancy-publisher-hook` (same dependency) | dormancy end, then a publisher/maintainer change, then a new install script | 120 days |
| `dependency-publisher-change-then-new-domain` | a dependency publisher/maintainer change, then a new external domain in the analyzed repository (revision diff) | 30 days |
| `provenance-loss-then-release` | provenance removed, verification or source binding changed, then a release | 14 days |

Every correlation carries the statement "pattern of events observed within the time window; supply-chain risk indicator only. Intent is undetermined." A legitimate maintainer hand-over produces the same pattern; nothing here says "hijacked".

In a revision diff the later revision's timeline is extended with `install_hook_introduced` and `capability_introduced` events stamped with that revision's commit date, so "new publisher, then a release, then a new postinstall" can be observed across a change. Release authors, contributor lists and registry maintainers are current-state, so they are not used to claim what the maintainers were at an old revision.

## Policy

`temporal_block` rules in a profile reference a built-in pattern id or carry a custom pattern; they fire only on a matched correlation (see [policy.md](policy.md)).

## Known false positives and negatives

False positives: legitimate hand-overs, bots and shared accounts, release-bot publishers, long-lived projects with seasonal activity. False negatives: anything outside the 100-commit window, attacks that keep a normal cadence, compromised accounts of existing publishers, and ownership changes (no history from registries).

## Entities and relevance (0.7)

A pattern with `same_entity: true` only matches events that share an `entity`: a publisher change of one dependency never combines with an install script of another. Events at the SAME instant may satisfy consecutive steps in any order. Dependency events enter the timeline only when they are relevant to the analyzed revision (at or shortly before the resolved version, or recent after it; see [dependency-registry.md](dependency-registry.md)), so a years-old hand-over cannot form a "takeover" correlation by itself. The full list stays in `dependency_registry_intel.events`.

## Takeover indicators for dependencies

"Dependency supply-chain takeover indicators observed; intent undetermined": a finding (`medium`, confidence 0.5) and the fact `registry.deps.takeover_indicators` appear only for a correlated pattern on ONE dependency. Known false positives: a legitimate hand-over with a first release that adds a build step; a project that moves its repository and republishes. Known false negatives: a compromised account of an EXISTING publisher (no publisher change), a malicious dependency of a dependency that was not queried (budget), PyPI (no publisher history), and anything that does not touch the sampled 20 versions.

## Provenance, signature and correspondence events

In a revision diff or a comparison of saved reports ([history.md](history.md)): `provenance_added` / `provenance_removed`, `provenance_verification_changed` (only when both analyses ran the verifier), `source_binding_changed`, `signature_state_changed`, `registry_repository_correspondence_changed` (never to or from `unknown`). They carry the release's publication time when they attach to a release, otherwise the later analysis time marked `observed`; a change with no usable time is listed in the diff but is not a timeline event.
# Dependency temporal indicators (0.9)

Dependency publisher/provenance/domain and artifact-hook sequences are dated observations tied to the same registry entity where required. Correlations state that intent is undetermined and do not establish maliciousness.
