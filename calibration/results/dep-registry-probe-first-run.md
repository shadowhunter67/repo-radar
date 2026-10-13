# Dependency registry probe: dep-registry-probe

Run 2026-10-13T14:41:00.870Z. 16 hand-picked packages, one resolved version each; deps.dev as the second source (state ok, 16 requests, 15 enriched). Registry lookups through the analyzer's own collector: 19 requests, 11445773 bytes, 2454 ms in total (deps.dev included).

Coverage: eligible 16, queried 16, ok 16, failed 0, skipped 0. Budget: {"max_dependencies":25,"max_requests":60,"max_elapsed_ms":45000,"max_versions":20,"max_bytes":50331648}. Limits hit: none.

Events found (37); correspondence is repository <-> package PERSPECTIVE only: "confirmed" means three pointers agree and the back-link was not checked.

## crates.io:rand

- why: long history
- status ok; 94 versions, latest 0.10.3; resolved 0.8.5
- repository: declared https://github.com/rust-random/rand -> rust-random/rand; homepage n/a; deps.dev github.com/rust-random/rand; correspondence **likely** (only the registry's own claim names rust-random/rand; no second source corroborates it)
- maintainers NOW (current state): dhardy, github:rust-random:maintainers; provenance reported on latest: false (0 of the sampled versions)
- events: none in the sampled window
- limits: only the newest 20 of 94 versions are kept; crates.io trusted-publishing provenance is not read by this version

## crates.io:serde

- why: publishers are visible per version on crates.io
- status ok; 316 versions, latest 1.0.229; resolved 1.0.190
- repository: declared https://github.com/serde-rs/serde -> serde-rs/serde; homepage n/a; deps.dev github.com/serde-rs/serde; correspondence **likely** (only the registry's own claim names serde-rs/serde; no second source corroborates it)
- maintainers NOW (current state): dtolnay, github:serde-rs:publish; provenance reported on latest: false (0 of the sampled versions)
- event 2026-07-18 dependency_release_cadence_changed 1.0.229 [unknown]: the newest gap (294 days) is far above the earlier median (5 days)
- limits: only the newest 20 of 316 versions are kept; crates.io trusted-publishing provenance is not read by this version

## crates.io:tokio

- why: several publishers
- status ok; 197 versions, latest 1.53.2; resolved 1.34.0
- repository: declared https://github.com/tokio-rs/tokio -> tokio-rs/tokio; homepage n/a; deps.dev github.com/tokio-rs/tokio; correspondence **likely** (only the registry's own claim names tokio-rs/tokio; no second source corroborates it)
- maintainers NOW (current state): carllerche, Darksonn, github:tokio-rs:core; provenance reported on latest: false (0 of the sampled versions)
- event 2026-04-14 dependency_publisher_changed 1.52.0 [unknown]: version 1.52.0 was published by an account that published none of the 7 earlier sampled versions
- limits: only the newest 20 of 197 versions are kept; crates.io trusted-publishing provenance is not read by this version

## npm:colors

- why: maintainer sabotage in 2022
- status ok; 26 versions, latest 1.4.0; resolved 1.4.0
- repository: declared git+ssh://git@github.com/Marak/colors.js.git -> marak/colors.js; homepage marak/colors.js; deps.dev github.com/marak/colors.js, github.com/marak/colors.js; correspondence **likely** (the homepage agrees with the registry on marak/colors.js; one corroborating source only)
- maintainers NOW (current state): marak; provenance reported on latest: false (0 of the sampled versions)
- event 2018-02-16 dependency_publisher_changed 1.2.0-rc0 [before]: version 1.2.0-rc0 was published by an account that published none of the 8 earlier sampled versions
- event 2018-02-16 dependency_maintainer_changed 1.2.0-rc0 [before]: maintainers recorded with 1.2.0-rc0: added [dabh], removed []
- limits: only the newest 20 of 26 versions are kept

## npm:event-stream

