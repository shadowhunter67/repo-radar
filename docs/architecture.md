# Architecture

repo-radar is a **stateless, read-only** pipeline. Nothing from an analyzed repository is ever executed.

```text
                 +--------------------------- untrusted input ----------------------------+
                 |  GitHub API / raw files     OpenSSF Scorecard API        OSV API         |
                 +-----------+-------------------------+-------------------------+---------+
                             v                         v                         v
 Collectors      src/collectors/github/*        src/collectors/scorecard.ts   src/deps/vulns.ts
                 (tree, workflows, README, manifests)   (host-allowlisted, size-capped HttpClient)
                             |  Evidence[] + Diagnostics[]  (+ RepoSnapshot for identity)
                             v
 Evidence        src/evidence  : zod schema, id-addressed EvidenceStore, EvidenceBuilder
                             |
                             v
 Identity        src/identity  : normalizeName -> IdentityClassifier (heuristic default) -> identity.* evidence
                             |
                             v
 Rules           standards/<dimension>/rules.yaml  (validated by src/scoring/rules.ts, digest recorded)
                             |
                             v
 Scoring         src/scoring/engine.ts : per-rule results -> dimension score / coverage / confidence / range -> overall
                             |      profiles/*.yaml : dimension + rule weights, advisory minimums
                             v
 Policy          src/scoring/policy.ts : minimums -> violations (exit code 2 only when enforced)
                             |
                             v
 Report          src/report : canonical JSON (zod schema) and a text rendering of the same object
                             |
                             v
 Interfaces      src/cli.ts (CLI)   action.yml (GitHub Action: bundled single file)
```

## Architecture in 0.2: facts and static code analysis

```text
Collectors (GitHub, Scorecard, OSV)        text files from the git tree (bounded, never executed)
        |                                          |
        v                                          v
Raw evidence --------------+            src/analysis: detectors, chains, execution graph, persistence, secrets
        |                  |                       |
        v                  +-----------+-----------+
Semantic identity                      v
 (artifact, domain, alternatives)  Normalized facts (src/facts)  <- derived_from ids resolve to evidence / detections
        |                              |
        +--------------+---------------+
                       v
                 Rules (YAML) -> dimension scores / coverage / confidence -> profile -> policy
                       |
                       v
         Report: evidence, facts, code_analysis, findings, integrity digest
```

Status against the target architecture (collectors -> raw evidence -> normalized facts -> repository model -> identity /
capabilities / dependency graph / execution graph -> applicability engine -> rule packs -> findings -> scores -> policies -> reports):

| Target component | State in 0.2 |
| ---------------- | ------------ |
| Normalized facts | Implemented (`src/facts`), used by 2 migrated rules and all 7 new rules; the other rules migrate incrementally |
| Repository model | Not built as a separate model. Pieces exist: `RepoSnapshot`, parsed manifests, `ScannedFile`, the execution graph (nodes and edges). A unified entity/relationship model is future work |
| Identity layers | Artifact type, domain, alternatives, capabilities and a deterministic purpose sentence (heuristic) |
| Capabilities | 14 capabilities, line-oriented detectors, contexts (install, build, runtime), persistence kinds, secret candidates |
| Execution graph | npm lifecycle traced in depth; other ecosystems list build roots; compound download-and-execute chains |
| Dependency model | Built in 0.3 (`src/deps`): normalized packages, lockfile resolution, OSV on exact versions, optional deps.dev, SBOM ingest/compare ([dependencies.md](dependencies.md)). No transitive resolution without a lockfile; no Maven/Gradle yet. |
| Applicability engine | Minimal: `applies_when` conditions on rules. Artifact-type-driven applicability (library vs service) is planned |
| Rule packs | One YAML pack per dimension, loaded by directory; versioned by digest. Versioned third-party standard packs (`slsa@x`, `nist-ssdf@x`) are planned |
| Dynamic analysis / sandbox | Not built, deliberately: see the isolation requirements in [roadmap.md](roadmap.md) |

## Module map

Build-system parser coverage is intentionally explicit: npm uses semantic parsing; Bazel, Nix, and Buck are structural parsers. `flake.lock` structured nodes outrank `flake.nix` expressions; Nix interpolation, imports, and computed URLs remain unresolved rather than being presented as parsed dependencies.

| Build system | Current support | Dynamic expressions |
| --- | --- | --- |
| npm | semantic | evaluated only through manifest/lockfile data |
| Bazel | structural | macros/Starlark remain unresolved |
| Nix | structural | interpolation/imports/computed URLs remain unresolved |
| Buck | structural | macros remain unresolved |

