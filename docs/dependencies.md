# Dependency intelligence (schema 0.4)

repo-radar reads what a repository itself declares about its dependencies, resolves it statically, and (optionally) asks
public databases about the exact versions it found. Nothing here runs a package manager or any repository code.

```
manifest / lockfile / SBOM  ->  normalized dependency model  ->  resolution  ->  OSV lookup  ->  findings, facts, report
                                          (src/deps/model.ts)     (resolve.ts)    (vulns.ts)
                          deps.dev (optional metadata)  (depsdev.ts)      SBOM comparison (compare.ts)
```

## Vocabulary: what is exact, resolved, a candidate, inferred, unknown

| Term | Meaning | Used for vulnerability lookup? |
| --- | --- | --- |
| **requested** | What the manifest literally asks for (`^4.0.0`, `latest`, `github:u/r#main`, `workspace:*`). Always preserved. | no |
| **exact** | The request itself is a pin (`1.2.3`, `==1.2.3`, `=1.2.3`, a Go module version). | yes (source `manifest_pin`, confidence 0.85; Go 0.9) |
| **resolved** | An exact version backed by evidence from the analyzed revision: a **lockfile** (0.95), a valid **SBOM** (0.7) or an **exact manifest pin**. | yes |
| **unresolved** | Only a range or tag was seen and nothing says which version this revision installs. `resolved` stays empty. | **no** - state `unresolved_version` |
| **ambiguous** | Several versions are recorded (e.g. two locked copies) and the request does not single one out. | no |
| **registry candidate** | What deps.dev offers *today* for an unresolved range (npm/Cargo semver). A fact about the registry now, never about the revision. | **never** |
| **not_registry** | `workspace:`, `path`, `git`, URL dependencies: no registry version exists. | no |
| **unknown** | The state of every dependency before a lookup, and of every dependency after a failed lookup. Unknown is not safe. | no |

Precedence for the exact version: **lockfile > SBOM > manifest pin**. When sources disagree (manifest pin vs lockfile,
lockfile vs SBOM, a lockfile version outside the manifest range) the stronger source wins, the other value is kept in
`other_versions` and a conflict (`dependency_intel.conflicts`) and a finding are emitted. A lockfile only describes manifests it
actually covers (same directory, members it lists, workspaces the root manifest declares, Cargo/uv workspace members); a
project under `examples/` is independent and is not resolved against the root lockfile.

Historical correctness: the analyzed revision is pinned with `--ref`. Lockfiles, manifests and SBOMs are read at that revision.
Registry data is always "now" and is stored separately.

## Package identity

`{ ecosystem, name, purl }` with purl following the Package URL spec where defined (`pkg:npm/%40scope/name@1.0.0`,
`pkg:pypi/name` with PEP 503 normalization, `pkg:cargo/...`, `pkg:golang/...`). Ecosystems: npm, PyPI, crates.io, Go
(Maven only through SBOM purls for now).

## Sources and what they give

| Source | Read | Exactness |
| --- | --- | --- |
| `package.json` | dependencies, dev, peer, optional, `workspaces`, private flag | specs only (exact when pinned) |
| `package-lock.json` / `npm-shrinkwrap.json` (v1-v3) | every package with its install path, dev/optional flags, workspace members | exact; nearest-`node_modules` resolution per importer |
| `yarn.lock` (classic, berry headers) | request string -> version | exact for the covered manifest (same dir, `workspace:` members) |
| `pnpm-lock.yaml` (v5-v9, multi-document) | importers' resolved versions, packages | exact per importer |
| `pyproject.toml`, `requirements.txt` | PEP 508 deps, extras, dependency groups, build requires, Poetry tables, direct references | only `==x.y.z` is exact |
| `poetry.lock`, `uv.lock` | name -> version, local packages | exact when a single version is locked |
| `Cargo.toml` | dependencies, dev, build, target tables, renames, path/git/workspace-inherited forms | a bare `1.2.3` is a caret **range** |
| `Cargo.lock` | packages; several versions narrowed by the requirement | exact when unambiguous |
| `go.mod` / `go.sum` | `go.mod` requirements (direct and `// indirect`), local `replace`; `go.sum` confirms the version is listed | the main module's requirements are its minimum-version-selection result (exact for its build when go >= 1.17 lists all); `go.sum` is not the build list |

Not done (documented limits): Maven/Gradle, Pipfile.lock, bun lockfiles, `requirements*.txt` variants beyond `requirements.txt`,
transitive resolution without a lockfile, Python environment markers (markers are dropped, the requirement is kept), full
PEP 440 range evaluation, Go build-list computation, Cargo feature resolution. Up to 10 manifests, 6 lockfiles (5 MiB each),
10,000 packages per lockfile and 2,000 declared dependencies per manifest are read; hitting a cap is a diagnostic.

## Vulnerability pipeline (OSV)

