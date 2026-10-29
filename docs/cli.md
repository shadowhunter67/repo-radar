# CLI reference

`repo-radar --help` shows the first screen; `repo-radar analyze --help` lists every analyze option. This page groups them by task.

```bash
repo-radar analyze <owner/repo | https://github.com/owner/repo> [options]
```

## The options most people need

| Option | Meaning |
|---|---|
| `--mode quick\|deep` | Retrieval profile (default `quick`). Same analysis and scoring; only the budgets differ. See [modes.md](./modes.md) |
| `--ref <sha\|tag\|branch>` | Read the repository at this revision. Pin a 40-hex commit SHA for a reproducible report |
| `--format text\|json` | Output format (default `text`). JSON is for automation, archival and downstream tools |
| `--output <file>` | Write the report to a file |
| `--history` | Also collect bounded dependency-introduction history. Explicit and expensive; not implied by `--mode deep` |
| `--profile default\|startup\|enterprise` | Scoring profile |

Environment: `GITHUB_TOKEN` (optional, read-only) raises the GitHub rate limit; it is never logged or stored.

## Policy and CI use

`--min <key>=<0-100>` (repeatable) and `--enforce-profile` make the command exit 2 when a floor is not met. Exit codes: `0` ok,
`1` internal error, `2` policy failed, `3` repository not found, `4` service unavailable or rate limited, `64` usage error. Usage
errors are answered locally and never touch the network.

## Optional collectors and advanced options

Switches for individual sources and budgets are advanced and live in `repo-radar analyze --help`:

- skip a source: `--no-scorecard`, `--no-osv`, `--no-deps-dev`, `--no-registry`, `--no-dep-registry`, `--no-releases`, `--no-sbom`, `--no-compliance`, `--no-domains`, `--no-scan`
- expensive and opt-in: `--verify-crypto`, `--verify-assets`, `--inspect-dependency-artifacts`, `--name-intelligence`, `--history`
- dependency lookup budget overrides: `--dep-registry-max`, `--dep-registry-requests`, `--dep-registry-time` (Quick and Deep set these for you)
- your own trust material: `--trust-config`, `--trust-gpg-key`, `--trust-minisign-key`, `--expect-signer`
- stored snapshots: `--snapshot-dir`, `--snapshot-revision`
- output: `--text-output`, `--verbose`, `--ascii`

## Other commands

`diff` (compare two revisions or two JSON reports), `model`, `graph`, `snapshots`, `batch`, `profiles`, `rules`, `--version`.
repo-radar is static: it never installs or runs the code it analyzes.
