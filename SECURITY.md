# Security policy

## Supported versions

Only the latest released minor version of repo-radar receives security fixes (currently 0.2.x).

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability reporting for this repository
(Security tab -> "Report a vulnerability"). If that is unavailable, open a minimal public issue that says only
"security contact requested" (no details) and a maintainer will arrange a private channel.

Please include the version (`repo-radar --version`), what you did, and what you expected. We aim to acknowledge reports
within a week; this is a volunteer project and no bug bounty exists.

## Scope

In scope: anything that lets an analyzed repository, or a response from GitHub / OpenSSF Scorecard / OSV, cause code execution,
file access outside what the user asked for, requests to unintended hosts, token disclosure, terminal escape injection,
or unbounded resource use in repo-radar.

Out of scope: a repository receiving a score you disagree with (open a normal issue or a standards proposal), vulnerabilities
in the analyzed repositories themselves, and the deliberate behaviors listed under "Deliberate non-controls" in
[docs/security-model.md](docs/security-model.md).

## Design

repo-radar is read-only and never executes analyzed code; the threat model and controls are in [docs/security-model.md](docs/security-model.md).
If you use the GitHub Action, give it the default read-only `GITHUB_TOKEN`; it needs no write permissions.
