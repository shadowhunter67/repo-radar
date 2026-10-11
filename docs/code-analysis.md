# Static code analysis: capabilities, execution, persistence, secrets

Added in methodology 0.2. Everything here is **static and passive**: repo-radar downloads a bounded set of text files
from `raw.githubusercontent.com`, reads them as strings, and never installs, builds, imports or runs anything.

> **Capability is not intent.** "Spawns a process", "downloads a file" or "adds a startup entry" is exactly what
> installers, browsers, security tools and enterprise agents do. Findings describe what code *can* do, with confidence
> and evidence, and always carry `intent: "undetermined"`. No report text says "malicious" or "safe".

## Pipeline

```text
git tree -> file selection (priority, size and count caps) -> fetch text (raw, size-capped)
        -> reference following (script -> files it runs, 2 rounds)
        -> line scanners (detector pack) -> detections, chains, secret candidates
        -> execution graph (hooks, contexts) -> capability summary, persistence summary
        -> normalized facts -> rules -> findings
```

### What is fetched (and what is not)

Priority order, within `LIMITS` in [src/limits.ts](../src/limits.ts) (40 files, 64 KiB each, 2 MiB total):

1. install/build roots: `setup.py`, `build.rs`, `Dockerfile*`, `Makefile`, `install|setup|bootstrap.(sh|ps1|bat)`, `configure`
2. files named by npm lifecycle scripts (`node scripts/setup.js` -> `scripts/setup.js`)
3. compose files, manifest entry points, conventional entry files (`src/index.*`, `cmd/*/main.go`, ...)
4. shell scripts up to two directories deep
5. a shallow sample of other source files

