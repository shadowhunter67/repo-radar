# Regulatory readiness

`repo-radar` reports **technical facts relevant to regulation**, not legal conclusions. Nothing in the `regulatory` section is legal advice, a certification, or a statement that a product is or is not compliant. Every report carries `regulatory.legal_determination: "not_provided"` and the disclaimer text from `src/compliance/disclaimer.ts`.

## Model

1. **Facts** come from the normal analysis (dependencies, SBOM, execution, capabilities, governance) plus technical indicators for privacy and AI use (`src/compliance/indicators.ts`). An indicator is `observed` only with evidence; "absent" is only claimed when the code scan was reliable. A fact that was not collected is _unknown_, never _false_.
2. **Applicability** (`src/compliance/applicability.ts`) evaluates a pack's conditions with three-valued logic (`all` / `any` / `not` over leaves such as `artifact_type`, `domain`, `ecosystem`, `capability`, `dependency`, `execution`, `distribution`, `ai`, `privacy`, `fact`, `path`, `finding`, `context`). Result states: `applicable`, `not_applicable`, `potentially_applicable`, `unknown`. A condition that needs context the tool cannot see (for example "placed on the EU market") caps at `potentially_applicable`.
3. **Readiness** lists, per requirement, whether technical evidence exists (for example SBOM present, vulnerability handling file, lockfile), with evidence ids. Missing evidence is "not observed".

## Packs

`standards/regulatory/eu-cra.yaml` and `eu-ai-act.yaml` are versioned (`0.1.0`), carry `status: indicative`, a source reference and a review date. Their digest is part of `methodology.config_digest`, so a changed pack changes the report fingerprint. Packs are validated on load: schema, unique ids, and every regular expression passes `safeRegExp` (catastrophic patterns such as `^(a+)+$` are rejected; inputs are truncated to 300 characters). `--no-compliance` skips the section.

## What it does not do

- It does not decide whether a law applies to an organisation, an economic operator role, a product classification or a conformity route.
- It does not interpret code intent; a privacy or AI indicator is a capability observation.
- It does not replace legal review. Pack content is `indicative` until reviewed by qualified counsel.

## Policy blocks

Profiles can declare `block:` rules that reuse the same condition language and `on_unknown: ignore|block`. Violations are reported in `policy.block_violations` and produce exit code 2 only with `--enforce-profile`. Unknown does not block unless the rule says so.
