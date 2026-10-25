# GitHub Action parity

The Action is a preview consumer of the stable CLI contract. It always requests
JSON and passes the repository, profile, token, output path, code-scan switch,
profile enforcement, and score minimums.

| CLI capability | Action input | Decision |
| --- | --- | --- |
| `analyze OWNER/REPO` | `repository` | supported |
| `--format json` | implicit | supported and fixed |
| `--profile` | `profile` | supported |
| `--output` | `output` | supported |
| `--enforce-profile` | `enforce-profile` | supported |
| `--no-scan` | `code-scan=false` | supported |
| `--min DIMENSION=N` | `minimum-*` inputs | supported |
| `--token` / `GITHUB_TOKEN` | `github-token` | supported through environment only |
| `--ref` | none | intentionally unsupported in the Action preview |
| dependency/artifact/crypto/history switches | none | intentionally unsupported; avoid risky automation defaults |
| text output selection | fixed runner summary | intentionally unsupported |

The Action reports exit codes 0, 2, 3, and 4 distinctly. Gate 14 and human review
remain manual; this table does not imply release validation or accuracy validation.
