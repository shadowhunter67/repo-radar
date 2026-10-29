# Deep Scan guide

```bash
repo-radar analyze owner/repo --ref <exact-sha> --mode deep --format json --output report.json
```

## What Deep changes

Deep reads **more**: up to 200 source/script/build files instead of 40, files up to 128 KiB instead of 64 KiB, up to 12 MiB of
scanned bytes instead of 2 MiB, one more round of following script references, and up to 150 dependency registry lookups instead
of 25 (with larger request, time and byte budgets for them). The exact table is in [modes.md](./modes.md).

## What Deep does not change

The facts, rules, scoring, finding semantics, report schema and methodology are the same as in Quick. If both modes observe the
same evidence they reach the same conclusion about it. Deep still never installs or executes the target repository, and it does
not switch on the expensive optional collectors (history, artifact inspection, cryptographic verification): those keep their
own flags.

## Why it can still be partial

Deep is bounded, not unlimited. A repository with thousands of source files or hundreds of dependencies will still hit a budget,
and some registry responses are too large to accept. The report then says which budget was reached and how many items were left
out, exactly as in Quick, and the coverage figures show how much was actually read. Partial describes how much evidence could be
gathered; it does not mean the repository is worse, and a complete result is not a safety verdict.

## Resource implications

More requests and more time than Quick (one observation: a 401-file repository took about 26 s in Quick and about 63 s in Deep, with
129 and 414 requests respectively; this is not a benchmark). Set `GITHUB_TOKEN` to avoid the unauthenticated GitHub rate limit.
The report can be a few megabytes.

## History stays optional

`--history` adds bounded dependency-introduction history and can cost hundreds to thousands of GitHub requests. It is a separate,
explicit switch so a normal Deep scan never spends them by surprise.

## Reproducibility

Pin the exact commit with `--ref <sha>`, keep the JSON report, and record `repo-radar --version`. The report carries the schema and
methodology versions and the retrieval budgets that applied. Registry and advisory data describe the present and can change
between runs; see [reproducibility.md](./reproducibility.md).

## From the web preview

The hosted Quick Scan shows a Deep Scan call to action with the exact command for the analyzed commit when a result is partial or
the source coverage is low. Deep is not available on the hosted service; run it locally ([getting-started.md](./getting-started.md)).
