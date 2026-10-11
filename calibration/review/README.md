# Human review of calibration labels

Release gate 14 ("labels reviewed by a human") is **MANUAL** on purpose. The current labels come from one AI-assisted
reviewer. This directory contains everything a human needs to review them **blind**, and the tooling to compare and
adjudicate afterwards. Nothing here records a review on anyone's behalf, and no script marks the gate as satisfied.

## Workflow

1. **Generate packets** (maintainer): `node scripts/make-review-packets.mjs --corpus calibration/fresh-holdout-0.4`
   writes `calibration/review/<corpus>/packets/<owner>__<repo>.json`. A packet holds the repository, the exact pinned commit,
   a browsing link at that commit, the files worth reading, and an **empty label form**. It contains no repo-radar output and
   none of the existing labels.
2. **Review blind** (reviewer): read the pinned source (browse link, or clone and `git checkout <commit>` in a throwaway
   directory; never install, build or run the repository). Fill the form into `<owner>__<repo>.yaml` using the field
   definitions below. Do **not** run repo-radar on the repository and do not open `calibration/**/labels/` before finishing.
3. **Submit**: put the filled files in a directory of your choice. Each file must start with `repository: owner/repo` and
   `reviewer: {id, kind: human-single|human-double, labelled_on}`.
4. **Compare** (maintainer, only after step 3): `node scripts/compare-reviews.mjs --corpus <corpus dir> --reviews <dir>`.
   It validates submissions against the schema and writes `adjudication-<reviewer>.md` with every decided disagreement and
   per-field agreement plus Cohen's kappa over yes/no pairs.
5. **Adjudicate**: see the policy below. Update the label files (change `review.kind`/`reviewers` for the fields a human
   confirmed) in a normal commit; the commit message names who decided.
6. **Gate 14** stays MANUAL. When a real human review is complete, a maintainer records it in the release issue; the gate
   script only prints that a review directory exists, never that the gate is passed.

## Field definitions (what to label)

All judgements are about the **pinned commit**, about **non-test, non-example, non-vendor source and build files**, and about
**what the code can do**, never about intent. Use `unknown` when you could not determine it with reasonable effort and
`disputed` when sources genuinely contradict each other. Both are excluded from metrics (and counted); they are never
penalized. Do not guess to avoid `unknown`.

| Field | Meaning |
| --- | --- |
| `artifact_type` / `artifact_also_acceptable` | What kind of software the repository's primary deliverable is. List other types you would also accept when the repository is genuinely ambiguous. |
| `domain` | What it is about (short slug). |
| `capabilities.*` | The capability exists in shipped source or build files: PROCESS_EXEC (spawns processes), NETWORK_CLIENT, NETWORK_SERVER, REMOTE_DOWNLOAD (fetches remote content to store or run), FILESYSTEM_WRITE, DYNAMIC_CODE_LOAD (eval, dynamic import of user code), CREDENTIAL_ACCESS (reads credential stores/keyrings), ENVIRONMENT_READ, BACKGROUND_PROCESS. Mentions in comments, docs or tests do not count. |
| `install_hooks.automatic` | Code that runs automatically when a **dependent** installs/builds this package (npm lifecycle scripts of a non-private package, `setup.py` when the build backend runs it, `build.rs`, ...). A private package, a dev-only `prepare`, or a console-script entry point is **not** automatic. |
| `persistence` | Code that installs itself to survive a restart (service units, cron, shell-profile edits, login items). Documentation about it does not count; container restart policies are not host persistence. |
| `hard_coded_secrets` | A real credential literal in shipped code/config. Test fixtures, placeholders and public-by-design client keys are `no` or `disputed` (say which in notes). **Never open or copy `.env` files.** |
| `dependencies.has_lockfile`, `lockfile_types`, `lockfile_scope` | Lockfiles that describe the project's own dependencies (`workspace` if one lockfile covers several packages). Lockfiles of examples/tests/docs projects do not count. |
| `dependencies.dependency_manifest_count`, `direct_dependency_count_expected` | Manifests declaring the project's dependencies (not examples/tests/tools) and the number of direct dependencies they declare (all relationships). Give `unknown` rather than a rough guess. |
| `dependencies.exact_version_expected` | A careful tool could assign an exact version to (nearly) all direct registry dependencies from this revision (needs a lockfile, SBOM or exact pins). |
| `dependencies.osv_checkable` | Enough exact versions exist that a vulnerability lookup is meaningful. |
| `dependencies.osv_expected_known_vulnerabilities` | Querying a vulnerability database for the exact versions would return at least one advisory. Only label it if you actually checked; otherwise `unknown`. |
| `dependencies.has_sbom`, `sbom_format`, `sbom_scope` | A valid CycloneDX/SPDX document is committed (not just a file with an SBOM-like name). `sbom_scope`: what it describes (`ci_workflow` for a document listing GitHub Actions rather than packages). |
| `dependencies.sbom_consistency` | Comparing the SBOM with the manifests/lockfile: `consistent` (direct runtime dependencies present with matching versions), `partial` (some missing or unverifiable), `mismatch` (a version contradicts the lockfile/pin), `unable_to_compare` (it describes something else or nothing comparable), `disputed`. |
| `dependencies.manifest_sbom_missing` / `sbom_extra_components` | Direct runtime dependencies absent from the SBOM / SBOM components that no direct dependency accounts for (normal for transitive packages; just say whether they exist). |
| `dependencies.auxiliary_dependency_presence` | Manifests under examples/, tests/, docs/, tools/ declare dependencies of their own. |
| `dependencies.dependency_scope_ambiguity` | It is genuinely unclear which manifest/lockfile defines "the" dependencies. |

