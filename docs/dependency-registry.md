# Dependency registry and publisher intelligence (0.7)

`registry_intel` ([registry.md](registry.md)) answers "who publishes what THIS repository ships". `dependency_registry_intel` answers "who publishes what this repository RELIES on": the classic path of a supply-chain compromise is a dependency whose publisher, maintainers or source repository changed, not the repository itself.

It is registry metadata only (`registry.npmjs.org`, `pypi.org`, `crates.io`, the same three hosts and the same client as `registry_intel`). Dependency tarballs are never downloaded or inspected, nothing is installed, and the GitHub token is never sent. `--no-dep-registry` skips it; `--no-registry` skips both registry sections.

## What is looked up, and in what order

Not every dependency: a repository can have thousands. Eligible packages (npm, PyPI, crates.io; registry-sourced, valid name; Go and Maven are `unsupported_ecosystem`, git/path/URL dependencies are `not_registry_source`) are ranked by a **deterministic, published priority model** and queried in that order until a budget runs out.

| Factor | Points |
| ------ | ------ |
| direct dependency | +40 (directness unknown +20) |
| runtime | +30 |
| build | +25 |
| unknown relationship | +15 |
| optional / peer | +10 |
| development | +4 |
| has a known advisory (OSV) | +35 |
| involved in a medium/high dependency finding | +20 |
| newly introduced (supplied by a diff caller) | +25 |
| install hook known (supplied by a caller) | +30 |
| unpinned (range/tag only) | +10 |
| ambiguous resolution | +10 |
| auxiliary manifest (examples/, docs/, tools/ ...) | -30 |

Ties break on registry then name. A package requested by several manifests is merged (best score, all dependency ids, all resolved versions) and fetched once (run-local cache keyed by registry and package). An npm alias (`npm:real@1`) is looked up under the real name. Each selected and each skipped dependency carries its score and the named factors that produced it.

## Budget (explicit, reported, never silent)

| Limit | Default | Flag |
| ----- | ------- | ---- |
| distinct packages queried | 25 | `--dep-registry-max` |
| registry HTTP requests (one per package; the crates.io owners request is skipped for dependencies, since owners are current state and never used for events) | 60 | `--dep-registry-requests` |
| elapsed time (injected clock) | 45 s | `--dep-registry-time` |
| versions kept per package (newest first) | 20 | - |
| total response bytes | 48 MiB | - |
| parallel lookups | 4 | - |

`coverage` states `eligible`, `queried`, `ok`, `failed`, `skipped` and `ratio` (and the same for direct dependencies). `skipped_counts` counts every skip by reason (`budget_dependencies`, `budget_requests`, `budget_time`, `budget_bytes`, `unsupported_ecosystem`, `not_registry_source`, `invalid_name`); `skipped` lists the highest-priority ones. A dependency that was not queried is **unknown**, never clean: `registry.deps.lookup_complete` is false and no "no change" fact is emitted for it.

## What is read per package

Publish time, version publisher (npm `_npmUser`, crates.io `published_by`), the maintainers recorded WITH each version (npm), the source repository each version declares (npm), whether a version declares an install-time script (npm `hasInstallScript` / `preinstall` / `install` / `postinstall`), whether it reports a provenance attestation (npm), integrity metadata, deprecation/yank flags, and the package-level repository, homepage and CURRENT maintainer set.

| Registry | Version history | Per-version publisher | Maintainers at publish time | Source repository per version | Install script | Provenance |
| -------- | --------------- | --------------------- | --------------------------- | ------------------------------ | -------------- | ---------- |
| npm | yes | yes | yes | yes | yes | reported (NOT verified) |
| PyPI | yes (upload times) | **no** (`publisher_history: unavailable`) | no | no | no | not read |
| crates.io | yes | yes | no (current owners only) | no | no | not read |

PyPI publisher identity is **not** inferred from the package author or maintainer metadata. The package's current `maintainers` are `current_state` and never become a dated event: only the per-version records are history.

## Events (`dependency_registry_intel.events`)

| Event | Observed when |
| ----- | ------------- |
| `dependency_publisher_changed` | a version was published by an account that published none of at least two earlier sampled versions (case-insensitive; a returning account is not an event) |
| `dependency_maintainer_changed` | the maintainers recorded with consecutive versions differ (npm; empty = not recorded) |
| `dependency_repository_changed` | a version declares a different source repository than the previous one (npm) |
| `dependency_dormancy_ended` | a version ended a gap of a year or more and is itself recent |
| `dependency_release_cadence_changed` | the newest gap is far above the earlier median, or three versions appear within three days after a slow history |
| `dependency_provenance_added` / `_removed` | consecutive versions differ in the provenance the registry reports (npm) |
| `dependency_install_hook_introduced` | a version declares an install-time script the previous version did not (npm) |

Every event has a timestamp (the publish time; a version without a plausible time - missing, in the future, before 1990 - produces no event and is counted), the package, the version, evidence ids, a confidence, `scope: publish_history`, `intent: undetermined`, and where it falls relative to the version the analyzed revision resolved:

- `relative_to_resolved` (`before` / `at` / `after` / `unknown`) and `days_from_resolved`. The resolved version's time is read from the registry's FULL history, so it is known even when the version is older than the sampled window.
- **Relevance.** An event at the resolved version, or up to 90 days before it, matters whatever its age (a project pinned to a version published right after a hand-over still depends on it). An event after it, or with no resolved version, matters while it is under two years old (the upgrade path). Older history stays in `events` but does not become a finding, a fact or a timeline event, so a 2016 publisher change cannot combine with another old event into a "takeover" pattern.

