# Policy as code

Profiles (`profiles/*.yaml`) can carry four kinds of rules. All are enforced only with `--enforce-profile` (exit code 2). **Unknown never blocks** unless the rule says so (`on_unknown: block`, or `strict` in `require`).

```yaml
require:                       # compiled into blocks
  checksums: true
  sbom: true
  signed_release: true         # GitHub-verified tag OR a signature asset
  provenance: true             # an attestation exists (not verified)
  verified_provenance: strict  # needs --verify-crypto; strict also blocks when it was not run
  verified_source_binding: true
  registry_repository_match: true   # blocks on conflicting or missing
  publisher_stability: true         # a recent version by an account new to the sampled history
  # 0.7 - none of these is in a shipped profile:
  locally_verified_signature: true            # needs --trust-* keys or --verify-crypto; unknown otherwise
  dependency_registry_match: true             # a queried dependency has conflicting or missing source pointers
  dependency_publisher_stability: true        # a relevant dependency version by an account new to its history
  dependency_provenance_reported: true        # every queried npm dependency REPORTS provenance (not verified)
  no_dependency_takeover_indicators: strict   # a takeover pattern on one dependency
block:                         # conditions over facts, findings, capabilities (as before)
  - { id: no-install-time-remote-execution, description: '...', when: { fact: { id: execution.chain.install_time, equals: true } } }
history_block:                 # over the difference between two revisions (diff owner/repo --from A --to B)
  - { id: no-new-install-hook, description: '...', kind: new_install_hook }
  # kinds: new_vulnerability, new_install_hook, new_install_time_remote_execution, new_capability (capability: X),
  #        new_git_or_path_dependency, takeover_indicators_with_new_install_hook,
  #        new_install_time_domain, provenance_verification_lost, source_binding_conflict   (0.7)
temporal_block:                # over event correlations (see governance.md)
  - { id: new-publisher-release, description: '...', pattern: new-publisher-then-release }
  - id: custom
    description: 'a commit burst then a release within two days'
    pattern: { id: burst-release, description: 'commit then release', steps: [{ any_of: [commit] }, { any_of: [release] }], within_days: 2 }
```

Facts are emitted only when the evidence behind them exists: verification facts (`release.provenance.verified`, `release.source_binding_verified`, `release.assets.checksum_verified`) exist only when `--verify-crypto` / `--verify-assets` ran; registry facts exist only when every lookup worked; a failed lookup is `unknown`.

The `enterprise` profile keeps its previous blocks and adds `require: { checksums: true }` and three `history_block` rules (documented in the 0.5 migration). Stricter requirements are intentionally NOT enabled there: adding `verified_provenance` or `registry_repository_match` to a shipped profile would change the exit code of existing users, so they are examples to copy into your own profile. Organization-level configuration can later supply the same objects.

## Unknown, strict and the 0.7 signals

`true` blocks only when the evidence says the requirement is not met; `strict` also blocks when it cannot be decided. For the dependency requirements "cannot be decided" has a precise meaning: the fact is absent because a lookup failed, was skipped by the budget, or the registry was not queried (`--no-registry`). A skipped dependency never reads as stable. `locally_verified_signature` is unknown unless you configured trust (`--trust-*`) or ran `--verify-crypto`. `publisher_stability` keeps its meaning (the packages THIS repository publishes); the dependency version is a separate key on purpose, so enabling one never changes the other. The `temporal_block` patterns `dependency-takeover-indicators`, `dependency-dormancy-publisher-hook`, `dependency-publisher-change-then-new-domain` and `provenance-loss-then-release` are built in.

The shipped profiles (`default`, `startup`, `enterprise`) do not use any 0.7 key: enabling one would change the exit code of existing users, so a migration is a decision to make with calibration data (`docs/migration.md`).
