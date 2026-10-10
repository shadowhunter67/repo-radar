# Architecture

repo-radar is a **stateless, read-only** pipeline. Nothing from an analyzed repository is ever executed.

```text
                 +--------------------------- untrusted input ----------------------------+
                 |  GitHub API / raw files     OpenSSF Scorecard API        OSV API         |
                 +-----------+-------------------------+-------------------------+---------+
                             v                         v                         v
 Collectors      src/collectors/github/*        src/collectors/scorecard.ts   src/collectors/osv.ts
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

## Module map

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
| `src/analyze.ts`              | Orchestration: collectors -> identity -> evidence store -> scoring -> report                            |
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
