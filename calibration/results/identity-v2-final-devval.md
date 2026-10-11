# Calibration results: calibration-v0

Dataset 0.1.0, analyzer 0.5.0, methodology 0.4, rules digest 9d4d2b08538b.

Labels come from ONE AI-assisted reviewer (not independent human review); read every number as an upper bound on how well the labels themselves are known. Repositories flagged `tuned_on` were looked at while building the analyzer and sit in dev only.

### dev split (22 repositories)

| Identity | n | excluded | abstained | accuracy (answered) | accuracy (overall) | correct incl. alternatives | ECE |
| --- | --- | --- | --- | --- | --- | --- | --- |
| artifact type | 21 | 1 | 1 | 60% | 57% | 71% | 0.04 |
| primary artifact (identity v2) | 21 | 1 | 1 | 90% | 86% | 90% | 0.46 |
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

Artifact-type confidence reliability (answered only): n=20, ECE=0.04, Brier=0.22
- confidence 0.4-0.6: n=9, mean confidence 50%, actually correct 56%
- confidence 0.6-0.8: n=10, mean confidence 63%, actually correct 60%
- confidence 0.8-1.0: n=1, mean confidence 89%, actually correct 100%

Primary-artifact (v2) confidence reliability (answered only): n=20, ECE=0.46, Brier=0.32
- confidence 0.2-0.4: n=8, mean confidence 35%, actually correct 100%
- confidence 0.4-0.6: n=11, mean confidence 49%, actually correct 82%
- confidence 0.6-0.8: n=1, mean confidence 63%, actually correct 100%

Domain confidence reliability (answered only): n=17, ECE=0.38, Brier=0.23
- confidence 0.2-0.4: n=7, mean confidence 27%, actually correct 71%
- confidence 0.4-0.6: n=4, mean confidence 51%, actually correct 100%
- confidence 0.6-0.8: n=3, mean confidence 68%, actually correct 100%
- confidence 0.8-1.0: n=3, mean confidence 84%, actually correct 100%

Capability confidence calibration: n=61, ECE=0.03, Brier=0.14
- confidence 0.0-0.2: n=0, mean confidence n/a, actually correct n/a
- confidence 0.2-0.4: n=0, mean confidence n/a, actually correct n/a
- confidence 0.4-0.6: n=0, mean confidence n/a, actually correct n/a
- confidence 0.6-0.8: n=12, mean confidence 68%, actually correct 58%
- confidence 0.8-1.0: n=49, mean confidence 87%, actually correct 88%

Disagreements (dev):

