# Authoring standards

> Experts contribute standards; the engine evaluates evidence.

Standards are YAML under `standards/<dimension>/` and are meant to be changed by pull request, ideally reviewed by people who
know that domain (for example security practitioners for `standards/security/*`). The engine never needs to change for a new rule
as long as the evidence it needs already exists.

## A rule

```yaml
- id: supply-chain.pinned-actions # <dimension>.<slug>; the prefix must match `dimension` and the directory
  dimension: supply-chain
  title: 'GitHub Actions pinned to commit SHAs'
  rationale: 'Tag references can be moved by the action owner; a full commit SHA cannot.' # required: why this matters
  evidence: [github.workflows.pinned_actions_ratio] # evidence ids, in preference order
  weight: 4 # 0-100, relative to other rules in the dimension
  group: pinned # optional: shares one weight budget with other rules of the same fact
  applies_when: { evidence: github.workflows.external_action_count, gt: 0 } # optional
  scoring: { type: linear, min: 0, max: 1 } # map | thresholds | linear
  warn: { below: 3, message: 'Actions are not pinned.' } # optional; {evidence.id} placeholders allowed
  limitations: 'Only GitHub Actions workflows are inspected.' # say who this could unfairly penalize
```

## Review checklist for a new or changed rule

1. **Is it evidence, not opinion?** The rule must read evidence ids that a collector produces, and the rationale should cite a public standard or practice.
2. **Direction.** Add the rule to the direction table in `tests/unit/regressions.test.ts` if higher or lower evidence values mean better or worse.
3. **Double counting.** Does another rule already measure the same fact? If yes in the same dimension, give both the same `group`. If in another dimension, move the fact to one place (see [bias](bias.md)).
4. **Missing data.** What happens when the evidence is absent? It is excluded and lowers confidence, which is usually right. Use `applies_when` only when absence is expected for a whole class of repositories.
5. **Fairness.** Name the repository kinds it could unfairly penalize in `limitations` (solo, new, libraries, other ecosystems).
6. **Weight.** Weights are relative within a dimension. Prefer small weights for weak or heuristic signals and `informational: true` (weight 0) for context.
7. **Wording.** Titles, rationales and warnings describe observations ("no test files detected"), never verdicts ("unsafe", "AI-generated").
8. Run `npm run check`. The standards tests verify that every evidence id exists, groups have at least two members, informational rules carry no weight, and the digest changes.

## Profiles

`profiles/<id>.yaml` sets `dimension_weights`, `rule_weights` (0 disables a rule) and advisory `minimums` (a dimension or `overall`). Rule ids in a profile are validated; a typo is an error.

## Identity taxonomy

`standards/identity/taxonomy.yaml` lists types with `keywords` (whole-word phrases), `deps` (exact names or `prefix*`), `topics` and `aliases`.
Keep keywords specific: a keyword that appears in unrelated READMEs causes misclassification. After changing it, try real repositories
(`repo-radar analyze owner/repo`) and add a test if you fix a misclassification.

## Versioning

Changing a rule, weight or threshold changes `methodology.rules_digest` automatically. Changing the *meaning* of the formulas or evidence bumps
`METHODOLOGY_VERSION` in `src/scoring/types.ts` and the `methodology:` header in every rules file.