- why: public incident in 2018 (publisher change, then a malicious dependency)
- status ok; 84 versions, latest 4.0.1; resolved 3.3.4
- repository: declared git://github.com/dominictarr/event-stream.git -> dominictarr/event-stream; homepage dominictarr/event-stream; deps.dev github.com/dominictarr/event-stream, github.com/dominictarr/event-stream; correspondence **likely** (the homepage agrees with the registry on dominictarr/event-stream; one corroborating source only)
- maintainers NOW (current state): npm; provenance reported on latest: false (0 of the sampled versions)
- event 2018-09-05 dependency_publisher_changed 3.3.5 [after]: version 3.3.5 was published by an account that published none of the 15 earlier sampled versions
- event 2018-09-05 dependency_maintainer_changed 3.3.5 [after]: maintainers recorded with 3.3.5: added [right9ctrl], removed []
- event 2018-09-16 dependency_maintainer_changed 4.0.0 [after]: maintainers recorded with 4.0.0: added [], removed [dominictarr]
- limits: only the newest 20 of 84 versions are kept

## npm:express

- why: several maintainers over time
- status ok; 290 versions, latest 5.3.0; resolved 4.18.2
- repository: declared git+https://github.com/expressjs/express.git -> expressjs/express; homepage expressjs/express; deps.dev github.com/expressjs/express, github.com/expressjs/express; correspondence **likely** (the homepage agrees with the registry on expressjs/express; one corroborating source only)
- maintainers NOW (current state): wesleytodd, jonchurch, ctcpip, ulisesgascon, sheplu; provenance reported on latest: true (2 of the sampled versions)
- event 2024-09-10 dependency_maintainer_changed 4.20.0 [unknown]: maintainers recorded with 4.20.0: added [linusu], removed []
- event 2024-12-05 dependency_publisher_changed 4.21.2 [unknown]: version 4.21.2 was published by an account that published none of the 11 earlier sampled versions
- event 2024-12-05 dependency_maintainer_changed 4.21.2 [unknown]: maintainers recorded with 4.21.2: added [jonchurch], removed []
- event 2025-03-31 dependency_maintainer_changed 5.1.0 [unknown]: maintainers recorded with 5.1.0: added [ctcpip], removed [dougwilson, ulisesgascon, blakeembrey, linusu]
- event 2025-12-01 dependency_maintainer_changed 4.22.0 [unknown]: maintainers recorded with 4.22.0: added [ulisesgascon], removed []
- event 2026-09-14 dependency_publisher_changed 4.22.3 [unknown]: version 4.22.3 was published by an account that published none of the 18 earlier sampled versions
- event 2026-09-14 dependency_provenance_added 4.22.3 [unknown]: 4.22.3 reports a provenance attestation, the previous version did not
- limits: only the newest 20 of 290 versions are kept

## npm:left-pad

- why: deprecated, dormant for years
- status ok; 15 versions, latest 1.3.0; resolved 1.3.0
- repository: declared git+ssh://git@github.com/stevemao/left-pad.git -> stevemao/left-pad; homepage stevemao/left-pad; deps.dev github.com/stevemao/left-pad, github.com/stevemao/left-pad; correspondence **likely** (the homepage agrees with the registry on stevemao/left-pad; one corroborating source only)
- maintainers NOW (current state): stevemao, westlac; provenance reported on latest: false (0 of the sampled versions)
- event 2016-03-22 dependency_publisher_changed 0.0.3 [before]: version 0.0.3 was published by an account that published none of the 5 earlier sampled versions
- event 2016-03-22 dependency_maintainer_changed 0.0.3 [before]: maintainers recorded with 0.0.3: added [], removed [sebmck]
- event 2016-03-23 dependency_repository_changed 1.0.1 [before]: the declared source repository changed from azer/left-pad to camwest/left-pad
- event 2016-04-13 dependency_maintainer_changed 1.0.2 [before]: maintainers recorded with 1.0.2: added [sebmck], removed []
- event 2016-05-01 dependency_publisher_changed 1.1.0 [before]: version 1.1.0 was published by an account that published none of the 9 earlier sampled versions
- event 2016-05-01 dependency_maintainer_changed 1.1.0 [before]: maintainers recorded with 1.1.0: added [stevemao], removed []
- event 2016-05-01 dependency_repository_changed 1.1.0 [before]: the declared source repository changed from camwest/left-pad to stevemao/left-pad