## Takeover indicators, not takeovers

Correlation patterns are data ([governance.md](governance.md)). With `same_entity: true` all steps must concern the SAME package, so a publisher change of one dependency never combines with an install script of another:

- `dependency-takeover-indicators`: a dormancy end, publisher change or maintainer change, then an install script, a different source repository or lost provenance, within 90 days.
- `dependency-dormancy-publisher-hook`: dormancy end, then a publisher/maintainer change, then an install script, within 120 days.
- `dependency-publisher-change-then-new-domain` (across entities, revision diff only): a dependency publisher/maintainer change, then the analyzed repository introduces an external domain, within 30 days.

The statement is always: "pattern of events observed within the time window; supply-chain risk indicator only. Intent is undetermined." A legitimate hand-over produces the same events.

## Package <-> repository correspondence for dependencies

There is no analyzed repository to point back to, so agreement between independent pointers is what counts. A package name is never proof.

| State | Meaning |
| ----- | ------- |
| `confirmed` | the registry names a GitHub repository, deps.dev lists the same one, and the homepage (or a reported provenance attestation) does not disagree. The back-link from the repository to the package is NOT checked: "the pointers agree". |
| `likely` | the registry names a repository and nothing contradicts it, but only one source (or one corroborating pointer) backs it; or the repository NAME is the same under another owner (an organisation rename or transfer shows up this way when two indexes refreshed at different times) |
| `conflicting` | the pointers disagree on the repository (registry vs deps.dev vs homepage) |
| `missing` | the registry lists no source |
| `unknown` | the lookup failed, or the source is not on GitHub (not compared) |

## Failure semantics

Timeout, 429, 5xx, malformed JSON, a wrong content type, an oversized body (`too_large`), a missing package, a redirect to another host and an exhausted budget are each a status; the package is `unknown`, its correspondence is `unknown`, no event is produced and the absence facts are withheld. A budget that runs out during a lookup makes that package a skip, not a failure.

## Facts, findings, policy

Facts `registry.deps.*` follow one rule: the PRESENCE of an event is evidence at any coverage, its ABSENCE (`false`) only when every eligible dependency was queried and answered ([facts.md](facts.md)). Findings (`RR-DEPREG-*`, category `registry`) are signals with severity `info`/`low`/`medium`, never vulnerabilities, each saying that intent is undetermined; an event after the resolved version is lowered to `low`. Policy keys `dependency_publisher_stability`, `dependency_registry_match`, `dependency_provenance_reported`, `no_dependency_takeover_indicators` ([policy.md](policy.md)) are NOT enabled in any shipped profile.

## Trust graph

Dependency packages become `Package`, `PackageVersion`, `Publisher`, `Maintainer`, `Registry` and `Repository` (source, not analyzed) nodes with `CORRESPONDS_TO`, `PUBLISHED_IN`, `RELEASES`, `PUBLISHED_BY`, `MAINTAINED_BY` and `SOURCED_FROM` edges, each backed by `depregistry:` evidence ids. Queries: `repo-radar graph report.json --query published-by:<account>` ([snapshots.md](snapshots.md)).

## Real probe (`calibration/results/dep-registry-probe.md`, 2026-10-13)

16 hand-picked real packages (10 npm, 3 PyPI, 3 crates.io), one resolved version each, through the analyzer's own collector: 19 registry requests, 11.4 MB, 2.5 s including deps.dev; every lookup `ok`. Observed, not tuned:

- `event-stream` (resolved 3.3.4): version 3.3.5 published 2018-09-05 by a new account that was added to the maintainers - the publisher-change and maintainer-change events - correctly `after` the resolved version.
- `ua-parser-js`, `express`, `sigstore`: `dependency_provenance_added` / `_removed` flips between release lines, as the registry reports them; `express` shows the maintainer churn of a project that changed hands.
- PyPI (`requests`, `urllib3`, `django`): no publisher or maintainer events are possible; the only event is a dormancy end.
- The first run (`dep-registry-probe-first-run.md`) found two bugs that were fixed afterwards: deps.dev project ids (`github.com/owner/repo`) were not normalized, so the second source never matched (everything was `likely`), and an organisation rename (`react/react` vs `facebook/react`) was a `conflicting` verdict instead of a note. After the fixes (`dep-registry-probe.md`): 8 of the 10 npm packages are `confirmed` (registry, deps.dev and homepage agree), `react` is `likely` with the rename note, `ua-parser-js` is `likely` (deps.dev had nothing for the resolved version), and every crates.io and PyPI package is `likely` (their registries expose no homepage here, so only two pointers exist).
- Relevance matters: 37 events were produced in total, but only the ones at, shortly before, or recently after the resolved version become findings, facts and timeline events. For example the 2016 publisher and repository changes of `left-pad` (resolved 1.3.0, published later) are history, while the `event-stream` 3.3.5 hand-over is an `after` event for a project pinned to 3.3.4 and `unknown` for one with no resolved version.
- `ua-parser-js` 0.7.29 (resolved) is no longer listed by npm, so its events are `unknown` relative to it: the registry cannot say where the removed version sat in time.

Known limits: the sample is the newest 20 versions; an attacker who publishes a new package name (typosquatting) is not a publisher change; no check that a repository back-links to the package; no verification of dependency attestations; maintainers of PyPI and owner history of any registry do not exist in the APIs.
