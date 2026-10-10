# AGENTS.md: repo-radar

Shared notes for any AI agent working in this directory (Claude Code, Codex, others). Read [CONTRIBUTING.md](CONTRIBUTING.md) and
[docs/architecture.md](docs/architecture.md) first.

## Commands

```bash
npm ci                # install (Node >= 20)
npm run check         # typecheck + eslint + prettier --check + vitest; all offline
npm run build         # tsc -> dist/
npm run bundle        # esbuild single file for the GitHub Action (dist/action/repo-radar.mjs)
npm run schemas       # regenerate schemas/*.json from zod (a test fails if they drift)
node dist/cli.js analyze owner/repo --no-scan   # skip static capability/execution/secret analysis
node dist/cli.js analyze owner/repo [--format json] [--profile enterprise] [--verbose]
```

## Invariants (tests enforce most of them)

- Never execute or install anything from an analyzed repository; never fetch repository-controlled URLs. Only `src/util/http.ts` touches the network.
- Missing evidence is not negative evidence: no `false` for things that could not be fetched; emit a diagnostic with `affects`.
- Rules are data in `standards/`; the engine has no thresholds. Every scored rule must trace to evidence ids.
- Repository-controlled strings are sanitized before reaching the terminal. Regexes over repository text must have bounded input and look-ahead.
- Capability is not intent: detections and findings state what code can do, with confidence; never "malicious"/"safe". Findings carry `intent: "undetermined"`.
- "Nothing found" is evidence only when enough code was read (`ABSENCE_MIN_COVERAGE`, `ABSENCE_MIN_FILES` in `src/facts`); thin scans make rules unobserved, never full marks.
- Never put a secret value in a report: redact at detection time (`src/analysis/secrets.ts`).
- New rules should read normalized facts (`src/facts`), not raw collector ids; every limit lives in `src/limits.ts`.
- Wording: observations and confidence, never verdicts ("safe", "secure", "AI-generated", "trustworthy").
- Tests use the fakes in `tests/helpers/` and never the network. Do not read or print secret files.

## Dependencies installed (keep this list current)

Runtime: `zod` (schemas + JSON Schema generation), `yaml` (workflow/standards parsing, core schema), `smol-toml` (pyproject/Cargo parsing).
Dev: `typescript`, `vitest`, `eslint` + `typescript-eslint` + `@eslint/js`, `prettier`, `esbuild`, `@types/node`.
Adding a runtime dependency needs a justification in the PR.
