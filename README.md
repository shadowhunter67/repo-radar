# repo-radar

An open, transparent, machine-readable **repository intelligence layer** for GitHub repositories.

Given `owner/repo`, repo-radar answers three questions, and shows the evidence behind every answer:

1. **What does this repository actually do?** (Semantic Identity, independent of its name)
2. **How much evidence is there to trust it, on which dimensions?** (Security, Maintenance, Engineering Hygiene, Supply Chain, Community, Documentation, Semantic Clarity)
3. **What can it do on my machine, and what runs when I install it?** (static capability, install-time execution, persistence and secret analysis; capability is never treated as intent)
4. **Is it a fit for my situation?** (profiles: `default`, `startup`, `enterprise`)

> Status: v0.2 (unreleased), report schema `0.2`, methodology `0.2`. Upgrading from 0.1: [migration notes](docs/migration.md). Scores are **not calibrated** against labelled data yet; see [limitations](docs/limitations.md) before relying on any number.

## Why

Stars, forks and a polished README no longer say much. Repositories are created faster than anyone can review them, names are often brands or acronyms, and AI-assisted generation makes it cheap to produce something that _looks_ professional with little engineering behind it. repo-radar collects **verifiable evidence**, scores it against **published, reviewable rules**, and reports **how sure it is**, instead of producing one opaque number.

## What it does not do

- It does not say a repository is safe, secure, correct or trustworthy. It reports **observed indicators** and **absence of evidence**.
- It does not detect AI-generated code. A few heuristic _substance indicators_ (for example "CI exists but no tests") are reported as risk signals and labelled as heuristics.
- It does not run, install or build anything from the analyzed repository. Analysis is static and read-only: files are fetched as text and matched with bounded patterns.
- It does not decide intent. "Spawns a process", "downloads a file" or "adds a startup entry" are reported as **capabilities** with confidence and evidence; installers, browsers and security tools legitimately do all of them. It does not say "malware".
- It does not give legal or compliance determinations (no compliance packs exist yet).
- It does not use stars/forks as quality evidence (they are recorded as context only).
- It does not penalize unusual repository names. Name-vs-purpose divergence is informational.
- It is not a replacement for a security review or for human judgement.

## Quick start

Requires Node.js 20+.

```bash
npm ci
npm run build
node dist/cli.js analyze pallets/flask          # or: https://github.com/pallets/flask
```

Optional but recommended (raises the GitHub API limit from 60 to 5000 requests/hour; the token is only ever sent to `api.github.com`, never logged or stored):

```bash
export GITHUB_TOKEN=...           # PowerShell: $env:GITHUB_TOKEN = "..."
```

```bash
repo-radar analyze owner/repo --format json --output report.json
repo-radar analyze owner/repo --profile enterprise
repo-radar analyze owner/repo --verbose           # per-rule evidence trace
repo-radar analyze owner/repo --min security=70   # exit code 2 if below the floor
repo-radar analyze owner/repo --no-scan           # skip the static capability / execution / secret scan
repo-radar analyze owner/repo --no-deps-dev --no-sbom --no-compliance   # skip optional layers
repo-radar diff old.json new.json                # what changed between two saved JSON reports
repo-radar diff owner/repo --from v1.0 --to v1.1  # analyze two exact revisions and explain the change (docs/history.md)
repo-radar analyze owner/repo --no-releases --no-targeted-tree   # skip release metadata / the large-tree walk
repo-radar model report.json                     # unified repository model of a 0.4 report
repo-radar profiles
repo-radar rules security
```

Exit codes: `0` ok, `1` internal error, `2` policy floor not met (or not verifiable), `3` repository not found, `4` GitHub unavailable or rate limited, `64` usage error.

## Sample reports (real runs on 2026-10-10 with a GitHub token, default profile)

A mature project (`pallets/flask`, trimmed; full output in [examples/](examples/)):

