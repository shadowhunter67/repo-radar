# Calibration results: fresh-holdout-0.4

Dataset 0.1.0, analyzer 0.4.0, methodology 0.4, rules digest 9d4d2b08538b.

Labels come from ONE AI-assisted reviewer (not independent human review); read every number as an upper bound on how well the labels themselves are known. This is a FRESH HOLDOUT: it was run once for this methodology and must not be used to tune the analyzer in this cycle.

### holdout split (14 repositories)

| Identity | n | excluded | abstained | accuracy (answered) | accuracy (overall) | correct incl. alternatives | ECE |
| --- | --- | --- | --- | --- | --- | --- | --- |
| artifact type | 14 | 0 | 0 | 36% | 36% | 71% | 0.21 |
| domain | 14 | 0 | 2 | 50% | 43% | 43% | 0.10 |

| Detector | n | TP | FP | FN | TN | excluded | precision | recall |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| automatic install hooks | 14 | 2 | 0 | 0 | 12 | 0 | 100% | 100% |
| persistence | 13 | 0 | 0 | 0 | 13 | 1 | n/a | n/a |
| hard-coded secrets | 12 | 0 | 0 | 0 | 12 | 2 | n/a | n/a |
| BACKGROUND_PROCESS | 9 | 0 | 0 | 0 | 9 | 5 | n/a | n/a |
| CREDENTIAL_ACCESS | 10 | 0 | 1 | 2 | 7 | 4 | 0% | 0% |
| DYNAMIC_CODE_LOAD | 9 | 2 | 2 | 0 | 5 | 5 | 50% | 100% |
| ENVIRONMENT_READ | 13 | 7 | 3 | 2 | 1 | 1 | 70% | 78% |
| FILESYSTEM_WRITE | 11 | 4 | 1 | 2 | 4 | 3 | 80% | 67% |
| NETWORK_CLIENT | 11 | 3 | 4 | 1 | 3 | 3 | 43% | 75% |
| NETWORK_SERVER | 12 | 0 | 2 | 4 | 6 | 2 | 0% | 0% |
| PROCESS_EXEC | 11 | 1 | 2 | 3 | 5 | 3 | 33% | 25% |
| REMOTE_DOWNLOAD | 11 | 1 | 1 | 2 | 7 | 3 | 50% | 33% |
| (all capabilities) scan coverage >= 50% | 42 | 7 | 6 | 4 | 25 | 3 | 54% | 64% |
| (all capabilities) scan coverage < 50% | 55 | 11 | 10 | 12 | 22 | 26 | 52% | 48% |

Artifact-type confidence reliability (answered only): n=14, ECE=0.21, Brier=0.27
- confidence 0.4-0.6: n=6, mean confidence 50%, actually correct 33%
- confidence 0.6-0.8: n=8, mean confidence 63%, actually correct 38%

Domain confidence reliability (answered only): n=12, ECE=0.10, Brier=0.17
- confidence 0.0-0.2: n=1, mean confidence 14%, actually correct 0%
- confidence 0.2-0.4: n=6, mean confidence 30%, actually correct 33%
- confidence 0.4-0.6: n=2, mean confidence 45%, actually correct 50%
- confidence 0.6-0.8: n=2, mean confidence 69%, actually correct 100%
- confidence 0.8-1.0: n=1, mean confidence 84%, actually correct 100%

Capability confidence calibration: n=34, ECE=0.30, Brier=0.31
- confidence 0.0-0.2: n=0, mean confidence n/a, actually correct n/a
- confidence 0.2-0.4: n=0, mean confidence n/a, actually correct n/a
- confidence 0.4-0.6: n=0, mean confidence n/a, actually correct n/a
- confidence 0.6-0.8: n=6, mean confidence 67%, actually correct 0%
- confidence 0.8-1.0: n=28, mean confidence 87%, actually correct 64%

Dependency / SBOM label family (14 repositories with dependency labels)

| Detector | n | TP | FP | FN | TN | excluded | precision | recall |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| auxiliary_dependency_presence | 14 | 4 | 0 | 2 | 8 | 0 | 100% | 67% |
| exact_version_expected | 14 | 10 | 0 | 0 | 4 | 0 | 100% | 100% |
| has_lockfile | 14 | 10 | 0 | 0 | 4 | 0 | 100% | 100% |
| has_sbom | 14 | 3 | 0 | 0 | 11 | 0 | 100% | 100% |
| manifest_sbom_missing | 3 | 1 | 0 | 0 | 2 | 0 | 100% | 100% |
| osv_checkable | 14 | 10 | 1 | 0 | 3 | 0 | 91% | 100% |
| osv_expected_known_vulnerabilities | 0 | 0 | 0 | 0 | 0 | 14 | n/a | n/a |
| sbom_extra_components | 2 | 2 | 0 | 0 | 0 | 1 | 100% | 100% |

