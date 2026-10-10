# Calibration results

Dataset 0.1.0, analyzer 0.2.0, methodology 0.2, rules digest ba7c93da8413.

Labels come from ONE AI-assisted reviewer (not independent human review); read every number as an upper bound on how well the labels themselves are known. Repositories flagged `tuned_on` were looked at while building the analyzer and sit in dev only.

### dev split (22 repositories)

| Identity | n | excluded | abstained | accuracy (answered) | accuracy (overall) | correct incl. alternatives | ECE |
| --- | --- | --- | --- | --- | --- | --- | --- |
| artifact type | 21 | 1 | 1 | 60% | 57% | 71% | 0.02 |
| domain | 22 | 0 | 5 | 88% | 68% | 68% | 0.38 |

| Detector | n | TP | FP | FN | TN | excluded | precision | recall |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| automatic install hooks | 22 | 5 | 0 | 0 | 17 | 0 | 100% | 100% |
| persistence | 22 | 0 | 0 | 2 | 20 | 0 | n/a | 0% |
| hard-coded secrets | 20 | 0 | 0 | 1 | 19 | 2 | n/a | 0% |
| BACKGROUND_PROCESS | 20 | 0 | 3 | 0 | 17 | 2 | 0% | n/a |
| CREDENTIAL_ACCESS | 14 | 1 | 1 | 0 | 12 | 8 | 50% | 100% |
| DYNAMIC_CODE_LOAD | 17 | 4 | 3 | 1 | 9 | 5 | 57% | 80% |
| ENVIRONMENT_READ | 18 | 14 | 0 | 1 | 3 | 4 | 100% | 93% |
| FILESYSTEM_WRITE | 18 | 8 | 0 | 4 | 6 | 4 | 100% | 67% |
| NETWORK_CLIENT | 17 | 8 | 0 | 1 | 8 | 5 | 100% | 89% |
| NETWORK_SERVER | 21 | 5 | 0 | 3 | 13 | 1 | 100% | 63% |
| PROCESS_EXEC | 19 | 8 | 1 | 4 | 6 | 3 | 89% | 67% |
| REMOTE_DOWNLOAD | 18 | 2 | 3 | 3 | 10 | 4 | 40% | 40% |
| (all capabilities) scan coverage >= 50% | 64 | 20 | 6 | 3 | 35 | 8 | 77% | 87% |
| (all capabilities) scan coverage < 50% | 98 | 30 | 5 | 14 | 49 | 28 | 86% | 68% |

Capability confidence calibration: n=61, ECE=0.03, Brier=0.14
- confidence 0.0-0.2: n=0, mean confidence n/a, actually correct n/a
- confidence 0.2-0.4: n=0, mean confidence n/a, actually correct n/a
- confidence 0.4-0.6: n=0, mean confidence n/a, actually correct n/a
- confidence 0.6-0.8: n=12, mean confidence 68%, actually correct 58%
- confidence 0.8-1.0: n=49, mean confidence 87%, actually correct 88%

Disagreements (dev):