1. Every dependency gets an explicit state: `checked`, `not_checked`, `unresolved_version`, `source_unavailable`,
   `unsupported_ecosystem`, `lookup_failed`, `partial` (OSV paginated its advisory list).
2. Only dependencies with an exact resolved version are sent (up to 1000 unique packages; direct before transitive; Go versions
   without the `v` prefix).
3. "Checked" requires a successful, well-formed response. HTTP errors, rate limits, malformed bodies or a wrong result count
   make **all** queried packages `lookup_failed`; nothing is guessed from partial data.
4. Each advisory keeps `id`, source (`osv` or `deps.dev`), package, version, lookup URL and timestamp. OSV batch results carry ids
   only, so severity is not determined and findings say so.
5. Coverage: `osv.coverage_ratio` = direct registry dependencies that were checked / direct registry dependencies (auxiliary
   manifests excluded). If **no** vulnerability is found and that share is below 50% (`MIN_VULN_COVERAGE`), `osv.vulnerable_ratio` is
   withheld: the rule `security.known-vulnerabilities` becomes `not_observed` / `insufficient_coverage` instead of 10/10. If
   vulnerabilities are found, the ratio is always reported (a positive result needs no coverage).

## deps.dev (optional, `--no-deps-dev`)

Host `api.deps.dev` (allow-listed, https, no cross-host redirects, 3 MB cap, 15 s timeout). Used for (a) metadata of exact direct
versions - licenses, deprecation, source repositories, whether SLSA provenance is *listed*, advisory keys (up to 40 lookups) and
(b) the current registry candidate for unresolved npm/Cargo ranges (up to 30 lookups). Identical requests are made once per run.
A 429 stops further requests; failures give `partial` / `unavailable` with a diagnostic. A deps.dev failure never changes a
dependency's vulnerability state and never marks anything safe.

## SBOM (optional, `--no-sbom`)

Discovery by file name (`sbom*.json`, `bom.json`, `cyclonedx*.json`, `spdx*.json`, `*.cdx.json`, `*.spdx.json`, depth <= 3, outside
vendored/test/fixture directories) - a name is never proof; the content must be a CycloneDX 1.2-1.7 or SPDX 2.2/2.3 JSON document. Limits:
5 MiB, 64 nesting levels (checked before `JSON.parse`), 5,000 components, 50,000 relationships, 300 characters per string.
Components keep `bom-ref`, purl, version, scope, licenses, hash count, supplier and author, and a category (library, application,
framework, container, operating-system, file, device, data, other); only libraries/frameworks take part in the comparison.

Comparison with the repository (never a "completeness %"): direct runtime dependencies of registry origin vs SBOM libraries, matched
by purl identity (bare-name matches lower the confidence). States: `consistent`, `partial` (missing dependencies, unverifiable
versions, truncation, or a valid but empty SBOM), `mismatch` (a version differs from the lockfile/pin, or lies outside the requested
range), `unable_to_compare`. Extra SBOM components are counted, not blamed. Also reported: duplicate identities, missing/invalid
versions, library components without purl, ecosystems missing from the SBOM. A SBOM-derived version never validates itself.

## Findings and facts

Categories `dependency` and `sbom` (ids `RR-DEP-nnn`): known advisories for an exact version, unresolved direct dependencies (info),
mutable git branches (medium) and dist-tags (low), manifest/lockfile and lockfile/SBOM disagreements, SBOM mismatch/partial,
duplicate or invalid SBOM entries, ingestion failures, failed lookups. Severity and confidence are separate fields. Facts `deps.*`
([facts.md](facts.md)) feed two informational rules; **no score weight changed**.

## Security

Package names, specs, SBOM fields and lockfile contents are attacker-controlled: they are length-bounded, stripped of terminal
control sequences, URL-encoded into requests, and requests can only reach the allow-listed hosts. No package manager is run.
Details: [security-model.md](security-model.md).

## 0.4 additions

- **Contexts**: `primary` vs `auxiliary` (examples, fixtures, docs, benchmarks; `AUXILIARY_DIR` in `src/util/scope.ts`). Auxiliary manifests do not dilute coverage.
- **Lockfile coverage**: a lock covers manifests in its directory, listed importers or workspaces globs; names that are local inside the lock tree are the only ones a nested Cargo lock covers.
- **Formats added**: Maven `pom.xml` (pins have confidence 0.6; ranges/properties stay unresolved), Gradle `build.gradle(.kts)`, `gradle/libs.versions.toml` catalogs, `gradle.lockfile`; multi-document `pnpm-lock.yaml`.
- **Conflicts** use the shared model in `src/evidence/conflict.ts`: precedence for an exact version is lockfile > SBOM > manifest pin, and each conflict records the preferred source and the reason. Current registry candidates (deps.dev) never override evidence and are not historical truth.
- **Observed risk vs completeness**: see [methodology.md](methodology.md) section 14.
- A package name with non-ASCII characters yields a finding (look-alike risk) with escaped code points.
