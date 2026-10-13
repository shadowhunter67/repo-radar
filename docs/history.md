# Historical comparison

`repo-radar` can explain what changed between two exact revisions of one repository, or between two saved reports.

```text
repo-radar diff owner/repo --from v1.2.0 --to v1.3.0 [--profile enterprise --enforce-profile] [--format json]
repo-radar diff old.json new.json
```

## Snapshot model

A snapshot is one analysis: repository, commit SHA, commit date (when known), tool version, schema version, methodology, rules digest, configuration digest and the report. A comparison always names both commits and prints their dates. In revision mode the two analyses run one after the other with the same options; files whose git blob SHA did not change are served from a within-run cache (`BlobCache`, keyed by repository and blob sha, bounded, never persisted). There is no database; the interfaces are plain report JSON so a store can be added later without changing the delta code.

## What is compared

| Section | Deltas |
| ------- | ------ |
| identity | primary artifact, packaging, roles, interfaces, deployment form, domain |
| dependencies | added, removed, version changed, became exact / unresolved, version source changed, new / resolved vulnerability, new git/path/URL dependency, new unpinned runtime dependency (dev/build/test tooling does not count) |
| capabilities | new, removed, risk changed, context changed (for example now also at install time) |
| execution | new / removed / changed hooks with the path (`npm postinstall -> scripts/install.js -> remote download -> piped into a shell`), flagged when they run for dependents |
| findings, policy, compliance indicators, SBOM, persistence | added / removed |
| governance | new signals, takeover indicators before and after, and a combined sequence when a new install-time hook coincides with takeover indicators |
| external domains (0.7) | introduced / removed / context changed, each `active` (install, build, CI, container, release, runtime) or `passive` (docs, tests, metadata, comments); only active changes become timeline events ([domains.md](domains.md)) |
| provenance, signatures, source binding (0.7) | provenance added/removed, verification changed (only when both analyses ran the verifier), source-binding class changed, signature state changed, registry <-> repository correspondence changed (never to or from `unknown`) |
| risk | per-dimension and overall score change (only when comparable) and a list of traceable reasons |

## Comparability and uncertainty

`comparability.level` is `comparable`, `reduced` or `not_directly_comparable`. Different methodologies or rule sets make scores not directly comparable: numeric score deltas are then `null` and the text says so, while the interpretable reasons (new hook, new vulnerability, ...) still hold. A different schema, tool version or configuration, or a repository tree that was read only partially, reduces comparability. A removal is `inconclusive` when either side's tree was incomplete or the scan covered under half of the source: something absent may simply be unread.

## Limits

- Release assets, contributors and branch protection reflect the repository's CURRENT state (GitHub does not expose them per revision); they are not compared across revisions. Commit-derived governance signals use the commit window ending at each revision.
- `setup.cfg` dependencies are not parsed, so a project that moved from `setup.cfg` to `pyproject.toml` shows its dependencies as added.
- Vulnerabilities come from OSV for the revision's exact versions as of the analysis time; advisory severity is not available, so rules cannot say "critical".
- A pinned ref must be a tag, branch or full commit; short SHAs are resolved by GitHub.

## Policy

`history_block` rules in a profile (see [methodology.md](methodology.md)) are evaluated on the delta. Only observed additions trigger them. With `--enforce-profile` a violation exits with code 2.

## History blocks added in 0.7

`new_install_time_domain` (an observed new or moved-to-install host that is not a registry or GitHub host), `provenance_verification_lost` (provenance removed, or verified -> not verified), `source_binding_conflict` (the correspondence became `source_binding_conflict`). None is enabled in a shipped profile. Release data is the repository's CURRENT state: two revisions analyzed in the same run share it, so provenance deltas are meaningful for two reports made at different times (`diff old.json new.json`), and a revision-to-revision diff says so in its caveats.