```text
IDENTITY
  building HTTP servers and web applications - detected type: web-framework
  Confidence: 50% (heuristic classifier heuristic-v0.1)
  Declared: "A simple framework for building complex web applications."
  Interfaces: cli, library
  Ecosystem: Python, PyPI
  Artifact: framework (60%), alternatives: cli, library  Domain: web
  Candidates: web-framework 52%, task-queue 31%, educational 17%
  Note: the name says little about the purpose (informational, not scored)

TRUST PROFILE (observed evidence evaluated against methodology 0.2)
  Security              70  C+   #######---  conf  88%
  Maintenance           91  A    #########-  conf  79%
  Engineering Hygiene  100  A+   ##########  conf  91%
  Supply Chain          84  B+   ########--  conf  98%
  Community             93  A    #########-  conf  98%
  Documentation         85  A-   #########-  conf  94%
  Semantic Clarity      92  A    #########-  conf  87%
  Overall               88  A-   #########-  conf  90%  (weighted by profile "default"; not an absolute verdict)

Overall confidence: 90%

WARNINGS
  - 7 of 100 pinned dependencies have known OSV advisories.

CAPABILITIES (static scan of 37 files, 100% of source files sampled)
  NETWORK_SERVER       LOW     INFERRED 60%  [runtime] src/flask/app.py
  ENVIRONMENT_READ     LOW     DIRECT 90%  [runtime] src/flask/app.py, src/flask/cli.py
  DYNAMIC_CODE_LOAD    MEDIUM  DIRECT 85%  [runtime] src/flask/cli.py, src/flask/config.py
  Not observed in the scanned sample: PROCESS_EXEC, BINARY_EXECUTION, BACKGROUND_PROCESS, NETWORK_CLIENT, REMOTE_DOWNLOAD, FILESYSTEM_WRITE, FILESYSTEM_DELETE, CREDENTIAL_ACCESS, BROWSER_DATA_ACCESS, PRIVILEGE_CHANGE, PERSISTENCE
  (A capability describes what code can do, not why. Intent: undetermined.)
```

A tiny, old, low-evidence project (`octocat/Hello-World`):

```text
IDENTITY
  Purpose not determined from available metadata (confidence 0%)
  Declared: "My first repository on GitHub!"
  Artifact: unknown (20%)  Domain: unknown

TRUST PROFILE (observed evidence evaluated against methodology 0.2)
  Security              19  F    ##--------  conf  33%  low confidence range 7-70
  Maintenance           66  C+   #######---  conf  82%
  Engineering Hygiene   15  F    ##--------  conf  78%
  Supply Chain          36  F    ####------  conf  60% range 22-60
  Community             37  F    ####------  conf 100%
  Documentation         50  D    #####-----  conf  94%
  Semantic Clarity      46  D    #####-----  conf  76%
  Overall               38  F    ####------  conf  75%  (weighted by profile "default"; not an absolute verdict)

Overall confidence: 75%

WARNINGS
  - No security policy (SECURITY.md) detected.
  - No commit on the default branch for over a year.
  - No test files detected in the repository tree.
  - No license detected.
```

Things to notice: the Hello-World Security score has a **range of 7-70** and 33% confidence because almost nothing could be
observed (and, since too little code exists to scan, "nothing found" is not counted as a good result); capabilities for flask
list what the sampled code *can* do, with an explicit "not observed in the sample" line.

Read these with the [limitations](docs/limitations.md) in mind. Real examples of what goes wrong: `junegunn/fzf` was first
called an "editor extension" (30%) until the taxonomy gained command-line keywords; `sindresorhus/execa` (a library) first came out as
a CLI at 52% in the artifact layer until structure (no `bin` entry) was allowed to override the domain hint, and its domain label is still
"command-line tooling" at 33%; `nvm-sh/nvm` gets a wrong "library" interface at 20% confidence. "Engineering Hygiene 100" only means tests, lint
configuration, typing and CI were observed, not that the code is good. Longer reports: [flask](examples/flask.report.txt),
[flask, enterprise profile, per-rule detail](examples/flask.enterprise.verbose.txt), [nvm (installer-style scripts, chains and
capabilities)](examples/nvm.report.txt), [Hello-World JSON](examples/hello-world.report.json).