| Path                          | Responsibility                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/util/http.ts`            | The only network code: https-only, host allowlist, manual redirect checks, size caps, timeouts, token scoping |
| `src/util/repo-ref.ts`        | Parses `owner/repo` / github.com URLs; rejects everything else before any request                       |
| `src/util/text.ts`            | Terminal sanitization, secret redaction, small numeric helpers                                          |
| `src/collectors/github/`      | Tree/file classification, workflow analysis (YAML), README analysis, the GitHub collector               |
| `src/collectors/manifests/`   | Static parsers: package.json, pyproject.toml, requirements.txt, go.mod, Cargo.toml, lockfiles          |
| `src/identity/`               | Name normalization, taxonomy loader, `IdentityClassifier` interface, heuristic classifier              |
| `src/scoring/`                | Rule/profile schemas, rule loader (+digest), engine, grading, policy                                     |
| `src/profiles/`               | Profile loader and validation against the rule set                                                      |
| `src/report/`                 | Report schema (zod -> JSON Schema), text renderer                                                       |
| `src/analysis/`               | Static capability / execution / persistence / secret analysis over fetched text; findings                |
| `src/facts/`                  | Normalized fact schema and derivation                                                                    |
| `src/limits.ts`               | Every resource limit in one place                                                                        |
| `src/analyze.ts`              | Orchestration: collectors -> identity -> code analysis -> facts -> scoring -> report                     |
| `standards/`                  | Rules and the identity taxonomy as data                                                                 |
| `schemas/`                    | Generated JSON Schemas (kept in sync by a test)                                                         |

## Key decisions

1. **TypeScript on Node >= 20.** The build environment had no Go toolchain; TypeScript gives typed schemas (zod, which also generates
   the published JSON Schemas), quick iteration, built-in `fetch`, and a simple GitHub Action story. Runtime dependencies: `zod`,
   `yaml`, `smol-toml`. A Go rewrite for a single static binary remains possible because the contract is the JSON schema, not the code.
2. **Missing evidence is not negative evidence.** An unobserved rule is excluded from the score and lowers *confidence*.
3. **Score, coverage, confidence and range are separate outputs** ([methodology](methodology.md)).
4. **Rules are data.** The engine contains no thresholds. Every rule names its evidence ids, so every score traces to evidence.
5. **Correlated signals share a weight budget** (`group`), and each fact is scored in one dimension.
6. **Heuristics are labelled** (`kind: heuristic`, lower source reliability) and never worded as verdicts.
7. **Identity is pluggable**, needs no API key, and influences scoring through one rule only.
8. **Stateless.** No database or cache in v0.1 (see [roadmap](roadmap.md)).
9. **Fail soft on optional data, fail hard on the subject.** A missing repository or a rate-limited primary request is an error
   (exit 3/4); anything else degrades into diagnostics and lower confidence.
10. **One report object.** The text output is a rendering of the JSON report, so they cannot disagree.

## Extension points

- New evidence: add it in a collector, document the id in [evidence-schema.md](evidence-schema.md), reference it from a rule.
- New rule/profile/taxonomy entry: edit YAML; see [standards-authoring.md](standards-authoring.md).
- New classifier: implement `IdentityClassifier` (`classify(snapshot) -> SemanticIdentity`) and pass it to `analyzeRepository({ classifier })`.
- New source (for example deps.dev): a collector returning `{ evidence, diagnostics }` with a host allowlist entry; the engine does not change.

## Trust boundary

All repository content (names, README, manifests, workflow YAML, tree paths) and all API responses are untrusted. See [security-model.md](security-model.md).

## 0.4: execution model, repository model, history and policy

- **Execution model** (`src/analysis/exec-model.ts`, `exec-api.ts`): language modules (`python.ts`, `jvm.ts`, the npm/cargo code in `execution.ts`) emit hooks/edges with a stage, a trigger and an environment; shared code recomputes risk (`addHookCapabilities`).
- **Evidence conflicts** (`src/evidence/conflict.ts`): one model for disagreement between lockfile, SBOM, manifest and registry data, with explicit precedence.
- **Repository model** (`src/model`): a graph projection of a report (Repository, Manifest, Package, Script, ExecutionNode, Capability, File, Finding, plus Release and Maintainer placeholders). It is derived data, bounded (5000 entities, 15000 relationships), and is the intended input for later historical, release/binary and governance analysis.
- **Historical readiness**: `repo-radar diff` compares two saved reports by stable keys and states caveats when schema, methodology or rules differ. Current registry state is not historical truth; commit-by-commit history analysis is future work.
- **Release/binary and governance readiness**: model entities exist as placeholders; no binary or release-asset analysis is performed yet.
- **Policy**: profile `block:` rules reuse the compliance condition language and are evaluated in `src/scoring/policy.ts`.
- **Compliance**: `src/compliance` (applicability engine, packs, indicators) is separate from scoring.


## 0.5: retrieval, history, release and governance

- **Retrieval** (`src/collectors/github/retrieval.ts`): one recursive tree request first; if it is truncated or too large a budgeted breadth-first walk (a `TreeFetcher` abstraction, so tests need no network) lists priority directories. The report carries `retrieval` (method, completeness, requests, nodes, bytes, listed and unread directories, `stopped_by`) and a `coverage_map` per evidence class.
- **History** (`src/history`): `compareSnapshots(reportA, reportB)` is a pure function over two report JSONs; `compareRevisions` runs two sequential analyses with a shared `BlobCache`. Storage readiness: snapshots are plain report JSON with a stable key (repository, commit, tool/schema/methodology/rules/config digests), so a store can index them later.
- **Release and provenance** (`src/release`, `src/collectors/github/releases.ts`): the model, checksum parser, in-toto parser, archive inspector and correspondence logic are pure and tested offline; only the collector performs requests.
- **Governance** (`src/governance/temporal.ts`): a pure function over small samples of commits, releases and contributors.
- **Trust-graph readiness**: repository model 0.2 has Release, ReleaseAsset, ArtifactDigest, Signature, ProvenanceRecord, Commit and Maintainer entities and RELEASES, TAGGED_AT, HAS_DIGEST, SIGNS, ATTESTS, BUILT_FROM, RELEASED relations. `PUBLISHED_BY` (package to registry publisher) is reserved: no registry publisher data is collected yet.
- **Policy** (`src/scoring/policy.ts`): `effectiveBlocks` (blocks plus compiled `require:`), `evaluateBlocks`, `evaluateHistoryBlocks`. Organization-level configuration can later supply the same objects.


## 0.6: identity, retrieval, registry, trust, timeline, store, graph

- `src/identity/signals.ts` + `v2.ts`: strong/weak structural evidence, status clear/ambiguous/unknown.
- `src/collectors/github/retrieval.ts` + `hints.ts`: multi-pass walk with structural hints and wide-directory handling; `src/collectors/github/blobcache.ts`: run-local reuse of file contents and parses by blob SHA.
- `src/registry` (model, parsers, signals, findings) + `src/collectors/registry.ts`: registry intelligence.
- `src/trust` (vocabulary, Sigstore wrapper), `src/release/binding.ts` (source binding, SLSA observations), `verify-assets.ts`, `binmeta.ts`: cryptographic and bounded checks.
- `src/events` (model, builder, correlation): unified timeline; `src/store/snapshots.ts`: immutable snapshots; `src/graph/trust.ts`: Software Trust Graph projection.
- Policy: `require` keys, `history_block`, `temporal_block` in `src/scoring/policy.ts`.

All new subsystems are pure functions over collected data with the network confined to collectors; the only network access outside `src/util/http.ts` is the Sigstore TUF client under `--verify-crypto`.

## 0.7: dependency registry, trust roots, domains, retrieval v3

- `src/registry/dependency-*.ts` + `src/collectors/dependency-registry.ts`: priority model, budget, events, correspondence, findings and facts for dependencies; the per-package parser and fetcher are shared with `registry_intel` (`parse.ts`, `collectors/registry.ts`).
- `src/trust/` (`config.ts` the only place a key becomes trusted, `sigstore.ts` with blob bundles and limits, `gpg.ts`, `minisign.ts`), `src/release/verify-signatures.ts`: detached signature verification; `src/util/snappy.ts`: bounded Snappy for GitHub's large attestation bundles.
- `src/domains/` (model, extract, findings, diff): external hostnames by context; `src/history/delta.ts` gains `domains[]` and `provenance[]`.
- `src/graph/query.ts`: deterministic queries over the Trust Graph projection; `src/store/snapshots.ts`: `copySnapshots`.
- `src/collectors/github/retrieval.ts` (declared-path pool, manifest seeking), `hints.ts` (more build files, hostile-path accounting).
- Methodology and rules are untouched; the new outputs are facts, findings, events, trust states and policy inputs.
