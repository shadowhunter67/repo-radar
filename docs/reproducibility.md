# Reproducibility

What repo-radar promises about repeating an analysis, and what it does not.

## What is deterministic

For **frozen evidence** (the same repository files at the same commit, the same mocked or recorded upstream answers, the same
configuration, the same clock) the report is identical, including `integrity.report_sha256`, whatever order the concurrent
collectors finish in. `tests/unit/determinism.test.ts` enforces this by shuffling the completion order of every upstream request
over many seeded iterations, with every source enabled.

Causes of order dependence that were found and fixed in 0.18:

- the scanned files were collected in network-completion order (and the scan budget was checked at completion); they are now
  budgeted in a fixed queue order and sorted by path, which also fixes the order of `external_domains` observations;
- diagnostics were emitted in completion order; they are now sorted by source, code, message, level and affected items.

Ordered collections where the order carries meaning (for example dimension and rule lists in their defined order) are not sorted.

## What is canonicalized

`integrity.report_sha256` is the SHA-256 of the report without the `integrity` field, serialized as **canonical JSON**
(`integrity.format = "canonical-json@1"`): object keys sorted by UTF-16 code unit at every depth, arrays in their order, no
whitespace. It no longer depends on key insertion order. Reports written before 0.18 have no `format` and keep the legacy rule
(plain `JSON.stringify`), so stored snapshots still verify. The comparison is locale-independent and identical on every platform.

## What the hash means

It identifies the canonical content of one report and detects accidental or unauthorized edits of a stored copy. It is not a
signature, does not say who produced the report, and says nothing about whether the repository or the report is trustworthy.

## What stays mutable

Two **live** runs of the same commit are not byte-identical, for two honest reasons:

1. the report contains time stamps (`generated_at`, evidence `observed_at`, source `retrieved_at`), which are part of the content
   and therefore of the hash;
2. registry, vulnerability, Scorecard and similar sources describe _current_ state; their answers can change without any change
   to the repository. The report records for each external source when it was read and whether it is tied to the commit
   (`revision_bound`) or to current state (`current_state`).

A live check (five CLI runs of `spf13/cobra` at one exact commit, 2026-10-28) gave five different `report_sha256` values and five
identical digests of the report with time stamps removed, the same score (83.5) and the same 40 GitHub requests. That shows the
engine contributes no ordering noise on that input; it does not prove live upstreams are immutable.

## Reproducing a result

The result page shows the exact command, for example `node dist/cli.js analyze owner/repo --ref <40-hex sha> --format json`
(from a clone after `npm ci && npm run build`). The same commit and configuration reproduce the evidence that is tied to the
commit; sources that describe current state may differ, and the time stamps will.
