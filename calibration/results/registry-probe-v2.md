# Registry probe: registry-probe-v2

Lookup time 2026-10-11T11:16:57.742Z (registry state is current-state; publish times are history). Sequential.

## BurntSushi/ripgrep @ 3fce3b5bb0236da2df6d99672afb8a719642eca7

- 7696 ms; registry requests 8; status analyzed
- **crates.io:ripgrep** (declared by Cargo.toml): ok; repository **confirmed** (registry repository URL is the analyzed repository); latest 15.2.0; 59 versions; newest 2026-07-15 by BurntSushi; maintainers now 1; provenance unknown
- **crates.io:grep-cli** (declared by crates/cli/Cargo.toml): ok; repository **confirmed** (registry repository URL is the analyzed repository); latest 0.1.12; 13 versions; newest 2025-10-16 by BurntSushi; maintainers now 1; provenance unknown
- **crates.io:globset** (declared by crates/globset/Cargo.toml): ok; repository **confirmed** (registry repository URL is the analyzed repository); latest 0.4.20; 29 versions; newest 2026-08-04 by BurntSushi; maintainers now 1; provenance unknown
- **crates.io:grep** (declared by crates/grep/Cargo.toml): ok; repository **confirmed** (registry repository URL is the analyzed repository); latest 0.4.1; 29 versions; newest 2025-10-22 by BurntSushi; maintainers now 1; provenance unknown
  - signal dormancy_then_publish [publish_history] version 15.0.0 was published 402 days after the previous one
  - signal cadence_change [publish_history] the newest gap (266 days) is far above the earlier median (20 days)
  - signal dormancy_then_publish [publish_history] version 0.1.12 was published 402 days after the previous one
  - signal dormancy_then_publish [publish_history] version 0.4.0 was published 402 days after the previous one

## pydantic/pydantic-core @ 383eb95a19433754c0cecf7025b50c26b6d97a36

- 5728 ms; registry requests 3; status analyzed
- **crates.io:pydantic-core** (declared by Cargo.toml): not_found (package not found); repository **unknown** (registry lookup did not succeed; correspondence unknown); latest null; 0 versions; newest undefined by n/a; maintainers now 0; provenance unknown
- **npm:pydantic-core** (declared by package.json): not_found (package not found); repository **unknown** (registry lookup did not succeed; correspondence unknown); latest null; 0 versions; newest undefined by n/a; maintainers now 0; provenance unknown
- **pypi:pydantic_core** (declared by pyproject.toml): ok; repository **conflicting** (registry names another repository (pydantic/pydantic)); latest 2.50.0; 160 versions; newest 2026-10-08 by n/a; maintainers now 0; provenance unknown
  - signal repository_mismatch [current_state] registry names another repository (pydantic/pydantic)

## pallets/flask @ d086db856be187255b8ec61ef409357393020f32

- 6536 ms; registry requests 1; status analyzed
- **pypi:Flask** (declared by pyproject.toml): ok; repository **confirmed** (registry repository URL is the analyzed repository); latest 3.1.3; 64 versions; newest 2026-02-19 by n/a; maintainers now 0; provenance unknown
  - signal cadence_change [publish_history] the newest gap (183 days) is far above the earlier median (29 days)

## axios/axios @ f694ecd6ac49bb1917e086b5e532e1627c62d43a

- 3609 ms; registry requests 1; status analyzed
- **npm:axios** (declared by package.json): ok; repository **confirmed** (registry repository URL is the analyzed repository); latest 1.20.0; 145 versions; newest 2026-09-16 by GitHub Actions; maintainers now 1; provenance yes
  - signal provenance_present [publish_history] the registry reports a provenance attestation for 1.20.0 (not verified here)

## lodash/lodash @ 2b5e6f7399a7b48005140b5d5c6bc6c0e62919a8

- 3292 ms; registry requests 0; status no_packages

