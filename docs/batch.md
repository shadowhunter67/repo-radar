# Batch analysis

`repo-radar batch --list repos.txt [--org-summary]` processes at most 25 validated `owner/repo` entries sequentially. `--max-requests` and `--max-minutes` stop work with an explicit `stopped_by`; each repository failure is isolated. An optional `--snapshot-dir` reuses immutable local snapshots.

The summary contains repository analyzed/reused/failed/incomplete counts, policy failures, high/medium findings, temporal indicators, unverified provenance, dependency publisher changes, and install-context domains. It deliberately has no average or organization score. See [limitations](limitations.md) for snapshot-head semantics.
