# Getting started

From zero to a first local report in a few minutes.

```text
Try the Web Quick Scan  ->  understand findings and evidence  ->  install locally  ->  Deep Scan for higher coverage
```

## 0. Try it without installing anything

Open the hosted Quick Scan preview: **https://repo-radar-kcd0.onrender.com**. Paste a public GitHub repository, for example
`sindresorhus/is-plain-obj`. It is a bounded, temporary preview on a free host (the first request after a quiet period can take
a minute). See [web-analyzer.md](./web-analyzer.md).

## 1. Install

repo-radar is **not published to the npm registry yet**, so there is no `npm install -g repo-radar` or `npx repo-radar`. Use one
of the two methods below. Both need Node.js 20.17 or newer.

### From a release (gives you the `repo-radar` command)

Every GitHub release attaches the package tarball. Install it directly from the release URL:

```bash
npm install -g https://github.com/shadowhunter67/repo-radar/releases/download/v0.18.0/repo-radar-0.18.0.tgz
repo-radar --version
```

Newer versions are listed on the [releases page](https://github.com/shadowhunter67/repo-radar/releases); replace the version in
the URL. The tarball carries a GitHub build-provenance attestation. To verify it before installing, download the tarball and run
`gh attestation verify repo-radar-0.18.0.tgz --repo shadowhunter67/repo-radar` (and compare it with `SHA256SUMS` from the
same release). Installing into a project instead of globally works the same way without `-g`; the command is then
`npx repo-radar` inside that project.

### From a source checkout

```bash
git clone https://github.com/shadowhunter67/repo-radar.git
cd repo-radar
npm ci
npm run build
node dist/cli.js --version        # or `npm link` once to get the repo-radar command
```

In the examples below `repo-radar` means either the installed command or `node dist/cli.js` in a checkout.

## 2. First analysis

```bash
export GITHUB_TOKEN=...            # optional, read-only; raises the GitHub rate limit. Never put it on the command line.
repo-radar analyze sindresorhus/is-plain-obj
```

The text report shows the score, confidence and evidence coverage as separate things, the exact commit that was read, the
findings with their evidence, and what could not be observed.

## 3. Quick or Deep

```bash
repo-radar analyze owner/repo                         # Quick (default): fast, bounded screening
repo-radar analyze owner/repo --mode deep             # Deep: larger retrieval budgets, still bounded
```

The two modes run the same analysis and the same scoring; Deep only reads more. See [deep-scan.md](./deep-scan.md).

## 4. A reproducible report

```bash
repo-radar analyze owner/repo --ref <exact-40-hex-sha> --mode deep --format json --output report.json
```

Pin the exact commit, keep the JSON file, and record the repo-radar version (`repo-radar --version`); the report itself carries the
schema and methodology versions. JSON is meant for automation, archival and downstream tools. See
[reproducibility.md](./reproducibility.md) for what is and is not repeatable (registries and advisories describe the present and
can change).

## 5. Next

- Every command and option: [cli.md](./cli.md)
- What a score does and does not mean: [methodology.md](./methodology.md), [limitations.md](./limitations.md)
- Running the web analyzer yourself: [deployment.md](./deployment.md)