| repository | field | analyzer | label | confidence |
| --- | --- | --- | --- | --- |
| OWASP/NodeGoat | artifact_type | service | application | 60% |
| OWASP/NodeGoat | domain | database | security | 20% |
| OWASP/NodeGoat | capability:PROCESS_EXEC | observed | no | 85% |
| anchore/syft | capability:BACKGROUND_PROCESS | observed | no | 85% |
| WebGoat/WebGoat | artifact_type | container | application | 50% |
| WebGoat/WebGoat | domain | unknown | security | 10% |
| WebGoat/WebGoat | capability:PROCESS_EXEC | not observed | yes |  |
| WebGoat/WebGoat | capability:NETWORK_SERVER | not observed | yes |  |
| WebGoat/WebGoat | capability:FILESYSTEM_WRITE | not observed | yes |  |
| WebGoat/WebGoat | hard_coded_secrets | false | yes |  |
| bower/bower | capability:PROCESS_EXEC | not observed | yes |  |
| bower/bower | capability:REMOTE_DOWNLOAD | not observed | yes |  |
| digininja/DVWA | artifact_type | container | application | 50% |
| digininja/DVWA | capability:PROCESS_EXEC | not observed | yes |  |
| digininja/DVWA | capability:DYNAMIC_CODE_LOAD | not observed | yes |  |
| dtolnay/anyhow | domain | unknown | developer-tooling | 0% |
| evanw/esbuild | artifact_type | monorepo | tooling | 65% |
| evanw/esbuild | capability:NETWORK_SERVER | not observed | yes |  |
| gitleaks/gitleaks | artifact_type | library | cli | 48% |
| gitleaks/gitleaks | domain | developer-tooling | security | 20% |
| gitleaks/gitleaks | capability:REMOTE_DOWNLOAD | observed | no | 75% |
| junegunn/fzf | capability:REMOTE_DOWNLOAD | observed | no | 90% |
| junegunn/fzf | capability:DYNAMIC_CODE_LOAD | observed | no | 70% |
| junegunn/fzf | capability:CREDENTIAL_ACCESS | observed | no | 70% |
| junegunn/fzf | persistence | false | yes |  |
| louislam/uptime-kuma | artifact_type | monorepo | application | 50% |
| nodejs/node-gyp | capability:NETWORK_CLIENT | not observed | yes |  |
| nodejs/node-gyp | capability:REMOTE_DOWNLOAD | not observed | yes |  |
| octocat/Hello-World | domain | unknown | general | 0% |
| octocat/Spoon-Knife | artifact_type | unknown | template | 20% |
| octocat/Spoon-Knife | domain | unknown | general | 0% |
| nvm-sh/nvm | artifact_type | library | cli | 48% |
| nvm-sh/nvm | capability:FILESYSTEM_WRITE | not observed | yes |  |
| nvm-sh/nvm | capability:ENVIRONMENT_READ | not observed | yes |  |
| nvm-sh/nvm | capability:BACKGROUND_PROCESS | observed | no | 85% |
| nvm-sh/nvm | persistence | false | yes |  |
| prometheus/node_exporter | artifact_type | library | service | 60% |
| prometheus/node_exporter | capability:NETWORK_SERVER | not observed | yes |  |
| prometheus/node_exporter | capability:REMOTE_DOWNLOAD | observed | no | 90% |
| prometheus/node_exporter | capability:DYNAMIC_CODE_LOAD | observed | no | 70% |
| prometheus/node_exporter | capability:BACKGROUND_PROCESS | observed | no | 85% |
| psf/requests | capability:FILESYSTEM_WRITE | not observed | yes |  |
| sharkdp/fd | capability:DYNAMIC_CODE_LOAD | observed | no | 70% |
| sass/node-sass | domain | unknown | developer-tooling | 10% |
| sass/node-sass | capability:PROCESS_EXEC | not observed | yes |  |
| sass/node-sass | capability:REMOTE_DOWNLOAD | not observed | yes |  |
| sindresorhus/execa | capability:FILESYSTEM_WRITE | not observed | yes |  |

### validation split (14 repositories)

| Identity | n | excluded | abstained | accuracy (answered) | accuracy (overall) | correct incl. alternatives | ECE |
| --- | --- | --- | --- | --- | --- | --- | --- |
| artifact type | 14 | 0 | 0 | 79% | 79% | 93% | 0.22 |
| domain | 14 | 0 | 2 | 75% | 64% | 64% | 0.26 |

