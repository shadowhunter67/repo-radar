# Security model

The 2026-10-25 `npm audit --omit=dev` result is 0 runtime vulnerabilities. The
full development audit reports three unresolved advisories: `@vitest/mocker`
(GHSA-82fw-gwwq-j7x9 and a related manual-mock issue) and two critical tinypool
prototype-pollution/RCE advisories (GHSA-5gmw-xhrv-c9v3 and GHSA-85c8-ppgw-ccpr).
The suggested fix is the breaking Vitest 5.0.5 upgrade; it remains pending because
the current peer set conflicts.

Assumption: **the repository being analyzed is malicious input.** repo-radar only reads data; it must stay safe when that data is hostile.

## Controls

| Threat | Control | Where |
| ------ | ------- | ----- |
| Executing repository code | Never. No install, build, `make`, container or binary runs. Manifests, lockfiles and workflows are parsed as data. | whole codebase; no `child_process` import exists |
| Malicious `owner/repo` argument (path traversal, URL tricks, userinfo, other hosts) | Strict regex parse; only `github.com` https URLs; everything else rejected before any request. | `src/util/repo-ref.ts` (tested with traversal, `@`, lookalike-host and scheme cases) |
| SSRF via repository-controlled URLs (homepage, `repository`, README links) | No repository-controlled URL is ever fetched. Requests go only to five fixed hosts (GitHub API, raw.githubusercontent.com, Scorecard, OSV, deps.dev); paths from the git tree are percent-encoded per segment and tree paths with `..`, `\` or empty segments are dropped. | `src/util/http.ts`, `src/collectors/github/tree.ts` |
| Reading repository files for capability/secret analysis (0.2) | Files are fetched as **text** from `raw.githubusercontent.com` only, at most 40 files, 64 KiB each, 2 MiB total, chosen from the git tree (never from paths found inside file contents unless they resolve to an existing tree entry). Local references (`node scripts/x.js`, `require('./y')`) are resolved with POSIX normalization **inside the tree**: absolute paths, `..` escapes, URLs and backslashes are rejected. Nothing is written to disk, imported or executed; detectors are plain regexes (a test asserts the detector pack imports nothing executable). | `src/limits.ts`, `src/collectors/github/scanfiles.ts`, `src/analysis/refs.ts` |
| Hostile content inside scanned files (huge lines, ReDoS patterns, deep script nesting, graph blow-up) | Lines cut at 2,000 characters before any regex; at most 6,000 lines per file; chain detection limited to 6 download anchors and a 40-line window; execution graph capped at 300 nodes and 5 levels with cycle protection; detections capped at 300; limits hit are reported as diagnostics. Tests feed 2 MB lines and pathological repetitions. | `src/analysis/scan.ts`, `src/analysis/execution.ts` |
| Leaking secrets found in a repository | Secret values are never stored in the report or logs: only type, location and a redacted form; secret-named files (`.env`, keys) are reported by name and **their content is never requested**. Tests assert the value appears nowhere in JSON or text output. | `src/analysis/secrets.ts`, `tests/unit/code-analysis-pipeline.test.ts` |
| Misleading hostile report text (a repository crafting file names/paths to inject terminal control sequences or fake findings) | Paths and labels from repositories are sanitized before the text report; findings use fixed templates and never echo raw file content. | `src/report/text.ts`, `src/analysis/findings.ts` |
| Redirect-based SSRF | Redirects are handled manually; each hop must be https and allowlisted; at most 2 hops. | `HttpClient.request` |
| Token leakage | Token held only by the GitHub client, sent only to `api.github.com` (not to `raw.githubusercontent.com`, Scorecard or OSV); never logged or written; error messages are redacted by pattern and by exact token value. | `src/util/http.ts`, `src/analyze.ts` |
| Oversized responses / memory DoS | Per-request byte caps (512 KiB files, 5 MiB lockfiles and SBOMs, 2 MB default, 8 MB OSV, 3 MB deps.dev), declared length checked, streamed bytes counted, 15 s timeout, caps on files fetched (20 workflows, 10 manifests, 6 lockfiles, 3 SBOMs), tree entries (100k), lockfile packages (10,000), SBOM components (5,000) and OSV packages (1000). | `HttpClient`, collectors, `src/deps/*` |
| Hostile package names/specs/SBOM content reaching the network (SSRF, path or query injection) | Names and versions are `encodeURIComponent`-encoded into fixed `https://api.deps.dev/v3/...` paths; the client only talks to allow-listed hosts, so a name such as `a/../../x?y=1#f@evil.test` cannot change host, path structure or query. Tests assert host, empty query and no `../` for every deps.dev request. | `src/deps/depsdev.ts`, `src/util/http.ts`, `tests/unit/deps-pipeline.test.ts` |
| Hostile SBOM / lockfile documents (deep nesting, huge component lists, extreme strings, malformed purls) | Nesting is measured in O(n) before `JSON.parse` (64 levels); size, component, relationship and string caps; purl parsing is total (never throws); strings are control-sequence-stripped. Malformed or unsupported documents become diagnostics, never partial trust. | `src/deps/sbom.ts`, `src/deps/lock.ts` |
| Running package managers to resolve versions | Never: resolution reads lockfiles, SBOMs and manifest pins only (`npm`, `pip`, `cargo`, `go`, `mvn`, `gradle` are never spawned). | `src/deps/*` |
| YAML bombs / custom tags | `yaml` core schema (no custom tags), `maxAliasCount` 50 for workflows and 10 for standards; parse errors are non-fatal. | `workflows.ts`, `rules.ts`, `profiles/load.ts`, `taxonomy.ts` |
| JSON/TOML hostility, prototype pollution | Only `JSON.parse` / `smol-toml` on size-capped text; values are read by key, never merged into objects. | `manifests/parse.ts` |
| ReDoS | Regexes applied to repository text have bounded look-ahead and bounded input: README capped at 200 KB, each workflow `run:` script scanned only up to 20,000 characters, declared description text capped at 4,000 characters. Tests run pathological inputs (a quadratic `mvn ` x 100k case took ~26 s before it was fixed during development). | `readme.ts`, `workflows.ts`, `tree.ts`, `heuristic.ts`, `tests/unit/regressions.test.ts` |
| Terminal injection (ANSI/OSC/bidi/control characters in names, descriptions, READMEs) | Every repository-controlled string is sanitized before it reaches the text report; the JSON report is plain JSON (consumers that render it as HTML must escape it). | `src/util/text.ts`, `src/report/text.ts` |
| Malicious taxonomy/rule/profile files | Validated by zod schemas at load; unknown rules in a profile fail loudly. | `src/scoring/rules.ts`, `src/profiles/load.ts` |
| Profile name as a path | Profile ids are matched against the loaded list, never joined into a path. | `loadProfile` |
| Excessive API use | At most ~12 GitHub API requests per analysis, rate-limit responses detected and surfaced; no retries beyond one for 5xx/network errors. | `HttpClient`, collector |
| GitHub Action input injection | Inputs reach the shell only through environment variables, never interpolated into the script. | `action.yml` |
| Supply chain of this project | Runtime dependencies: `zod`, `yaml`, `smol-toml`. CI actions pinned to commit SHAs; Dependabot enabled for npm and Actions. | `package.json`, `.github/` |

## Deliberate non-controls

- `--output` and `--text-output` write wherever the invoking user points them, like a shell redirect. They are user-supplied, not repository-supplied.
- The tool trusts the TLS stack of the Node.js runtime and the three external services' answers (their values are range-checked and typed, but a compromised service could feed wrong evidence). Evidence carries provenance URLs for audit.
- No sandboxing is needed because nothing is executed; if a future version executes anything, it must be sandboxed first.

## Reporting

See [SECURITY.md](../SECURITY.md).

## Additions in 0.4

- XML (POM, SBOM) is read by `src/util/xml.ts`: DOCTYPE and ENTITY declarations are rejected (no XXE, no billion-laughs), with limits on size, depth and node count. No external XML library or network access is involved.
- Regular expressions that come from data (standards packs) go through `safeRegExp`: nested-quantifier patterns are refused at load time and inputs are truncated.
- Lock/SBOM/TOML/YAML parsers fail closed on pathological nesting and alias bombs; package names such as `__proto__` are handled as plain strings.
- Names and specs from dependencies are sanitized before they reach the terminal; non-ASCII names produce a finding with code points escaped.
- Untrusted repository code is still never executed: no package manager, build tool, interpreter or container is started for the analysed repository.


## Additions in 0.5

- Release asset URLs are fetched only when they are `https://github.com/<owner>/<repo>/releases/download/...` of the analyzed repository (no userinfo, port or traversal); redirects may only go to GitHub's own asset hosts; the token is sent to `api.github.com` only. Checksum files are capped at 256 KiB, attestation JSON at 1 MiB, and base64 payloads are decoded under a size cap.
- Asset names, checksum names and archive entry names are data: control characters, bidi overrides, backslashes, absolute paths and `..` mark a name unsafe and it is never used as a path or printed raw.
- Archive inspection reads headers only, with entry-count, size, ratio and gunzip limits; nothing is extracted or executed. Downloaded binaries are never run.
- Targeted tree retrieval refuses traversal, backslash and control-character paths from the tree listing and is bounded in requests, nodes, bytes, time and depth.


## Additions in 0.6 (threat model)

| Threat | Defence |
| ------ | ------- |
| Malicious registry metadata (huge, malformed, wrong content type, prototype keys, control characters, look-alike names) | Size caps per response, JSON/content-type checks, bounded and sanitized fields, `__proto__` handled as data, non-ASCII names flagged and shown with escapes, failures become diagnostics and `unknown` facts |
| Registry-provided URLs (redirects, repository URLs) | Registry URLs are never followed; the client allows only `registry.npmjs.org`, `pypi.org`, `crates.io` and refuses redirects elsewhere (localhost, private IPs, cloud metadata) |
| Malicious provenance bundles / certificates / signatures | The maintained `sigstore` library verifies; bundles above 256 KiB are not parsed by it; 20 s timeout; the statement is parsed with size/subject caps; a verifier that cannot decide is `verification_failed`; identity strings are parsed as data with a strict pattern and sanitized |
| Trust-root confusion | Every verification result names its trust root and who verified; GitHub's API assertion is kept separate from local verification; only the Sigstore public-good root is implemented |
| Algorithm downgrade | MD5/SHA-1 digests are recorded but never used as the expected value or as integrity evidence |
| Malicious release metadata (asset names, duplicate names, checksum files, redirects) | Control characters, bidi overrides, traversal and non-ASCII names are flagged and never echoed raw; conflicting digests are surfaced; only this repository's `releases/download/` URLs are fetched; downloads are capped by size, count and total bytes; archives are inspected as metadata only |
| Malicious snapshot files | Strict key patterns, resolved-path containment, immutability (no overwrite), read-time size/schema/integrity checks, hostile index lines skipped |
| Graph poisoning | Edges without evidence are never created; the graph is a derived view, not an input to any decision |
| Token leakage | The GitHub token goes only to `api.github.com`; errors are redacted; regression tests check reports, diagnostics, snapshots and the graph |
| Resource exhaustion | Every new subsystem has explicit limits (requests, bytes, nodes, time, search budget) reported in the output |

## Additions in 0.7 (threat model)

| Threat | Defence |
| ------ | ------- |
| Malicious dependency registry metadata (tens of thousands of versions, prototype keys, odd value types, control characters and bidi overrides in names, future or garbage timestamps, `javascript:`/`file:` repository URLs) | Same client, hosts, size and content-type checks as `registry_intel`; fields are bounded and sanitized; the sample is the newest 20 versions; a publish time in the future or before 1990 makes a version untimed (no event); only GitHub `https` URLs are normalized; names are shown with escapes; tests parse a 40,000-version packument and `__proto__`/`constructor` keys |
| Malicious publisher history used to fake or hide a pattern | Events are derived from per-version registry records only; the registry's CURRENT maintainers never become a dated event; a pattern needs the same package for every step (`same_entity`); old events do not reach the timeline; the result is always "indicator, intent undetermined" |
| Dependency lookups as a resource sink or an amplification vector | Deterministic priority and an explicit budget (packages, requests, time, bytes, parallelism); a package is fetched once, one request each (the crates.io owners request is skipped for dependencies); the budget outcome is reported per skipped package |
| Malicious Sigstore blob bundle (huge, deeply nested, cyclic, many certificates/log entries/subjects, a digest for other bytes) | Size, certificate, transparency-log and subject limits before the library sees it; a bundle that cannot be serialized is skipped; the artifact SHA-256 is compared with the signed digest first; 20 s timeout; a decision the library cannot reach is `verification_failed`, a limit is `verification_skipped_resource_limit` |
| Malicious GPG signature or key packets | Parsed by the maintained `openpgp` library (memory-safe, no host `gpg` is run, no keyring is read); signature 64 KiB, signed data 8 MiB, key file 1 MiB, 16 keys, 8 per file; weak hashes rejected; random bytes and truncated armor are `verification_failed` |
| Malicious minisign file | Strict container parser (fixed lengths, base64 charset, algorithm bytes), 4 KiB cap, Ed25519 by `node:crypto`; the trusted comment is verified by the global signature |
| A repository supplying its own trust root (a committed public key, an `expected identity` in a file) | Trust comes ONLY from flags and a user-maintained trust file; a committed key is listed as `key_present_in_repository`, `trusted: false`, and is never fetched or used; private key blocks are refused; a result cannot depend on the host keyring |
| Large-bundle download used for SSRF or exfiltration | One exact host (`tmaproduction.blob.core.windows.net`), https, no userinfo/port, path under `/attestations/`, a credential-free client, redirects only inside that host, 512 KiB / 1 MiB caps, five per release; the signed query string is never stored or printed; the Snappy decoder checks the declared length before allocating |
| Deep declared paths and recursive module references | Declared paths are normalized and must pass the tree path check (no `..`, absolute, drive-letter, backslash or template paths; counted as `rejected_unsafe`); depth cap 8, 400 accepted paths, own request pool; a directory is listed at most once; thousands of declared modules and a 30,000-line CMake file are capped and read in milliseconds |
| Domain extraction as ReDoS | Lines cut at 2,000 characters before any regex, bounded repetition, per-file and per-run caps; tests with 200 KB URL literals, 500 KB lines and 5,000-label hosts |
| Homoglyph and huge URL literals in domains | IDN is normalized to punycode, the original is kept, the ambiguity is informational; credentials in URLs are dropped; no host is resolved or contacted |
| Secrets in the new subsystems | The GitHub token is only sent to `api.github.com`; trusted keys, signatures, payloads and signed bundle URLs never enter a report, a diagnostic, a snapshot or the graph (regression tests scan all of them) |
| Graph and event poisoning | Edges still require evidence; timeline events without a timestamp cannot correlate; dependency events carry an entity; a diff-derived edge's time is a commit date, never the analysis time |

The only network access outside `src/util/http.ts` remains the Sigstore TUF client under `--verify-crypto`; the attestation blob store above goes through `HttpClient` with its own one-host allowlist. Still never executed: package managers, build tools, interpreters, `gpg`, `minisign`, installers, release binaries.

## Network-path audit (H5)

All application HTTP calls in `src/collectors/**`, `src/deps/**`, `src/registry/**`,
`src/release/**`, and `src/batch.ts` call `HttpClient.request`; each client is constructed
with an explicit host allowlist and manual redirect validation in `src/util/http.ts`.
The only intentional exception is the lazily loaded Sigstore verifier/TUF client in
`src/trust/sigstore.ts`, enabled only by `--verify-crypto`; it reaches the maintained
Sigstore TUF service and is not repository-controlled. Static `fetch` in `HttpClient`
is the injected/default transport, not a second application network path. Redirects are
tested as refused when a hop leaves the allowlist.
# Artifact and batch threat rows (0.9)

Archive threats include traversal, links, duplicate paths, corrupt headers, zip/tar bombs, oversized metadata, nested archives, and hostile Unicode. URL threats include credentials, ports, redirects, and private hosts. ReDoS is bounded by input and entry caps. Batch threats include unsafe list entries, budget exhaustion, failure isolation, and immutable snapshot conflicts.
Dependency artifact retrieval keeps registry/package/version and digest outcomes only; raw signed or temporary artifact URLs are not persisted, and redirects are accepted only when the destination remains on the ecosystem allowlist.

The runtime advisories for zod and ip-address were fixed by `npm audit fix`. The
current known Vitest/tinypool advisories are dev-only and remain unresolved pending
a compatible Vitest 5 peer-dependency upgrade; they affect contributors running the
test suite, not users of the published runtime package. This is a status statement,
not a claim that the development toolchain has no vulnerabilities.

K4 adds two related controls: introduction history is emitted only from fetched revisions, and artifact deltas require verified same-package pairs. Missing history or unsupported metadata is unknown/not available, never negative evidence.
