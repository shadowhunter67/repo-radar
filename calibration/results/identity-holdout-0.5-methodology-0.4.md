# Calibration results: identity-holdout-0.5

Dataset 0.1.0, analyzer 0.5.0, methodology 0.4, rules digest 9d4d2b08538b.

Labels come from ONE AI-assisted reviewer (not independent human review); read every number as an upper bound on how well the labels themselves are known. This is a FRESH HOLDOUT: it was run once for this methodology and must not be used to tune the analyzer in this cycle.

### holdout split (16 repositories)

| Identity | n | excluded | abstained | accuracy (answered) | accuracy (overall) | correct incl. alternatives | ECE |
| --- | --- | --- | --- | --- | --- | --- | --- |
| artifact type | 16 | 0 | 1 | 67% | 63% | 63% | 0.09 |
| primary artifact (identity v2) | 16 | 0 | 0 | 63% | 63% | 81% | 0.15 |
| packaging (identity v2) | 13 | 0 | 0 | 92% | 92% | 92% | 0.48 |
| domain | 16 | 0 | 3 | 85% | 69% | 69% | 0.32 |

| Detector | n | TP | FP | FN | TN | excluded | precision | recall |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| automatic install hooks | 0 | 0 | 0 | 0 | 0 | 16 | n/a | n/a |
| persistence | 0 | 0 | 0 | 0 | 0 | 16 | n/a | n/a |
| hard-coded secrets | 0 | 0 | 0 | 0 | 0 | 16 | n/a | n/a |
| (all capabilities) scan coverage >= 50% | 0 | 0 | 0 | 0 | 0 | 0 | n/a | n/a |
| (all capabilities) scan coverage < 50% | 0 | 0 | 0 | 0 | 0 | 0 | n/a | n/a |

Artifact-type confidence reliability (answered only): n=15, ECE=0.09, Brier=0.20
- confidence 0.4-0.6: n=3, mean confidence 52%, actually correct 33%
- confidence 0.6-0.8: n=10, mean confidence 65%, actually correct 70%
- confidence 0.8-1.0: n=2, mean confidence 86%, actually correct 100%

Primary-artifact (v2) confidence reliability (answered only): n=16, ECE=0.15, Brier=0.24
- confidence 0.2-0.4: n=6, mean confidence 33%, actually correct 50%
- confidence 0.4-0.6: n=7, mean confidence 52%, actually correct 57%
- confidence 0.6-0.8: n=3, mean confidence 66%, actually correct 100%

Domain confidence reliability (answered only): n=13, ECE=0.32, Brier=0.11
- confidence 0.2-0.4: n=2, mean confidence 29%, actually correct 0%
- confidence 0.4-0.6: n=1, mean confidence 44%, actually correct 100%
- confidence 0.6-0.8: n=8, mean confidence 67%, actually correct 100%
- confidence 0.8-1.0: n=2, mean confidence 84%, actually correct 100%

Capability confidence calibration: n=0, ECE=n/a, Brier=n/a
- confidence 0.0-0.2: n=0, mean confidence n/a, actually correct n/a
- confidence 0.2-0.4: n=0, mean confidence n/a, actually correct n/a
- confidence 0.4-0.6: n=0, mean confidence n/a, actually correct n/a
- confidence 0.6-0.8: n=0, mean confidence n/a, actually correct n/a
- confidence 0.8-1.0: n=0, mean confidence n/a, actually correct n/a

Disagreements (holdout):

| repository | field | analyzer | label | confidence | cause |
| --- | --- | --- | --- | --- | --- |
| etcd-io/etcd | artifact_type | monorepo | service | 65% | model_wrong |
| fastapi/full-stack-fastapi-template | artifact_type | monorepo | template | 50% | model_wrong |
| fastapi/full-stack-fastapi-template | domain | database | web | 37% | model_wrong |
| gohugoio/hugo | artifact_type | tooling | cli | 77% | model_wrong |
| grafana/k6 | artifact_type | library | cli | 60% | model_wrong |
| grafana/k6 | domain | unknown | developer-tooling | 10% | model_wrong |
| mozilla/pdf.js | domain | unknown | general | 0% | model_wrong |
| pallets/jinja | domain | unknown | web | 0% | model_wrong |
| redis/redis | artifact_type | unknown | service | 20% | model_wrong |
| spring-projects/spring-petclinic | artifact_type | library | application | 48% | model_wrong |
| spring-projects/spring-petclinic | domain | developer-tooling | web | 21% | model_wrong |

Timing: checkout 8244ms/64req, etcd 12575ms/90req, full-stack-fastapi-template 9529ms/77req, fastify 10078ms/77req, gin 7974ms/63req, hugo 9615ms/67req, k6 13209ms/84req, jq 11214ms/68req, pdf.js 9419ms/81req, mybatis-3 9585ms/68req, undici 8319ms/71req, jinja 7721ms/53req, redis 8318ms/67req, bat 8873ms/63req, spring-petclinic 6538ms/57req, terraform-aws-vpc 6100ms/21req

