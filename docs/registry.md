# Registry and publisher intelligence

`registry_intel` records what npm, PyPI and crates.io say about the packages THIS repository publishes (a manifest that is publishable, not an example/test/fuzz/xtask directory, with a valid registry name; at most 4 packages). Dependencies are not looked up here. The purpose is observable publisher/package history, not a reputation score.

## Package model

`ecosystem`/registry, name, the manifest that declares it, lookup status, `repository` (declared URL, normalized `owner/repo`, correspondence), latest version, up to 40 newest versions (publish time, version publisher where the registry exposes it, deprecated/yanked, integrity metadata present, provenance reported), maintainers and provenance summary.

| Registry | Version history | Per-version publisher | Maintainers/owners | Provenance |
| -------- | --------------- | --------------------- | ------------------ | ---------- |
| npm | yes (`time`) | yes (`_npmUser`) | yes, current | `dist.attestations` reported (NOT verified here) |
| PyPI | yes (upload times) | no | no (API does not expose) | not read |
| crates.io | yes | yes (`published_by`) | owners (separate request) | not read |

## Roles are never merged

A registry owner/maintainer, a version publisher, a GitHub contributor, a GitHub committer and a release author are different identities until evidence says otherwise (graph ids: `maintainer:npm:alice`, `publisher:npm:alice`, `actor:release_author:alice`).

## Temporal scope

Maintainers are `current_state`: the registry shows the set NOW and never the set at an old repository revision. Per-version publishers and publish times are `publish_history`. A signal says which one it is.

## Package <-> repository correspondence

`confirmed` (the registry's repository URL is the analyzed repository), `likely` (only the homepage points here, or same owner with a renamed repository), `conflicting` (another repository or a non-GitHub host), `missing` (no URL), `unknown` (the lookup failed). A name is never treated as proof of identity: for example the PyPI package `pydantic_core` currently names `pydantic/pydantic` as its source, so the analysis of `pydantic/pydantic-core` reports `conflicting` - an observation about metadata, not a verdict.

## Signals (no vulnerabilities, no intent)

`new_publisher` (a recent version published by an account new to the sampled history), `dormancy_then_publish` (a gap of a year or more that ended in the last two years), `cadence_change`, `repository_mismatch`, `provenance_missing` / `provenance_present` (npm, as reported), `integrity_missing`, `suspicious_publisher_name` (non-ASCII/control characters, shown with escapes), `duplicate_maintainer_identity`. They feed facts `registry.*` and the temporal timeline ([governance.md](governance.md)).

## Failure semantics

Timeout, 429, 5xx, a wrong content type, malformed JSON, an oversized body and a missing package each produce a lookup status and a diagnostic; the package's correspondence is `unknown` and no signal or fact claims anything. `registry.lookup_complete=false` withholds `registry.publisher_stable`. Requests go only to `registry.npmjs.org`, `pypi.org` and `crates.io`; redirects to any other host are refused; the GitHub token is never sent. Registry text is sanitized and length-capped before it enters a report. `--no-registry` skips the whole section.
