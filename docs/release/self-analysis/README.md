# Release-candidate self-analysis

repo-radar analyzed its own repository at the exact release-candidate commit
`436b3c2` (full SHA in `summary-436b3c2.json`) on 2026-10-25, authenticated, on the
private repository, with the default profile, `--name-intelligence` and
`--verify-crypto`. No history analysis and no artifact inspection were requested
(both are optional). The full report is 1.05 MB and is not committed;
`summary-436b3c2.json` is a compact extract that carries the report's
`integrity.report_sha256`, and `report-436b3c2.txt` is the text report. Neither file
contains tokens, user names or local paths (scanned).

Result: overall 88.7 (A-), confidence 0.82, weight covered 1.0 (these are
evidence-derived heuristics, not a safety probability). Source scan coverage was 21%
(40 of 189 source files; 149 candidates over the file budget), so every "not observed"
statement holds only within that sample. 115 HTTP requests (about one minute on this machine).

## Findings and how they were classified

| Finding | Classification |
| --- | --- |
| 3 x known advisories: vitest 3.2.7, @vitest/mocker 3.2.7, tinypool 1.1.1 (medium) | **True issue, dev-only.** Documented in docs/security-model.md; the vitest 5 upgrade conflicts on peer ranges and is deferred. Not shipped to users. |
| Persistence / CREDENTIAL_ACCESS / BROWSER_DATA_ACCESS capability (3 x medium) in `calibration/tools/dossier.mjs` | **Expected limitation (pattern strings, not behaviour).** The file contains regular expressions that *search other repositories* for paths such as `.ssh/` or `LaunchAgents`. The capability detector matches those tokens as text. Fixing this would need data-versus-code discrimination in the detector; not attempted and not tuned. |
| 18 low: maintainer-set and publisher-change indicators on dependencies | **Informational.** Governance anomaly is not compromise; these describe registry history of dependencies. |
| 6 info: release cadence, long gap, provenance reported, package-name notes | Informational. |
| `npm:repo-radar` not found in the npm registry | Expected: the package has not been published. |
| `typescript` and `@types/node` registry documents too large | Expected limit of the bounded registry reader (reported as unknown, not clean). |

## False positives found by self-analysis and fixed

The first self-run reported **197** "possible package-name confusion" findings because
`scope_confusion` fired for any scoped/unscoped pair (for example `openpgp` versus
`@eslint/js`). It now requires the same base name under a different scope. Same-scope
siblings (`@esbuild/linux-arm` versus `@esbuild/linux-arm64`) and hyphenated companion
packages (`typescript` versus `typescript-eslint`) no longer produce signals. Both have
regression tests (`tests/unit/name-intelligence.test.ts`). Scoring was not changed.

A second defect surfaced by the same run: for private repositories the static scan read
0% of the source because file contents came from the raw host, which never receives the
token. Private repositories now use the authenticated contents API (see
docs/support-policy.md).

## Policy

Default profile: no minimums and no blocks configured, so nothing to violate.
Enterprise profile with `--enforce-profile`: exit 2 because the profile requires a
committed SBOM (`sbom-required`) and repo-radar commits none (a CycloneDX SBOM is
generated per release as an artifact instead). This is a true observation against the
enterprise profile, not a defect.

## Release artifacts (hosted dry-run, run 40208607232, commit bb8a57f)

`repo-radar-0.16.0.tgz` (511 entries), `sbom.json` (CycloneDX 1.5, 212 components),
`release-metadata.json` and `SHA256SUMS` were produced on a GitHub-hosted runner and
the checksums verify from a clean directory. Attestation was skipped by design in
dry-run mode; it has not been exercised.