| repository | field | analyzer | label | confidence | cause |
| --- | --- | --- | --- | --- | --- |
| OWASP/NodeGoat | artifact_type | service | application | 60% | model_wrong |
| OWASP/NodeGoat | domain | database | security | 20% | model_wrong |
| OWASP/NodeGoat | capability:PROCESS_EXEC | observed | no | 85% | model_wrong |
| WebGoat/WebGoat | artifact_type | library | application | 60% | model_wrong |
| WebGoat/WebGoat | domain | unknown | security | 10% | model_wrong |
| WebGoat/WebGoat | capability:PROCESS_EXEC | not observed | yes |  | model_wrong |
| WebGoat/WebGoat | capability:NETWORK_SERVER | not observed | yes |  | model_wrong |
| WebGoat/WebGoat | capability:FILESYSTEM_WRITE | not observed | yes |  | model_wrong |
| WebGoat/WebGoat | hard_coded_secrets | false | yes |  | model_wrong |
| anchore/syft | capability:BACKGROUND_PROCESS | observed | no | 85% | model_wrong |
| bower/bower | capability:PROCESS_EXEC | not observed | yes |  | model_wrong |
| bower/bower | capability:REMOTE_DOWNLOAD | not observed | yes |  | model_wrong |
| digininja/DVWA | artifact_type | container | application | 50% | model_wrong |
| digininja/DVWA | capability:PROCESS_EXEC | not observed | yes |  | model_wrong |
| digininja/DVWA | capability:DYNAMIC_CODE_LOAD | not observed | yes |  | model_wrong |
| dtolnay/anyhow | domain | unknown | developer-tooling | 0% | model_wrong |
| evanw/esbuild | artifact_type | monorepo | tooling | 65% | model_wrong |
| evanw/esbuild | capability:NETWORK_SERVER | not observed | yes |  | model_wrong |
| gitleaks/gitleaks | artifact_type | library | cli | 48% | model_wrong |
| gitleaks/gitleaks | domain | developer-tooling | security | 20% | model_wrong |
| gitleaks/gitleaks | capability:REMOTE_DOWNLOAD | observed | no | 75% | model_wrong |
| junegunn/fzf | capability:REMOTE_DOWNLOAD | observed | no | 90% | model_wrong |
| junegunn/fzf | capability:DYNAMIC_CODE_LOAD | observed | no | 70% | model_wrong |
| junegunn/fzf | capability:CREDENTIAL_ACCESS | observed | no | 70% | model_wrong |
| junegunn/fzf | persistence | false | yes |  | model_wrong |
| louislam/uptime-kuma | artifact_type | monorepo | application | 50% | model_wrong |
| nodejs/node-gyp | capability:NETWORK_CLIENT | not observed | yes |  | model_wrong |
| nodejs/node-gyp | capability:REMOTE_DOWNLOAD | not observed | yes |  | model_wrong |
| nvm-sh/nvm | artifact_type | library | cli | 48% | model_wrong |
| nvm-sh/nvm | capability:FILESYSTEM_WRITE | not observed | yes |  | model_wrong |
| nvm-sh/nvm | capability:ENVIRONMENT_READ | not observed | yes |  | model_wrong |
| nvm-sh/nvm | capability:BACKGROUND_PROCESS | observed | no | 85% | model_wrong |
| nvm-sh/nvm | persistence | false | yes |  | model_wrong |
| octocat/Hello-World | domain | unknown | general | 0% | model_wrong |
| octocat/Spoon-Knife | artifact_type | unknown | template | 20% | model_wrong |
| octocat/Spoon-Knife | domain | unknown | general | 0% | model_wrong |
| prometheus/node_exporter | artifact_type | library | service | 60% | model_wrong |
| prometheus/node_exporter | capability:NETWORK_SERVER | not observed | yes |  | model_wrong |
| prometheus/node_exporter | capability:REMOTE_DOWNLOAD | observed | no | 90% | model_wrong |
| prometheus/node_exporter | capability:DYNAMIC_CODE_LOAD | observed | no | 70% | model_wrong |
| prometheus/node_exporter | capability:BACKGROUND_PROCESS | observed | no | 85% | model_wrong |
| psf/requests | capability:FILESYSTEM_WRITE | not observed | yes |  | model_wrong |
| sass/node-sass | domain | unknown | developer-tooling | 10% | model_wrong |
| sass/node-sass | capability:PROCESS_EXEC | not observed | yes |  | model_wrong |
| sass/node-sass | capability:REMOTE_DOWNLOAD | not observed | yes |  | model_wrong |
| sharkdp/fd | capability:DYNAMIC_CODE_LOAD | observed | no | 70% | model_wrong |
| sindresorhus/execa | capability:FILESYSTEM_WRITE | not observed | yes |  | model_wrong |

### validation split (14 repositories)

| Identity | n | excluded | abstained | accuracy (answered) | accuracy (overall) | correct incl. alternatives | ECE |
| --- | --- | --- | --- | --- | --- | --- | --- |
| artifact type | 14 | 0 | 0 | 79% | 79% | 93% | 0.22 |
| primary artifact (identity v2) | 14 | 0 | 0 | 100% | 100% | 100% | 0.53 |
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

Artifact-type confidence reliability (answered only): n=14, ECE=0.22, Brier=0.18
- confidence 0.4-0.6: n=1, mean confidence 50%, actually correct 0%
- confidence 0.6-0.8: n=13, mean confidence 65%, actually correct 85%

Primary-artifact (v2) confidence reliability (answered only): n=14, ECE=0.53, Brier=0.30
- confidence 0.2-0.4: n=5, mean confidence 33%, actually correct 100%
- confidence 0.4-0.6: n=8, mean confidence 51%, actually correct 100%
- confidence 0.8-1.0: n=1, mean confidence 85%, actually correct 100%

Domain confidence reliability (answered only): n=12, ECE=0.26, Brier=0.17
- confidence 0.2-0.4: n=5, mean confidence 28%, actually correct 40%
- confidence 0.4-0.6: n=3, mean confidence 50%, actually correct 100%
- confidence 0.6-0.8: n=3, mean confidence 73%, actually correct 100%
- confidence 0.8-1.0: n=1, mean confidence 83%, actually correct 100%