## npm:lodash

- why: mature, stable, one dominant publisher; no provenance expected
- status ok; 117 versions, latest 4.18.1; resolved 4.17.21
- repository: declared git+https://github.com/lodash/lodash.git -> lodash/lodash; homepage lodash/lodash; deps.dev github.com/lodash/lodash, github.com/lodash/lodash; correspondence **likely** (the homepage agrees with the registry on lodash/lodash; one corroborating source only)
- maintainers NOW (current state): jdalton; provenance reported on latest: false (0 of the sampled versions)
- event 2020-07-08 dependency_publisher_changed 4.17.16 [before]: version 4.17.16 was published by an account that published none of the 11 earlier sampled versions
- event 2020-08-13 dependency_publisher_changed 4.17.20 [before]: version 4.17.20 was published by an account that published none of the 15 earlier sampled versions
- event 2020-08-13 dependency_maintainer_changed 4.17.20 [before]: maintainers recorded with 4.17.20: added [bnjmnt4n], removed []
- event 2026-01-21 dependency_dormancy_ended 4.17.23 [after]: version 4.17.23 was published 1796 days after the previous one
- limits: only the newest 20 of 117 versions are kept

## npm:node-ipc

- why: protestware in 2022
- status ok; 76 versions, latest 14.0.0; resolved 9.2.1
- repository: declared git+https://github.com/RIAEvangelist/node-ipc.git -> riaevangelist/node-ipc; homepage riaevangelist/node-ipc; deps.dev github.com/riaevangelist/node-ipc, github.com/riaevangelist/node-ipc; correspondence **likely** (the homepage agrees with the registry on riaevangelist/node-ipc; one corroborating source only)
- maintainers NOW (current state): riaevangelist; provenance reported on latest: false (0 of the sampled versions)
- event 2017-08-25 dependency_maintainer_changed 9.1.1 [before]: maintainers recorded with 9.1.1: added [alansikora, gloridea, kevinwilson541, lstratman], removed []
- event 2020-11-11 dependency_maintainer_changed 9.1.2 [before]: maintainers recorded with 9.1.2: added [atiertant], removed []
- event 2026-08-24 dependency_maintainer_changed 14.0.0 [after]: maintainers recorded with 14.0.0: added [], removed [alansikora, rsp, mostafa-samir, atiertant]
- event 2026-08-24 dependency_dormancy_ended 14.0.0 [after]: version 14.0.0 was published 742 days after the previous one
- limits: only the newest 20 of 76 versions are kept

## npm:rc

- why: public account hijack in 2021
- status ok; 48 versions, latest 1.2.8; resolved 1.2.8
- repository: declared git+https://github.com/dominictarr/rc.git -> dominictarr/rc; homepage dominictarr/rc; deps.dev github.com/dominictarr/rc, github.com/dominictarr/rc; correspondence **likely** (the homepage agrees with the registry on dominictarr/rc; one corroborating source only)
- maintainers NOW (current state): powersource, arj03, staltz, mixmix, cel, christianbundy, pfrazee, happy0, chereseeriepa; provenance reported on latest: false (0 of the sampled versions)
- events: none in the sampled window
- limits: only the newest 20 of 48 versions are kept

## npm:react

- why: large organisation, many maintainers
- status ok; 2969 versions, latest 19.3.0; resolved 18.2.0
- repository: declared git+https://github.com/react/react.git -> react/react; homepage react/react; deps.dev github.com/facebook/react, github.com/facebook/react; correspondence **likely** (the homepage agrees with the registry on react/react; one corroborating source only)
- maintainers NOW (current state): fb, react-bot; provenance reported on latest: true (165 of the sampled versions)
- events: none in the sampled window
- limits: only the newest 20 of 2969 versions are kept

## npm:sigstore