| Detector | n | TP | FP | FN | TN | excluded | precision | recall |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| automatic install hooks | 14 | 2 | 0 | 0 | 12 | 0 | 100% | 100% |
| persistence | 14 | 0 | 0 | 0 | 14 | 0 | n/a | n/a |
| hard-coded secrets | 14 | 0 | 0 | 1 | 13 | 0 | n/a | 0% |
| BACKGROUND_PROCESS | 13 | 0 | 1 | 1 | 11 | 1 | 0% | 0% |
| CREDENTIAL_ACCESS | 11 | 0 | 0 | 0 | 11 | 3 | n/a | n/a |
| DYNAMIC_CODE_LOAD | 8 | 1 | 2 | 1 | 4 | 6 | 33% | 50% |
| ENVIRONMENT_READ | 13 | 11 | 0 | 1 | 1 | 1 | 100% | 92% |
| FILESYSTEM_WRITE | 12 | 5 | 1 | 1 | 5 | 2 | 83% | 83% |
| NETWORK_CLIENT | 14 | 6 | 1 | 1 | 6 | 0 | 86% | 86% |
| NETWORK_SERVER | 14 | 3 | 0 | 2 | 9 | 0 | 100% | 60% |
| PROCESS_EXEC | 12 | 2 | 3 | 2 | 5 | 2 | 40% | 50% |
| REMOTE_DOWNLOAD | 12 | 1 | 0 | 1 | 10 | 2 | 100% | 50% |
| (all capabilities) scan coverage >= 50% | 43 | 5 | 0 | 2 | 36 | 2 | 100% | 71% |
| (all capabilities) scan coverage < 50% | 66 | 24 | 8 | 8 | 26 | 15 | 75% | 75% |

Capability confidence calibration: n=37, ECE=0.09, Brier=0.18
- confidence 0.0-0.2: n=0, mean confidence n/a, actually correct n/a
- confidence 0.2-0.4: n=0, mean confidence n/a, actually correct n/a
- confidence 0.4-0.6: n=0, mean confidence n/a, actually correct n/a
- confidence 0.6-0.8: n=5, mean confidence 66%, actually correct 80%
- confidence 0.8-1.0: n=32, mean confidence 86%, actually correct 78%

Disagreements (validation):

| repository | field | analyzer | label | confidence |
| --- | --- | --- | --- | --- |
| Textualize/rich | artifact_type | cli | library | 70% |
| Textualize/rich | capability:FILESYSTEM_WRITE | not observed | yes |  |
| caddyserver/caddy | artifact_type | library | service | 50% |
| caddyserver/caddy | domain | security | web | 20% |
| caddyserver/caddy | capability:DYNAMIC_CODE_LOAD | not observed | yes |  |
| caddyserver/caddy | capability:BACKGROUND_PROCESS | not observed | yes |  |
| changesets/changesets | domain | web | developer-tooling | 28% |
| changesets/changesets | capability:NETWORK_CLIENT | not observed | yes |  |
| juice-shop/juice-shop | capability:PROCESS_EXEC | observed | no | 85% |
| juice-shop/juice-shop | hard_coded_secrets | false | yes |  |
| moment/moment | domain | unknown | general | 10% |
| moment/moment | capability:PROCESS_EXEC | observed | no | 85% |
| moment/moment | capability:NETWORK_CLIENT | observed | no | 80% |
| moment/moment | capability:FILESYSTEM_WRITE | observed | no | 85% |
| moment/moment | capability:DYNAMIC_CODE_LOAD | observed | no | 90% |
| ossf/scorecard | artifact_type | library | cli | 60% |
| ossf/scorecard | domain | observability | security | 20% |
| ossf/scorecard | capability:NETWORK_SERVER | not observed | yes |  |
| ossf/scorecard | capability:DYNAMIC_CODE_LOAD | observed | no | 70% |
| request/request | domain | unknown | networking | 10% |
| puppeteer/puppeteer | capability:REMOTE_DOWNLOAD | not observed | yes |  |
| tj/commander.js | capability:PROCESS_EXEC | not observed | yes |  |
| tj/commander.js | capability:ENVIRONMENT_READ | not observed | yes |  |
| zloirock/core-js | capability:PROCESS_EXEC | observed | no | 85% |
| zloirock/core-js | capability:BACKGROUND_PROCESS | observed | no | 85% |
| trpc/trpc | capability:PROCESS_EXEC | not observed | yes |  |
| trpc/trpc | capability:NETWORK_SERVER | not observed | yes |  |