## How it works

```text
Collectors -> Normalized Evidence -> Semantic Identity -> Rules (YAML) -> Dimension scores -> Profile -> CLI / JSON / Action
```

- **Collectors** (GitHub REST + raw files, OpenSSF Scorecard, OSV, optional deps.dev) and the dependency subsystem ([docs/dependencies.md](docs/dependencies.md)) produce typed, timestamped, provenance-carrying **evidence** with a confidence value.
- **Semantic Identity** classifies what the repository does from description, topics, manifests, README, dependencies and layout. The default classifier is a transparent keyword/structure heuristic that needs no API key; it sits behind an `IdentityClassifier` interface so an LLM classifier can be plugged in.
- **Rules** live in [standards/](standards) as YAML, one namespace per dimension, reviewable by pull request. Each rule names the evidence ids it reads, a weight and a scoring function. The engine contains no thresholds.
- **Scores** come with **coverage**, **confidence**, a **score range** and an **evidence trace**. Missing evidence never lowers a score; it lowers confidence. Correlated signals share one weight budget.
- **Profiles** change weights and advisory minimums only, never the evidence.
- **Static code analysis** ([docs/code-analysis.md](docs/code-analysis.md)) reads a bounded sample of scripts, build files and source: 14 capabilities with contexts (install / build / runtime), an npm install-hook execution graph, download-and-execute chains, persistence mechanisms and redacted secret candidates. These become normalized **facts** ([docs/facts.md](docs/facts.md)) that rules consume, and standardized **findings** that link back to rules and detections. "Nothing found" only counts when enough code was read.

More: [code analysis](docs/code-analysis.md) · [facts](docs/facts.md) · [migration 0.1 to 0.2](docs/migration.md) · [calibration plan](calibration/README.md) · [architecture](docs/architecture.md) · [methodology](docs/methodology.md) · [evidence schema](docs/evidence-schema.md) · [scoring bias](docs/bias.md) · [security model](docs/security-model.md) · [limitations](docs/limitations.md) · [roadmap](docs/roadmap.md) · [authoring standards](docs/standards-authoring.md).

## GitHub Action

```yaml
- uses: actions/checkout@v4 # not required for analysis; repo-radar reads through the API
- uses: OWNER/repo-radar@v1 # replace OWNER once the action is published
  with:
    profile: enterprise
    minimum-security-score: 70
```

The report is uploaded as an artifact and summarized in the job summary. See [action.yml](action.yml) and [examples/github-workflow.yml](examples/github-workflow.yml).

The action runs a pre-built single-file bundle (`dist/action/repo-radar.mjs`, produced by `npm run bundle`, git-ignored). **It is not usable from a plain checkout of this repository**: a release has to commit the bundle to the release tag. This repository's CI builds the bundle and runs the action against itself (`uses: ./`), but that workflow has not yet been executed on GitHub at the time of writing; the bundle itself was run locally.

## Development

```bash
npm ci
npm run check      # typecheck + lint + format check + tests (all offline)
npm run build      # tsc -> dist/
npm run bundle     # esbuild single file for the GitHub Action
npm run schemas    # regenerate schemas/*.json from the zod definitions
```

Tests never touch the network: GitHub, Scorecard and OSV are replaced by deterministic fakes in [tests/helpers](tests/helpers).

## Data sources and attribution

GitHub REST API · [OpenSSF Scorecard](https://github.com/ossf/scorecard) public API (Apache-2.0 project; only its published results are read) · [OSV](https://osv.dev) (advisory data under the licenses of each source database). Rule ideas draw on public work from OpenSSF (Scorecard, Best Practices, SLSA) and CHAOSS; no code or text from those projects is copied. [deps.dev](https://deps.dev) (optional; data under CC-BY-4.0). Not yet integrated: OpenSSF Best Practices badge API (see roadmap).

## License

Apache-2.0, see [LICENSE](LICENSE).
