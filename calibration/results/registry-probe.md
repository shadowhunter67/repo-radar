# Registry probe: registry-probe

Lookup time 2026-10-11T09:13:22.280Z (registry state is current-state; publish times are history). Sequential.

## axios/axios @ f694ecd6ac49bb1917e086b5e532e1627c62d43a

- 33480 ms; registry requests 1; status analyzed
- **npm:axios** (declared by package.json): ok; repository **confirmed** (registry repository URL is the analyzed repository); latest 1.20.0; 145 versions; newest 2026-09-16 by GitHub Actions; maintainers now 1; provenance yes
  - signal provenance_present [publish_history] the registry reports a provenance attestation for 1.20.0 (not verified here)

## sindresorhus/got @ e1d87d2ced01d5b7d855a7dc8b091bf7b014a1e4

- 7317 ms; registry requests 1; status analyzed
- **npm:got** (declared by package.json): ok; repository **confirmed** (registry repository URL is the analyzed repository); latest 16.0.0; 201 versions; newest 2026-08-30 by sindresorhus; maintainers now 1; provenance no
  - signal provenance_missing [publish_history] the registry reports no provenance attestation for 16.0.0

## tj/commander.js @ ba6d13ddb4243e5913367734f8c159089ffe7834

- 4168 ms; registry requests 1; status analyzed
- **npm:commander** (declared by package.json): ok; repository **confirmed** (registry repository URL is the analyzed repository); latest 15.0.0; 124 versions; newest 2026-05-29 by abetomo; maintainers now 2; provenance no
  - signal provenance_missing [publish_history] the registry reports no provenance attestation for 15.0.0

## pallets/flask @ d086db856be187255b8ec61ef409357393020f32

- 5999 ms; registry requests 1; status analyzed
- **pypi:Flask** (declared by pyproject.toml): ok; repository **confirmed** (registry repository URL is the analyzed repository); latest 3.1.3; 64 versions; newest 2026-02-19 by n/a; maintainers now 0; provenance unknown
  - signal dormancy_then_publish [publish_history] version 2.0.0rc1 was published 378 days after the previous one
  - signal cadence_change [publish_history] the newest gap (183 days) is far above the earlier median (29 days)

## pallets/jinja @ 5ef70112a1ff19c05324ff889dd30405b1002044

- 3752 ms; registry requests 1; status analyzed
- **pypi:Jinja2** (declared by pyproject.toml): ok; repository **confirmed** (registry repository URL is the analyzed repository); latest 3.1.6; 52 versions; newest 2025-03-05 by n/a; maintainers now 0; provenance unknown
  - signal dormancy_then_publish [publish_history] version 3.1.3 was published 622 days after the previous one

## psf/requests @ 611c6162cbc4ac2020a2f91c7cfa4f3abf9bbb60

- 3469 ms; registry requests 1; status analyzed
- **pypi:requests** (declared by pyproject.toml): ok; repository **confirmed** (registry repository URL is the analyzed repository); latest 2.34.2; 163 versions; newest 2026-05-14 by n/a; maintainers now 0; provenance unknown
  - signal dormancy_then_publish [publish_history] version 2.32.4 was published 376 days after the previous one

## BurntSushi/ripgrep @ 3fce3b5bb0236da2df6d99672afb8a719642eca7

- 6827 ms; registry requests 8; status analyzed
- **crates.io:ripgrep** (declared by Cargo.toml): ok; repository **confirmed** (registry repository URL is the analyzed repository); latest 15.2.0; 59 versions; newest 2026-07-15 by BurntSushi; maintainers now 1; provenance unknown
- **crates.io:fuzz** (declared by fuzz/Cargo.toml): ok; repository **conflicting** (registry names another repository (pigeonhands/fuzz-rs)); latest 0.1.1; 2 versions; newest 2020-04-21 by pigeonhands; maintainers now 1; provenance unknown
- **crates.io:grep-cli** (declared by crates/cli/Cargo.toml): ok; repository **confirmed** (registry repository URL is the analyzed repository); latest 0.1.12; 13 versions; newest 2025-10-16 by BurntSushi; maintainers now 1; provenance unknown
- **crates.io:globset** (declared by crates/globset/Cargo.toml): ok; repository **confirmed** (registry repository URL is the analyzed repository); latest 0.4.20; 29 versions; newest 2026-08-04 by BurntSushi; maintainers now 1; provenance unknown
  - signal dormancy_then_publish [publish_history] version 15.0.0 was published 402 days after the previous one
  - signal cadence_change [publish_history] the newest gap (266 days) is far above the earlier median (20 days)
  - signal repository_mismatch [current_state] registry names another repository (pigeonhands/fuzz-rs)
  - signal dormancy_then_publish [publish_history] version 0.1.12 was published 402 days after the previous one

## sharkdp/fd @ 14dcd92fb76ca0ebc2e82671a275f67c790d25fc

- 4249 ms; registry requests 2; status analyzed
- **crates.io:fd-find** (declared by Cargo.toml): ok; repository **confirmed** (registry repository URL is the analyzed repository); latest 10.5.0; 39 versions; newest 2026-08-26 by tmccombs; maintainers now 3; provenance unknown
  - signal dormancy_then_publish [publish_history] version 10.3.0 was published 368 days after the previous one

## dtolnay/anyhow @ 2cbb4e1bcbf8e7015f8d8b04a291c4c0597030b4

- 3001 ms; registry requests 2; status analyzed
- **crates.io:anyhow** (declared by Cargo.toml): ok; repository **confirmed** (registry repository URL is the analyzed repository); latest 1.0.104; 106 versions; newest 2026-07-18 by dtolnay; maintainers now 1; provenance unknown

## chalk/chalk @ 47fc05abd46171b235e24174cd2dba83d25bf037

- 3302 ms; registry requests 1; status analyzed
- **npm:chalk** (declared by package.json): ok; repository **confirmed** (registry repository URL is the analyzed repository); latest 6.0.1; 45 versions; newest 2026-09-27 by sindresorhus; maintainers now 1; provenance no
  - signal provenance_missing [publish_history] the registry reports no provenance attestation for 6.0.1
  - signal dormancy_then_publish [publish_history] version 5.4.0 was published 538 days after the previous one

## pydantic/pydantic-core @ 383eb95a19433754c0cecf7025b50c26b6d97a36

- 5619 ms; registry requests 3; status analyzed
- **crates.io:pydantic-core** (declared by Cargo.toml): not_found (package not found); repository **unknown** (registry lookup did not succeed; correspondence unknown); latest null; 0 versions; newest undefined by n/a; maintainers now 0; provenance unknown
- **npm:pydantic-core** (declared by package.json): not_found (package not found); repository **unknown** (registry lookup did not succeed; correspondence unknown); latest null; 0 versions; newest undefined by n/a; maintainers now 0; provenance unknown
- **pypi:pydantic_core** (declared by pyproject.toml): too_large (response larger than the size limit); repository **unknown** (registry lookup did not succeed; correspondence unknown); latest null; 0 versions; newest undefined by n/a; maintainers now 0; provenance unknown

