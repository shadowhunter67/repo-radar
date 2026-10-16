# Snapshot store and trust graph

## Snapshots (`src/store/snapshots.ts`)

```text
repo-radar analyze owner/repo --snapshot-dir ./snapshots [--snapshot-revision]
repo-radar diff owner/repo --from A --to B --snapshot-dir ./snapshots
repo-radar snapshots --snapshot-dir ./snapshots [--repo owner/repo]
repo-radar snapshots --snapshot-dir ./a --export-to ./b      # or --import-from ./b
```

A snapshot is a report keyed by repository + commit SHA + schema version + methodology + the first 16 hex of the configuration digest. The interface is `putSnapshot` / `getSnapshot` / `hasSnapshot` / `listSnapshots`; the only backend is the filesystem (a directory tree plus an append-only `index.jsonl`). There is no database.

- **Immutable**: the first report stored under a key is canonical and never overwritten. The same report again is `exists`. A different report under the same key (for example one made at another time, so current-state facts differ) is a `conflict`: nothing is stored or replaced and both hashes are reported. With `--snapshot-revision` it is stored as a content-addressed revision next to the canonical one.
- **Safe paths**: every key component is validated against a strict pattern before it becomes a path segment (no `.`/`..`, separators, leading dots), and the resolved directory must stay inside the store.
- **Hostile on read**: size cap (50 MiB), JSON parse, schema validation and a recomputed integrity digest; a modified file is reported, never returned. Index lines that fail validation are skipped.
- A report without a full commit SHA (not pinned and not resolvable) is rejected.
- `integrity.report_sha256` is a tamper-evidence digest over the deterministic JSON (in the order the analyzer built it), not a digital signature. `getSnapshot` therefore returns the report exactly as stored, not a schema-parsed copy: a re-ordered copy no longer matches its own digest (found while building export/import, fixed with a test).
- **Export / import** (`copySnapshots`, `snapshots --export-to / --import-from`): every snapshot is read with its hash verified and written through the TARGET's immutability rules; a snapshot already present is `exists`, a different report under the same key is a `conflict` that is kept as it was. Any `SnapshotStore` implementation can be the source or the target, which is the seam for a future database or object store; the filesystem backend stays the only one.

## Trust graph (`src/graph/trust.ts`, `repo-radar graph report.json`)

A projection of a report (optionally a revision diff) onto nodes - Repository, Commit, Release, ReleaseAsset, Package, PackageVersion, Publisher, Maintainer, Actor, Dependency, Attestation, Signature, ExternalDomain, TrustRoot, Registry, Capability, Finding - and edges - DEPENDS_ON, RELEASES, HAS_ASSET, BUILT_FROM, ATTESTED_BY, SIGNED_BY, SOURCED_FROM, RELEASED_BY, PUBLISHED_BY, MAINTAINED_BY, CONNECTS_TO, VERIFIED_BY, USES_TRUST_ROOT, PUBLISHED_IN, CORRESPONDS_TO, HAS_CAPABILITY, INTRODUCED_CAPABILITY, HAS_FINDING. Every edge has at least one evidence id (an edge without evidence is not created and is counted), a confidence, a temporal scope (`revision`, `current_state`, `publish_history`, `release_time`) and a source subsystem. Roles stay distinct nodes. There is no graph database and no inference. The graph is derived data, bounded (3000 nodes, 9000 edges, 100 dependency packages, 300 domains), and **never stored**: it is a pure function of the report (plus a diff), so the graph of a stored snapshot is regenerated (`repo-radar graph --snapshot-dir D --repo owner/repo [--commit sha]`) and equals the graph of the original report (tested).

### 0.7 vocabulary

- `ExternalDomain` + `CONNECTS_TO`: "a file of the repository refers to this host" (never "connects"), evidence `domain:<host>` and `file:line`, confidence from the context. Edges derived from a revision diff carry `introduced_at` or `removed_at` set to the later revision's head COMMIT date; when that date is unknown the field is absent. The analysis time is never used as a commit time.
- `TrustRoot` + `VERIFIED_BY` / `USES_TRUST_ROOT`: a signature or attestation points at the root that checked it (`VERIFIED_BY` only when that check accepted it; repo-radar's own check is preferred over GitHub's assertion).
- `Registry` + `PUBLISHED_IN`, dependency `Package` + `CORRESPONDS_TO` (from the `Dependency` node), `PackageVersion` --`PUBLISHED_BY`--> `Publisher` (newest 3 sampled versions, dated `publish_history`), `MAINTAINED_BY` (`current_state`), `SOURCED_FROM` (the registry's declared repository, confidence by correspondence). `PackageVersion` nodes of dependencies carry `provenance_verified=false`: registries only report provenance.
- Edges have a temporal scope (`revision`, `current_state`, `publish_history`, `release_time`), an `at` and optionally `introduced_at` / `removed_at`. No evidence, no edge.

### Queries (`src/graph/query.ts`, `graph report.json --query <q>`)

Deterministic, sorted, each row with its evidence: `published-by:<account>` (dependencies with a sampled version published by that account, with dates), `publish-times:<account>`, `bound-to-commit:<sha>` (assets tied to a commit by the tag or by an attestation), `domains-after:<iso>[,<days>]` (only edges that HAVE an introduction time can answer), `without-verified-provenance` (every registry version, since none is verified here).
# Graph additions (0.9)

Graph projections include `DependencyArtifact`, `PackageNameSignal`, and `BuildSource` nodes plus evidence-bearing `HAS_ARTIFACT`, `FETCHES_FROM`, `SIMILAR_TO_PACKAGE`, and `DECLARED_BY` vocabulary. Queries include dependency publisher changes, unverified provenance, new install domains, name confusions, and artifact/source bindings.
