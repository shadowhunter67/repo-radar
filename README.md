# repo-radar

An open, transparent, machine-readable **repository intelligence layer** for GitHub repositories.

Given `owner/repo`, repo-radar answers three questions, and shows the evidence behind every answer:

1. **What does this repository actually do?** (Semantic Identity, independent of its name)
2. **How much evidence is there to trust it, on which dimensions?** (Security, Maintenance, Code Quality, Supply Chain, Community, Documentation, Semantic Clarity)
3. **Is it a fit for my situation?** (profiles: `default`, `startup`, `enterprise`)

> Status: v0.1, a working MVP. Methodology version `0.1`. See [limitations](docs/limitations.md) before relying on any number.

## Why

Stars, forks and a polished README no longer say much. Repositories are created faster than anyone can review them, names are often brands or acronyms, and AI-assisted generation makes it cheap to produce something that _looks_ professional with little engineering behind it. repo-radar collects **verifiable evidence**, scores it against **published, reviewable rules**, and reports **how sure it is**, instead of producing one opaque number.

## What it does not do

- It does not say a repository is safe, secure, correct or trustworthy. It reports **observed indicators** and **absence of evidence**.
- It does not detect AI-generated code. A few heuristic _substance indicators_ (for example "CI exists but no tests") are reported as risk signals and labelled as heuristics.
- It does not run, install or build anything from the analyzed repository. Analysis is static and read-only.
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
repo-radar profiles
repo-radar rules security
```

Exit codes: `0` ok, `1` internal error, `2` policy floor not met (or not verifiable), `3` repository not found, `4` GitHub unavailable or rate limited, `64` usage error.

## Sample reports (real runs on 2026-10-10 with a GitHub token, default profile)

A mature project:

```text
pallets/flask

IDENTITY
  building HTTP servers and web applications - detected type: web-framework
  Confidence: 50% (heuristic classifier heuristic-v0.1)
  Declared: "A simple framework for building complex web applications."
  Interfaces: cli, library
  Ecosystem: Python, PyPI

TRUST PROFILE (observed evidence evaluated against methodology 0.1)
  Security           61  C    ######----  conf  90%
  Maintenance        91  A    #########-  conf  79%
  Code Quality      100  A+   ##########  conf  91%
  Supply Chain       82  B+   ########--  conf  99%
  Community          93  A    #########-  conf  98%
  Documentation      85  A-   #########-  conf  94%
  Semantic Clarity   92  A    #########-  conf  87%
  Overall            86  A-   #########-  conf  91%

WARNINGS
  - 7 of 100 pinned dependencies have known OSV advisories.
```

A tiny, old, low-evidence project (`octocat/Hello-World`):

```text
IDENTITY
  Purpose not determined from available metadata (confidence 0%)
  Declared: "My first repository on GitHub!"

TRUST PROFILE
  Security           19  F    ##--------  conf  43%  low confidence range 9-62
  Maintenance        66  C+   #######---  conf  82%
  Code Quality       15  F    ##--------  conf  78%
  Supply Chain       21  F    ##--------  conf  56% range 12-55
  ...
WARNINGS
  - No security policy (SECURITY.md) detected.
  - No commit on the default branch for over a year.
  - No test files detected in the repository tree.
  - No license detected.
```

Read these with the [limitations](docs/limitations.md) in mind: for example, the identity engine called `junegunn/fzf` an "editor extension" at 30% confidence before its taxonomy gained command-line keywords, and "Code Quality 100" only means the process indicators (tests, lint config, typing, CI) were observed, not that the code is good. Full JSON examples live in [examples/](examples/).

## How it works

```text
Collectors -> Normalized Evidence -> Semantic Identity -> Rules (YAML) -> Dimension scores -> Profile -> CLI / JSON / Action
```

- **Collectors** (GitHub REST + raw files, OpenSSF Scorecard, OSV) produce typed, timestamped, provenance-carrying **evidence** with a confidence value.
- **Semantic Identity** classifies what the repository does from description, topics, manifests, README, dependencies and layout. The default classifier is a transparent keyword/structure heuristic that needs no API key; it sits behind an `IdentityClassifier` interface so an LLM classifier can be plugged in.
- **Rules** live in [standards/](standards) as YAML, one namespace per dimension, reviewable by pull request. Each rule names the evidence ids it reads, a weight and a scoring function. The engine contains no thresholds.
- **Scores** come with **coverage**, **confidence**, a **score range** and an **evidence trace**. Missing evidence never lowers a score; it lowers confidence. Correlated signals share one weight budget.
- **Profiles** change weights and advisory minimums only, never the evidence.

More: [architecture](docs/architecture.md) · [methodology](docs/methodology.md) · [evidence schema](docs/evidence-schema.md) · [scoring bias](docs/bias.md) · [security model](docs/security-model.md) · [limitations](docs/limitations.md) · [roadmap](docs/roadmap.md) · [authoring standards](docs/standards-authoring.md).

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

GitHub REST API · [OpenSSF Scorecard](https://github.com/ossf/scorecard) public API (Apache-2.0 project; only its published results are read) · [OSV](https://osv.dev) (advisory data under the licenses of each source database). Rule ideas draw on public work from OpenSSF (Scorecard, Best Practices, SLSA) and CHAOSS; no code or text from those projects is copied. Not yet integrated: deps.dev, OpenSSF Best Practices badge API (see roadmap).

## License

Apache-2.0, see [LICENSE](LICENSE).
