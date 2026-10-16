# External domain intelligence (0.7)

`external_domains` lists the hostnames the analyzed repository's own files REFER to, with the context of each reference. It is static text analysis of the files the scan already fetched (workflows, manifests, scripts, build files, a source sample). **A hostname in a file is a reference, not a connection**: nothing is observed, no host is resolved (no DNS), no request is ever made to an observed host, and the finding wording says so.

`--no-domains` skips it. It needs the code scan (`--no-scan` leaves `status: not_scanned`).

## What is extracted

URLs with the schemes `http`, `https`, `ws`, `wss`, `ftp`, `ftps`, `sftp`, `ssh`, `git`; scp-style `git@host:path`; and a **bare host with a path or port after a fetch command** (`curl -sSL get.vendor.io/install.sh | sh`, `wget mirror.vendor.io:8080/f`) at slightly lower confidence. A bare file name (`curl install.sh`) is not a host. Lifecycle command strings of install hooks (the `postinstall` text itself) are read with the hook's context.

Not extracted (documented limits, counted in the labeled set): container image references without a scheme (`image: ghcr.io/org/svc`), `s3://` / `gs://` buckets, hosts built at run time (`"https://" + host`), hosts in files the scan did not fetch (README and documentation are not fetched), and anything in a binary.

## Normalization

Hostnames come out lower-case, without a trailing dot, with IDN converted to punycode (`url.hostname`), with the port and scheme kept separately. The text as written is kept in `display`. **Credentials in a URL are dropped** (`credentials_in_url: true` is the only trace). Template variables (`${HOST}`, `$HOST`, `%s`) and malformed hosts are counted in `unparsed`, never guessed.

Homoglyphs: `ambiguity` is `punycode`, `unicode` or `mixed_script` (a label mixing Latin with Cyrillic or Greek, for example). This is **informational**: look-alike names exist and so do legitimate internationalized domains. repo-radar makes no phishing judgement and never resolves the name.

## Categories (no DNS: by the name alone)

| Category | Examples | In `domains`? |
| -------- | -------- | ------------- |
| `generic_external` | `api.vendor.io` | yes |
| `registry` | `registry.npmjs.org`, `pypi.org`, `crates.io`, `proxy.golang.org`, `repo1.maven.org`, `cdn.jsdelivr.net` | yes |
| `github` | `github.com`, `api.github.com`, `raw.githubusercontent.com`, `ghcr.io` | yes |
| `telemetry` | `*.sentry.io`, `google-analytics.com`, `segment.io`, `telemetry.*` | yes |
| `ip_literal` | a public IPv4/IPv6 address | yes |
| `localhost` | `localhost`, `127.0.0.0/8`, `::1`, `0.0.0.0` | counted in `filtered`, not listed |
| `private_address` | RFC 1918, link-local, CGNAT, ULA, single-label names (`db`), `*.local`/`*.internal`/`*.lan`; the cloud metadata endpoints carry the note `cloud_metadata_endpoint` | counted |
| `documentation_example` | `example.com/net/org`, `*.example`, `*.test`, `*.invalid`, the RFC 5737 ranges, a few common placeholders | counted |

## Contexts

