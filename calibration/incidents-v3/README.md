# Incident corpus v3

This corpus is frozen for review and uses only pinned artifact pairs. Expectations were read independently from the
fixture tarballs; production inspection is used only by the evaluator. Every case is `ai_assisted_unreviewed` and
requires Gate 14 manual review. No `--final` evaluation has been run.

The two fresh holdout-assigned packages are `@ctrl/tinycolor` and `faker`; their holdout outcomes are intentionally not
inspected here. Packages whose v1/v2 holdouts are spent remain excluded from fresh holdout metrics. Synthetic plumbing
cases are excluded from all accuracy metrics.

Reviewer evidence recorded 2026-10-21: nearly all known malicious npm releases in the candidate set are unpublished and
return 404 (including event-stream 3.3.6, flatmap-stream 0.1.0-0.1.2, ua-parser-js 0.7.29, colors 1.4.1/1.4.2,
node-ipc 10.1.1-10.1.3, and others). faker 6.6.6 is the only still-downloadable malicious-ish candidate identified.
This is registry evidence, not a conclusion about the pinned artifact’s behavior.
