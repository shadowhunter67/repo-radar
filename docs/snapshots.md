# Snapshot store and trust graph

## Snapshots (`src/store/snapshots.ts`)

```text
repo-radar analyze owner/repo --snapshot-dir ./snapshots [--snapshot-revision]
repo-radar diff owner/repo --from A --to B --snapshot-dir ./snapshots
repo-radar snapshots --snapshot-dir ./snapshots [--repo owner/repo]
```

A snapshot is a report keyed by repository + commit SHA + schema version + methodology + the first 16 hex of the configuration digest. The interface is `putSnapshot` / `getSnapshot` / `hasSnapshot` / `listSnapshots`; the only backend is the filesystem (a directory tree plus an append-only `index.jsonl`). There is no database.

- **Immutable**: the first report stored under a key is canonical and never overwritten. The same report again is `exists`. A different report under the same key (for example one made at another time, so current-state facts differ) is a `conflict`: nothing is stored or replaced and both hashes are reported. With `--snapshot-revision` it is stored as a content-addressed revision next to the canonical one.
- **Safe paths**: every key component is validated against a strict pattern before it becomes a path segment (no `.`/`..`, separators, leading dots), and the resolved directory must stay inside the store.
- **Hostile on read**: size cap (50 MiB), JSON parse, schema validation and a recomputed integrity digest; a modified file is reported, never returned. Index lines that fail validation are skipped.
- A report without a full commit SHA (not pinned and not resolvable) is rejected.
- `integrity.report_sha256` is a tamper-evidence digest over the deterministic JSON, not a digital signature.

## Trust graph (`src/graph/trust.ts`, `repo-radar graph report.json`)

A projection of a report (optionally a revision diff) onto nodes - Repository, Commit, Release, ReleaseAsset, Package, PackageVersion, Publisher, Maintainer, Actor, Dependency, Attestation, Signature, Capability, Finding - and edges - DEPENDS_ON, RELEASES, HAS_ASSET, BUILT_FROM, ATTESTED_BY, SIGNED_BY, SOURCED_FROM, RELEASED_BY, PUBLISHED_BY, MAINTAINED_BY, HAS_CAPABILITY, INTRODUCED_CAPABILITY, HAS_FINDING. Every edge has at least one evidence id (an edge without evidence is not created and is counted), a confidence, a temporal scope (`revision`, `current_state`, `publish_history`, `release_time`) and a source subsystem. Roles stay distinct nodes. There is no graph database and no inference; `ExternalDomain` nodes and `CONNECTS_TO` edges are reserved because domains are not extracted yet. The graph is derived data, bounded (3000 nodes, 9000 edges).