- why: publishes with npm provenance
- status ok; 40 versions, latest 5.0.0; resolved 3.1.0
- repository: declared git+https://github.com/sigstore/sigstore-js.git -> sigstore/sigstore-js; homepage sigstore/sigstore-js; deps.dev github.com/sigstore/sigstore-js, github.com/sigstore/sigstore-js, github.com/sigstore/sigstore-js; correspondence **likely** (the homepage agrees with the registry on sigstore/sigstore-js; one corroborating source only)
- maintainers NOW (current state): bdehamer; provenance reported on latest: true (32 of the sampled versions)
- event 2025-07-29 dependency_publisher_changed 4.0.0 [after]: version 4.0.0 was published by an account that published none of the 16 earlier sampled versions
- event 2025-12-19 dependency_maintainer_changed 4.1.0 [after]: maintainers recorded with 4.1.0: added [], removed [mylesborins]
- limits: only the newest 20 of 40 versions are kept

## npm:ua-parser-js

- why: public account hijack in 2021
- status ok; 94 versions, latest 2.0.10; resolved 0.7.29
- repository: declared git+https://github.com/faisalman/ua-parser-js.git -> faisalman/ua-parser-js; homepage faisalman/ua-parser-js; deps.dev none; correspondence **likely** (the homepage agrees with the registry on faisalman/ua-parser-js; one corroborating source only)
- maintainers NOW (current state): faisalman; provenance reported on latest: true (18 of the sampled versions)
- event 2024-10-29 dependency_provenance_added 2.0.0-rc.1 [unknown]: 2.0.0-rc.1 reports a provenance attestation, the previous version did not
- event 2024-12-21 dependency_provenance_removed 0.7.40 [unknown]: 0.7.40 reports no provenance attestation, the previous version did
- event 2025-02-04 dependency_provenance_added 2.0.1 [unknown]: 2.0.1 reports a provenance attestation, the previous version did not
- event 2025-08-19 dependency_provenance_removed 0.7.41 [unknown]: 0.7.41 reports no provenance attestation, the previous version did
- event 2025-09-09 dependency_provenance_added 2.0.5 [unknown]: 2.0.5 reports a provenance attestation, the previous version did not
- limits: only the newest 20 of 94 versions are kept

## pypi:django

- why: PyPI exposes no publisher history
- status ok; 445 versions, latest 6.1.2; resolved 4.2.7
- repository: declared https://github.com/django/django -> django/django; homepage n/a; deps.dev github.com/django/django; correspondence **likely** (only the registry's own claim names django/django; no second source corroborates it)
- maintainers NOW (current state): unavailable; provenance reported on latest: false (0 of the sampled versions)
- events: none in the sampled window
- limits: only the newest 20 of 445 versions are kept; PyPI exposes neither maintainers nor per-version publishers through this API; PyPI attestations are not read by this version

## pypi:requests

- why: PyPI exposes no publisher history
- status ok; 163 versions, latest 2.34.2; resolved 2.31.0
- repository: declared https://github.com/psf/requests -> psf/requests; homepage n/a; deps.dev github.com/psf/requests; correspondence **likely** (only the registry's own claim names psf/requests; no second source corroborates it)
- maintainers NOW (current state): unavailable; provenance reported on latest: false (0 of the sampled versions)
- event 2025-06-09 dependency_dormancy_ended 2.32.4 [after]: version 2.32.4 was published 376 days after the previous one
- limits: only the newest 20 of 163 versions are kept; PyPI exposes neither maintainers nor per-version publishers through this API; PyPI attestations are not read by this version

## pypi:urllib3

- why: PyPI exposes no publisher history
- status ok; 109 versions, latest 2.8.0; resolved 2.0.7
- repository: declared https://github.com/urllib3/urllib3 -> urllib3/urllib3; homepage n/a; deps.dev github.com/urllib3/urllib3, github.com/urllib3/urllib3; correspondence **likely** (only the registry's own claim names urllib3/urllib3; no second source corroborates it)
- maintainers NOW (current state): unavailable; provenance reported on latest: false (0 of the sampled versions)
- events: none in the sampled window
- limits: only the newest 20 of 109 versions are kept; PyPI exposes neither maintainers nor per-version publishers through this API; PyPI attestations are not read by this version