Capability confidence calibration: n=37, ECE=0.09, Brier=0.18
- confidence 0.0-0.2: n=0, mean confidence n/a, actually correct n/a
- confidence 0.2-0.4: n=0, mean confidence n/a, actually correct n/a
- confidence 0.4-0.6: n=0, mean confidence n/a, actually correct n/a
- confidence 0.6-0.8: n=5, mean confidence 66%, actually correct 80%
- confidence 0.8-1.0: n=32, mean confidence 86%, actually correct 78%

Disagreements (validation):

| repository | field | analyzer | label | confidence | cause |
| --- | --- | --- | --- | --- | --- |
| Textualize/rich | artifact_type | cli | library | 70% | model_wrong |
| Textualize/rich | capability:FILESYSTEM_WRITE | not observed | yes |  | model_wrong |
| caddyserver/caddy | artifact_type | library | service | 50% | model_wrong |
| caddyserver/caddy | domain | security | web | 20% | model_wrong |
| caddyserver/caddy | capability:DYNAMIC_CODE_LOAD | not observed | yes |  | model_wrong |
| caddyserver/caddy | capability:BACKGROUND_PROCESS | not observed | yes |  | model_wrong |
| changesets/changesets | domain | web | developer-tooling | 28% | model_wrong |
| changesets/changesets | capability:NETWORK_CLIENT | not observed | yes |  | model_wrong |
| juice-shop/juice-shop | capability:PROCESS_EXEC | observed | no | 85% | model_wrong |
| juice-shop/juice-shop | hard_coded_secrets | false | yes |  | model_wrong |
| moment/moment | domain | unknown | general | 10% | model_wrong |
| moment/moment | capability:PROCESS_EXEC | observed | no | 85% | model_wrong |
| moment/moment | capability:NETWORK_CLIENT | observed | no | 80% | model_wrong |
| moment/moment | capability:FILESYSTEM_WRITE | observed | no | 85% | model_wrong |
| moment/moment | capability:DYNAMIC_CODE_LOAD | observed | no | 90% | model_wrong |
| ossf/scorecard | artifact_type | library | cli | 60% | model_wrong |
| ossf/scorecard | domain | observability | security | 20% | model_wrong |
| ossf/scorecard | capability:NETWORK_SERVER | not observed | yes |  | model_wrong |
| ossf/scorecard | capability:DYNAMIC_CODE_LOAD | observed | no | 70% | model_wrong |
| puppeteer/puppeteer | capability:REMOTE_DOWNLOAD | not observed | yes |  | model_wrong |
| request/request | domain | unknown | networking | 10% | model_wrong |
| tj/commander.js | capability:PROCESS_EXEC | not observed | yes |  | model_wrong |
| tj/commander.js | capability:ENVIRONMENT_READ | not observed | yes |  | model_wrong |
| trpc/trpc | capability:PROCESS_EXEC | not observed | yes |  | model_wrong |
| trpc/trpc | capability:NETWORK_SERVER | not observed | yes |  | model_wrong |
| zloirock/core-js | capability:PROCESS_EXEC | observed | no | 85% | model_wrong |
| zloirock/core-js | capability:BACKGROUND_PROCESS | observed | no | 85% | model_wrong |

Timing: ripgrep 29680ms/83req, colors.js 5620ms/33req, NodeGoat 6931ms/50req, rich 7548ms/64req, WebGoat 8180ms/63req, syft 11765ms/73req, bower 8700ms/63req, caddy 14126ms/73req, chalk 5540ms/24req, changesets 8543ms/70req, DVWA 7020ms/60req, anyhow 6176ms/35req, esbuild 8919ms/75req, express 8198ms/30req, gitignore 3828ms/13req, gitleaks 10138ms/67req, juice-shop 13886ms/85req, fzf 11641ms/73req, uptime-kuma 8191ms/81req, moment 7126ms/64req, node-gyp 6951ms/62req, nvm 7819ms/45req, Hello-World 2865ms/14req, Spoon-Knife 2442ms/14req, scorecard 12463ms/82req, flask 10763ms/59req, node_exporter 12347ms/71req, requests 7385ms/50req, puppeteer 7492ms/81req, request 4582ms/29req, node-sass 9104ms/66req, fd 7958ms/49req, execa 7874ms/60req, commander.js 5538ms/31req, trpc 10027ms/81req, core-js 7335ms/72req