Workflows and manifests that are already fetched for other signals are also scanned for secrets (not for capabilities:
CI scripts run on CI runners, not on the user's machine). Files named like `.env`, private keys or credential files are
reported **from the git tree by name only; their content is never requested**.

The scan is a **sample**. `code_analysis.scan.source_coverage` says how much of the source it saw, and every fact about
"not observed" has confidence `0.3 + 0.5 x coverage`. "Not observed" never means "absent from the repository". When fewer than 20% of the source files (or fewer than 3 code
files) were scanned, "not found" results are **withheld entirely** and the rules that need them are unobserved
(`insufficient_coverage`), so a thin sample can never earn a clean score.

## Capabilities

Fourteen capabilities (`PROCESS_EXEC`, `BINARY_EXECUTION`, `BACKGROUND_PROCESS`, `NETWORK_CLIENT`, `NETWORK_SERVER`,
`REMOTE_DOWNLOAD`, `FILESYSTEM_WRITE`, `FILESYSTEM_DELETE`, `ENVIRONMENT_READ`, `CREDENTIAL_ACCESS`,
`BROWSER_DATA_ACCESS`, `DYNAMIC_CODE_LOAD`, `PRIVILEGE_CHANGE`, `PERSISTENCE`). Every report lists all of them, so absence is explicit.

Each detection has: detector id, `mode` (`DIRECT` pattern observed / `INFERRED` derived from structure or several
observations / `POSSIBLE` weak pattern), `confidence`, file, line, and the **contexts** it can run in:

| Context   | Meaning |
| --------- | ------- |
| `install` | reachable from a hook that runs automatically for dependents (npm `preinstall`/`install`/`postinstall`, `setup.py`, `build.rs`) |
| `build`   | build or setup files a user starts explicitly (`Makefile`, `Dockerfile`, `install.sh`, compose files) |
| `runtime` | ordinary source files |

Base risk per capability is static (`CAPABILITY_RISK`); a medium-risk capability reachable at install time is raised to high.
Risk is about *consequence if misused*, never about intent. Container image builds are treated specially: `sudo`, `USER root`
and profile edits inside a `Dockerfile` apply to the image, not the host, so they are only `POSSIBLE`.

Implementation notes: detectors are line-oriented regexes over lines capped at 2,000 characters, comments are skipped,
at most two locations are kept per detector per file, and the detector pack ([src/analysis/detectors.ts](../src/analysis/detectors.ts))
is pure data (a test asserts it imports nothing executable).

## Execution graph

`code_analysis.execution` lists **hooks** (what runs when), a **graph** (nodes and `RUNS` / `EXECUTES` / `DOWNLOADS`
edges) and compound **chains**.

- **npm** is traced in depth: `preinstall`, `install`, `postinstall` (run for dependents), `prepare`, `preprepare`,
  `postprepare`, `prepublish` (clones/git installs). `npm run x` indirection, `node|sh|python file`, `./file` and relative
  `require/import` are followed within the git tree to a bounded depth with cycle protection; references that leave the
  tree, use absolute paths or URLs are ignored. `npx`/`npm exec` is recorded as a remote-package edge. An implicit
  `node-gyp rebuild` hook is reported when `binding.gyp` exists without an `install` script.
- **Other ecosystems** list their build entry points as hooks and scan them (`setup.py`, `build.rs`, `Dockerfile`, `Makefile`,
  manual install scripts), but only npm resolves script chains in v0.2. pip build backends, Maven/Gradle plugins, Composer
  scripts and gemspec extensions are **not** analyzed yet.
- A hook's `risk` is the highest capability risk reachable from it, `confidence` reflects detection confidence, and
  `analyzed: false` (with lower confidence) means a file on the path could not be read.

### Chains

A complete path matters more than a keyword, so chains are separate findings:

| Chain | Evidence | Mode |
| ----- | -------- | ---- |
| `pipe-to-shell` | `curl ... \| sh`, `iwr ... \| iex`, `eval "$(curl ...)"`, `bash <(curl ...)` on one line | DIRECT, 0.95 |
| `download-chmod-exec` | download, then `chmod +x`, then execution, within 40 lines | INFERRED |
| `download-extract-exec` | download, extract an archive, then execute, within 40 lines | INFERRED |
| `download-eval` | download followed by dynamic evaluation within 40 lines | INFERRED |

The 40-line window exists because a download helper and an unrelated `chmod` hundreds of lines apart in a long installer are
not one path (this produced false positives on real repositories during development).

## Persistence and background execution

`persistence.kinds` uses `systemd_service`, `cron_job`, `launchd_service`, `windows_service`, `registry_run_key`,
`scheduled_task`, `startup_folder`, `shell_profile_modification`, `login_item`, `browser_extension_install`,
`ssh_authorized_keys_write`, `container_restart_policy`, `daemon_creation`, `detached_process`. Detached or backgrounded
processes (`nohup`, `setsid`, `detached: true`) are `BACKGROUND_PROCESS` and are not counted as `PERSISTENCE` by themselves.

## Secrets

High-precision patterns (AWS key ids, GitHub tokens, private key blocks, Slack tokens, Google API keys, live Stripe keys,
database URLs with passwords) plus file-name-only candidates. Generic `key = "..."` assignments are `POSSIBLE` and never scored.
Placeholders and sample values are skipped; matches under `tests/`, `examples/`, `docs/`, fixtures are reported with lowered
confidence and excluded from scoring. **The report never contains a secret value**: only type, location and a redacted form
(at most four characters followed by asterisks; nothing for private keys and URLs). Tests assert the value appears nowhere in
JSON or text output.

## Findings, facts, rules

```text
finding (RR-EXEC-001) --rule_ids--> rule (security.install-time-download-execute)
        --evidence_ids--> chain/hook/detection/secret ids       rule result --evidence_ids--> fact
                                                                 fact --derived_from--> detection/chain/hook/secret ids
```

Scored rules: `security.hardcoded-secrets`, `security.install-time-download-execute`, `supply-chain.install-hooks`.
Informational (context, weight 0, may warn): chains elsewhere, persistence, credential-store access, browser-data access.
See [standards/security/code-analysis.yaml](../standards/security/code-analysis.yaml) and
[standards/supply-chain/install-hooks.yaml](../standards/supply-chain/install-hooks.yaml).

## Known blind spots

- Sample, not census: large repositories are only partly covered, and files over 64 KiB are skipped (reported).
- Line-oriented regexes: no AST, no data flow, no taint tracking, no obfuscation or encoding awareness (base64/hex payloads, string concatenation, dynamic `require`).
- Capabilities in dependencies are not analyzed; only the repository's own files.
- Binary files and release assets are not inspected.
- Test and example code can trigger detections (reported with their path; contexts stay `runtime`).
- Shell scripts execute programs by nature, so `PROCESS_EXEC` is reported from general-purpose languages only.
- Detection of dynamic code loading via variables, plugin systems or reflection is incomplete.

## Safety of the analyzer itself

Limits and hostile-input behavior are in [security-model.md](security-model.md). Added for this subsystem: per-line and
per-file caps, bounded graph size and script depth, resolution of references inside the git tree only (no path traversal),
redacted secrets, tests with oversized lines and ReDoS-style input, and the same four-host network allowlist.

## Execution model (0.4)

Every execution hook has a **stage** (`INSTALL_SCRIPT`, `SOURCE_BUILD`, `BUILD_BACKEND`, `LEGACY_SETUP`, `NATIVE_BUILD`, `INSTALL_GENERATED_ENTRYPOINT`, `RUNTIME`, `TEST`, `CI`, `UNKNOWN`), a **trigger** (`AUTOMATIC`, `BUILD_TOOL_INVOKED`, `USER_INVOKED`, `CI_INVOKED`, `RUNTIME`, `UNKNOWN`) and an **environment** (`HOST`, `BUILD_ENVIRONMENT`, `VIRTUAL_ENV`, `CONTAINER`, `CI_RUNNER`, `UNKNOWN`). Entrypoints are listed separately and are never automatic. "Capability present" is not "capability runs at install".

**Python**: backend selection from `[build-system]` (including `backend-path`); `setup.py` is a hook only when setuptools (or an undeclared backend, or an in-tree backend that delegates to it) runs it; hatch/poetry/pdm custom build scripts; native build detection (rust/maturin, meson, cmake/scikit-build, C extensions, cython, cffi); console/gui scripts and entry-point groups (plugin groups trigger at runtime); local imports followed.

**JVM**: Maven (`exec`, `antrun`, scripting, download, native, codegen, SCM plugins; profile gating lowers confidence), Gradle (configuration-time code vs task actions, wired vs unwired tasks, remote `apply from`, buildSrc), `mvnw`/`gradlew` wrapper scripts. JVM hooks do not run for dependents (`runs_for_dependents: false`).

Probe results on real repositories: `calibration/results/exec-probe-python.md`, `exec-probe-jvm.md`.