`install` (a file on the path of an install hook, or with an install-time detection), `build`, `release`, `ci`, `container`, `runtime` are ACTIVE (code that can run). `metadata` (a manifest's homepage/repository/author URLs; the manifest file itself is metadata even when it holds the install script), `test`, `docs` and `comment` (a line comment, a `/* */` or JSDoc block, a Python docstring) are PASSIVE. The strongest context among a host's references wins (`install > build > release > ci > container > runtime > unknown > metadata > test > docs > comment`).

Confidence is by context (install 0.85, build 0.7, release/CI/container 0.65, runtime 0.6, metadata 0.3, docs/test 0.2, comment 0.1), minus 0.1 for a bare host. An install or build reference in a file with no network behaviour detected (a funding message printed by a postinstall script) loses another 0.3: the reference is real, the behaviour is not evidenced.

## Findings, facts, events

Findings (`RR-DOM-*`, category `domain`): an install-time reference to a non-registry, non-GitHub host (medium when confidence is at least 0.7, otherwise low), a public IP literal in an active context (low), punycode/Unicode/mixed-script names (info), a telemetry host in install/build code (low). Facts: `domains.external.count`, `domains.active.count`, `domains.install_time.present`, `domains.ambiguous_names.present` - a "none found" is a fact only when the scan read enough code.

In a revision diff ([history.md](history.md)): `external_domain_introduced`, `external_domain_removed` and `external_domain_context_changed`, only for ACTIVE changes and only when the change is observed (a removal is `inconclusive` when either tree or scan was incomplete). A new host that appears only in docs, tests, metadata or comments is reported in the diff as passive and does not become a timeline event: an install-time host with confidence 0.85 and a README mention are not the same observation. They join the correlations of [governance.md](governance.md) (`release-with-new-capability-or-domain`, `dependency-publisher-change-then-new-domain`).

Trust graph: `ExternalDomain` nodes and `CONNECTS_TO` edges (meaning "a file refers to this host", with the confidence, evidence `domain:<host>` + `file:line`, and for a diff `introduced_at` / `removed_at` from the head commit date, never the analysis time).

## A real revision pair

`lovell/sharp` v0.32.6 -> v0.33.0 (`calibration/results/domain-history-probe-sharp-0.32.6-0.33.0.json`, comparable, nothing tuned): the install step stopped downloading prebuilt libvips from `github.com` and moved to optional npm packages. The diff reports `github.com` as `context_changed` from `install` to `release` (passive: the move is out of an active install path into a release helper `npm/from-github-release.js`), a risk DECREASE reason "external host github.com is no longer referenced at install time", the execution path `npm install -> install/libvips.js ... => install/check.js ...`, two passive removals (a test-only and a comment-only host), and one active introduction: `www.apache.org` referenced in release context at `npm/from-github-release.js:31` - an observation that is accurate (a reference in code) and, as the report says, not a connection and not an indicator by itself. This was the only real pair tried, and it is not a case of a new install-time host; no such real pair was found, so the introduction path is exercised by the labeled synthetic revision pairs instead (`calibration/domains-synthetic.json`) rather than by a weak real-world claim.

## Safety of the extractor

Every line is cut at 2,000 characters before any regex runs; patterns have bounded repetition (URL: 1-300 characters); at most 80 references per file, 3,000 observations and 600 distinct hosts per run, 300 reported; a test feeds 200 KB URL literals, 500 KB lines and 5,000-label hosts. A host is never requested.

## Labeled evidence

`calibration/domains-synthetic.json`: 32 hand-labeled snippets and 8 revision pairs, labeled before the extractor was run on them. 23 true positives, 0 false positives, 2 false negatives (precision 1.00, recall 0.92); the two misses are documented limits (a container image reference without a scheme, an `s3://` bucket). They are synthetic: they say nothing about real repositories.

Real repositories (`calibration/results/domain-probe.md`, 2026-10-13, not tuned on): puppeteer, sharp, core-js, esbuild, husky, node-sass, prisma, playwright. Reading the listing by hand, the first run showed four defects that were fixed and re-run: block-comment state was lost on one-line `/**` and `*/` lines (JSDoc URLs and license headers read as `runtime`), Python docstrings were `runtime`, a manifest that holds the install script made its homepage/author URLs `install` (node-sass), and a postinstall that only PRINTS funding links (core-js) had the same confidence as one that downloads. What remains expected: URLs in CI workflows and Makefiles are mostly `github.com` / `registry.npmjs.org` (category-flagged, not findings); runtime references in code are real references to documentation or vendor APIs and say nothing about whether they are called.
# Dependency and build contexts (0.9)

Artifact hooks and build-system URLs use `dependency_install`, `dependency_build`, `dependency_runtime`, and `build` contexts. Domains are observed strings only; no dependency domain is contacted or resolved.