- SBOM format: 14/14 correct (0 unknown)
- SBOM consistency class: 1/2 correct (12 unknown/disputed/n.a.); confusion {"consistent":{"partial":1},"mismatch":{"mismatch":1}}
- primary dependency manifests: exact 12/14, within 10% 13/14
- direct dependency count: exact 4/6, within 10% 4/6
- resolution coverage where exact versions were expected: 98% (n=10); OSV direct coverage where checkable: 98%

Disagreements (holdout):

| repository | field | analyzer | label | confidence |
| --- | --- | --- | --- | --- |
| axios/axios | capability:PROCESS_EXEC | not observed | yes |  |
| axios/axios | capability:NETWORK_CLIENT | observed | no | 80% |
| axios/axios | capability:NETWORK_SERVER | observed | no | 60% |
| axios/axios | capability:ENVIRONMENT_READ | not observed | yes |  |
| clap-rs/clap | artifact_type | monorepo | library | 65% |
| clap-rs/clap | capability:PROCESS_EXEC | observed | no | 90% |
| digitalfabrik/integreat-app | artifact_type | monorepo | application | 65% |
| digitalfabrik/integreat-app | domain | general | web | 40% |
| encode/httpx | artifact_type | sdk | library | 60% |
| encode/httpx | capability:CREDENTIAL_ACCESS | observed | no | 70% |
| miniflux/v2 | artifact_type | library | application | 60% |
| miniflux/v2 | domain | database | web | 33% |
| miniflux/v2 | capability:PROCESS_EXEC | observed | no | 90% |
| miniflux/v2 | capability:NETWORK_SERVER | not observed | yes |  |
| miniflux/v2 | capability:REMOTE_DOWNLOAD | not observed | yes |  |
| miniflux/v2 | capability:FILESYSTEM_WRITE | observed | no | 85% |
| mongodb/django-mongodb-backend | artifact_type | framework | library | 45% |
| mongodb/django-mongodb-backend | domain | web | database | 21% |
| mongodb/django-mongodb-backend | capability:REMOTE_DOWNLOAD | observed | no | 90% |
| mongodb/django-mongodb-backend | capability:ENVIRONMENT_READ | observed | no | 90% |
| nodeshift/faas-js-runtime | domain | developer-tooling | cloud | 14% |
| nodeshift/faas-js-runtime | capability:NETWORK_CLIENT | observed | no | 80% |
| nodeshift/faas-js-runtime | capability:NETWORK_SERVER | not observed | yes |  |
| pallets/werkzeug | domain | unknown | web | 10% |
| pallets/werkzeug | capability:REMOTE_DOWNLOAD | not observed | yes |  |
| pallets/werkzeug | capability:CREDENTIAL_ACCESS | not observed | yes |  |
| pallets/werkzeug | capability:ENVIRONMENT_READ | observed | no | 90% |
| prometheus/prometheus | artifact_type | monorepo | service | 50% |
| prometheus/prometheus | capability:NETWORK_SERVER | not observed | yes |  |
| prometheus/prometheus | capability:ENVIRONMENT_READ | not observed | yes |  |
| pydantic/pydantic-core | capability:DYNAMIC_CODE_LOAD | observed | no | 70% |
| python-poetry/poetry | artifact_type | sdk | cli | 49% |
| python-poetry/poetry | domain | networking | developer-tooling | 28% |
| python-poetry/poetry | capability:PROCESS_EXEC | not observed | yes |  |
| python-poetry/poetry | capability:NETWORK_CLIENT | not observed | yes |  |
| python-poetry/poetry | capability:NETWORK_SERVER | not observed | yes |  |
| python-poetry/poetry | capability:FILESYSTEM_WRITE | not observed | yes |  |
| python-poetry/poetry | capability:CREDENTIAL_ACCESS | not observed | yes |  |
| sindresorhus/got | artifact_type | sdk | library | 52% |
| sindresorhus/got | capability:PROCESS_EXEC | not observed | yes |  |
| sindresorhus/got | capability:NETWORK_CLIENT | observed | no | 80% |
| sindresorhus/got | capability:NETWORK_SERVER | observed | no | 60% |
| sindresorhus/got | capability:ENVIRONMENT_READ | observed | no | 90% |
| sindresorhus/slugify | domain | unknown | general | 0% |
| starship/starship | artifact_type | library | cli | 60% |
| starship/starship | domain | ai | developer-tooling | 37% |
| starship/starship | capability:NETWORK_CLIENT | observed | no | 72% |
| starship/starship | capability:FILESYSTEM_WRITE | not observed | yes |  |
| starship/starship | capability:DYNAMIC_CODE_LOAD | observed | no | 70% |

Timing: axios 39703ms/66req, clap 9926ms/72req, integreat-app 8706ms/71req, httpx 6652ms/41req, v2 7294ms/64req, django-mongodb-backend 7895ms/66req, faas-js-runtime 7381ms/34req, werkzeug 8017ms/61req, prometheus 8747ms/74req, pydantic-core 8603ms/61req, poetry 8505ms/63req, got 6069ms/48req, slugify 3171ms/18req, starship 7443ms/65req

