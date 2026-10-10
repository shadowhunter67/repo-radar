# Contributing

Thanks for helping. repo-radar has two kinds of contributions with different review needs:

- **Standards** (rules, profiles, identity taxonomy): data in `standards/` and `profiles/`. These encode what "good" means, so they
  need a rationale, sources and a bias note. Start with [docs/standards-authoring.md](docs/standards-authoring.md). Domain experts are
  especially welcome; the goal is that no single maintainer decides what good software means.
- **Engine and tooling** (collectors, scoring, CLI, Action): code in `src/`.

## Setup

```bash
git clone <your fork>
cd repo-radar
npm ci
npm run check      # typecheck + eslint + prettier --check + vitest (offline)
```

Node.js 20 or newer. Tests never use the network; use the fake GitHub helpers in `tests/helpers/` (`goodRepo()`, `emptyRepo()`, ...)
and extend them rather than mocking `fetch` by hand.

## Ground rules

1. **Transparency first.** Every score must be traceable to evidence ids. Do not add logic that produces a number without a rule behind it.
2. **Missing evidence is not negative evidence.** Do not emit `false` for something you could not fetch; emit a diagnostic with `affects`.
3. **Never execute analyzed code** and never fetch repository-controlled URLs. Read [docs/security-model.md](docs/security-model.md) before touching `src/util/http.ts` or collectors.
4. **Careful wording.** Reports describe observations and confidence ("no test files detected"), never verdicts ("safe", "secure", "AI-generated", "trustworthy").
5. **Tests with every behavior change**, including the unhappy path (rate limit, missing data, hostile input). A bug fix starts with a failing test.
6. **Evidence ids are an API.** Adding one: document it in `docs/evidence-schema.md` (a test checks this). Renaming or removing one is a schema change.
7. Run `npm run schemas` if you touch a zod schema and commit the result; CI fails on drift.

## Pull requests

- Keep them focused; fill in the PR template (it asks for methodology impact when rules change).
- Commit messages: short imperative subject; explain the *why* in the body.
- Dependency additions need a justification; the runtime dependency list is deliberately tiny.

## Code style

TypeScript strict mode, ESLint (typescript-eslint), Prettier (`npm run format`). Prefer small pure functions; collectors return data, they do not score.

## Conduct and security

Be kind: see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Report vulnerabilities privately: see [SECURITY.md](SECURITY.md).
