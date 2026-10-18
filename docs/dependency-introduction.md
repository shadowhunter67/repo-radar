# Dependency introduction and delta intelligence

The report records bounded, descriptive answers to when and through whom a dependency entered the analyzed revision. Direct dependencies come from the parsed manifest; transitive dependencies use the shortest known parent chain, capped by the introduction limits. `introduced_in_revision` is present only when an actually fetched history comparison proves first appearance. Otherwise the state is `unknown`.

Registry ages are current-state or retrieved-snapshot observations, not historical proof. `young_package_present` uses the documented 30-day threshold; release age and `introduced_before_first_publish_days` are numbers, not verdicts. Parent provenance is `verified`, `reported`, `none`, or `unknown` for the observed chain and is never inherited by a child.

Behavior and trust-boundary deltas compare two inspected versions of the same package only when both digests were verified. They cover observed install-hook capabilities and newly observed install/build domains, with file-and-line evidence. Unsupported file-level execution, native binary, `bin`, repository-host, and publisher-organization comparisons remain `not_available`; one-version reports emit no delta.

Use **observed** for collected facts, **reported** for registry claims, and **unknown** when coverage or verification is unavailable. These sections are risk indicators; they do not establish intent, safety, or compromise.
