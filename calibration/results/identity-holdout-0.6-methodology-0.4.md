# Calibration results: identity-holdout-0.6

Dataset 0.1.0, analyzer 0.6.0, methodology 0.4, rules digest 9d4d2b08538b.

Labels come from ONE AI-assisted reviewer (not independent human review); read every number as an upper bound on how well the labels themselves are known. This is a FRESH HOLDOUT: it was run once for this methodology and must not be used to tune the analyzer in this cycle.

### holdout split (18 repositories)

| Identity | n | excluded | abstained | accuracy (answered) | accuracy (overall) | correct incl. alternatives | ECE |
| --- | --- | --- | --- | --- | --- | --- | --- |
| artifact type | 18 | 0 | 2 | 56% | 50% | 72% | 0.09 |
| primary artifact (identity v2) | 18 | 0 | 2 | 75% | 67% | 83% | 0.33 |
| packaging (identity v2) | 15 | 0 | 0 | 80% | 80% | 80% | 0.38 |
| domain | 18 | 0 | 1 | 82% | 78% | 78% | 0.31 |

| Detector | n | TP | FP | FN | TN | excluded | precision | recall |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| automatic install hooks | 0 | 0 | 0 | 0 | 0 | 18 | n/a | n/a |
| persistence | 0 | 0 | 0 | 0 | 0 | 18 | n/a | n/a |
| hard-coded secrets | 0 | 0 | 0 | 0 | 0 | 18 | n/a | n/a |
| (all capabilities) scan coverage >= 50% | 0 | 0 | 0 | 0 | 0 | 0 | n/a | n/a |
| (all capabilities) scan coverage < 50% | 0 | 0 | 0 | 0 | 0 | 0 | n/a | n/a |

Artifact-type confidence reliability (answered only): n=16, ECE=0.09, Brier=0.22
- confidence 0.4-0.6: n=4, mean confidence 49%, actually correct 25%
- confidence 0.6-0.8: n=11, mean confidence 67%, actually correct 64%
- confidence 0.8-1.0: n=1, mean confidence 86%, actually correct 100%

Primary-artifact (v2) confidence reliability (answered only): n=16, ECE=0.33, Brier=0.30
- confidence 0.2-0.4: n=8, mean confidence 33%, actually correct 63%
- confidence 0.4-0.6: n=7, mean confidence 49%, actually correct 86%
- confidence 0.6-0.8: n=1, mean confidence 63%, actually correct 100%

Identity v2 detail: n=18; correct 12, wrong 4, unknown (abstained) 2, answered-but-ambiguous 4
- primary artifact: overall 67%, answered 75%, top-2 83%, ECE 0.33
- packaging: 80% (n=15); deployment form: 72% (n=18)
- interfaces (n=16): precision 63%, recall 81% (tp 25, fp 15, fn 6)

Domain confidence reliability (answered only): n=17, ECE=0.31, Brier=0.27
- confidence 0.0-0.2: n=1, mean confidence 14%, actually correct 100%
- confidence 0.2-0.4: n=4, mean confidence 29%, actually correct 75%
- confidence 0.4-0.6: n=5, mean confidence 52%, actually correct 80%
- confidence 0.6-0.8: n=6, mean confidence 66%, actually correct 83%
- confidence 0.8-1.0: n=1, mean confidence 81%, actually correct 100%

Capability confidence calibration: n=0, ECE=n/a, Brier=n/a
- confidence 0.0-0.2: n=0, mean confidence n/a, actually correct n/a
- confidence 0.2-0.4: n=0, mean confidence n/a, actually correct n/a
- confidence 0.4-0.6: n=0, mean confidence n/a, actually correct n/a
- confidence 0.6-0.8: n=0, mean confidence n/a, actually correct n/a
- confidence 0.8-1.0: n=0, mean confidence n/a, actually correct n/a

Disagreements (holdout):

| repository | field | analyzer | label | confidence | cause |
| --- | --- | --- | --- | --- | --- |
| Textualize/textual | artifact_type | cli | framework | 77% | model_wrong |
| curl/curl | domain | developer-tooling | networking | 69% | model_wrong |
| dandavison/delta | artifact_type | library | cli | 50% | model_wrong |
| lodash/lodash | artifact_type | unknown | library | 20% | model_wrong |
| lodash/lodash | domain | unknown | general | 0% | model_wrong |
| minio/minio | artifact_type | infrastructure | service | 70% | model_wrong |
| nats-io/nats-server | artifact_type | infrastructure | service | 50% | model_wrong |
| nats-io/nats-server | domain | cloud | networking | 30% | model_wrong |
| nginx/nginx | artifact_type | unknown | service | 20% | model_wrong |
| nginx/nginx | domain | security | networking | 49% | model_wrong |
| tokio-rs/axum | artifact_type | sdk | framework | 42% | model_wrong |
| traefik/traefik | artifact_type | infrastructure | service | 60% | model_wrong |
| vuejs/core | artifact_type | monorepo | framework | 65% | model_wrong |

Timing: textual 9289ms/66req, just 14659ms/73req, curl 10815ms/78req, delta 11345ms/70req, eza 12239ms/69req, fastapi 9713ms/79req, cli 8773ms/70req, koa 7396ms/33req, echo 7582ms/59req, lodash 8126ms/48req, minio 9259ms/76req, nats-server 11299ms/75req, nginx 10933ms/69req, redis-py 8331ms/71req, mdBook 12772ms/82req, axum 13749ms/82req, traefik 10985ms/81req, core 7982ms/78req

