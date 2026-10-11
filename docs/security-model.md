# Security model

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