## Examples

- A library whose root `package.json` has `"private": true` and a `postinstall`: `install_hooks.automatic: no` (it is never installed as a dependency).
- `console_scripts = tool = pkg.cli:main` in `pyproject.toml`: **not** an automatic hook; it is an entry point the user runs.
- An `sbom.spdx.json` that lists `actions/checkout@v4` and other workflow actions: `has_sbom: yes`, `sbom_scope: ci_workflow`,
  `sbom_consistency: disputed` (it says nothing about the package dependencies).
- Dependencies declared with ranges and no lockfile: `has_lockfile: no`, `exact_version_expected: no`, `osv_checkable: no`.

## Disagreement and adjudication policy

1. A field where both reviewers gave a decided value that differs is a **disagreement**. `unknown`/`disputed` on either side is
   not a disagreement (it is recorded as undecided).
2. Both reviewers re-read the pinned source for each disagreement **without** looking at repo-radar output. The adjudicated value
   is recorded with who decided and why (commit message and the worksheet).
3. If they still disagree, the field becomes `disputed` (excluded from metrics). Never pick the analyzer's answer to break a tie.
4. If the adjudication changes more than 15% of the comparable fields of a corpus, the corpus is treated as unreliable: re-label
   it with two independent human reviewers (`human-double`) before using it for any public claim.
5. Report inter-reviewer agreement (percent per field and Cohen's kappa) next to every published metric.

## Reviewer checklist

- [ ] I did not run repo-radar on these repositories and did not read the existing labels before finishing.
- [ ] I only read data at the pinned commit; I did not install, build or run anything.
- [ ] I did not open or copy any `.env` or credential file.
- [ ] Every `unknown` is a real "could not determine"; I did not guess.
- [ ] Notes explain every `disputed`, every ambiguous artifact type and every `sbom_consistency` verdict.


## Review submission fields (packet version 2)

Besides the label form a submission carries provenance, never personal data: a pseudonymous `reviewer.id` (an e-mail address is rejected), `reviewed_at` (ISO 8601), `label_version`, `repo_sha` (the commit you read; a submission for another commit than the pin is rejected, not compared), `independent` (you saw neither repo-radar output nor the existing labels), `decision_confidence` and per-field `field_confidence`, plus an optional `identity_v2` opinion (primary artifact, secondary roles, packaging, interfaces, deployment form). Several reviewers may submit for the same repository; their opinions are kept side by side. The comparison reports each field as `agreed`, `disagreed` (humans differ from each other), `needs_adjudication` (humans agree with each other but not with the existing label) or `uncertain` (undecided or low confidence). Contested fields are excluded from accuracy, and disagreements between analyzer and label are tagged `model_wrong`, `label_ambiguous` or `reviewers_disagree`: these are different problems and are never merged into one error rate. Nobody can mark gate 14 as satisfied by running these scripts.
