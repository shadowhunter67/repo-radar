# Retrieval probe: retrieval-v3

Targeted retrieval: ON, v3. No enrichment (OSV, deps.dev, Scorecard). Sequential.

## kubernetes/kubernetes @ d8eb59f9cbf5051df9092bac2926a0634a120eb2

- time 80039 ms, 234 HTTP requests
- tree: targeted, complete=false, reason=response_too_large, github_truncated=false, tree requests=151, nodes=1942, directories listed=149, unread=501, stopped_by=request_budget, failed=0
- coverage: manifest=targeted, lockfile=targeted, sbom=targeted, ci=targeted, build_config=targeted, source=sampled, documentation=partial, release_metadata=complete
- recovered: 24 manifests (monorepo), 0 workflows, 0 build projects, 1 execution hooks, 1212 dependencies; source scan 9% / 64 files
- identity v2 primary: cli (0.63)
- first unread: pkg/api/job, pkg/api/legacyscheme, pkg/api/node, pkg/api/persistentvolume, pkg/api/persistentvolumeclaim, pkg/api/pod, pkg/api/resourceclaimspec, pkg/api/service, pkg/api/servicecidr, pkg/api/storage

## apache/flink @ 12b0ecfef57524ccfef8398f03bfef4110b98ce8

- time 85178 ms, 261 HTTP requests
- tree: targeted, complete=false, reason=response_too_large, github_truncated=false, tree requests=174, nodes=691, directories listed=148, unread=165, stopped_by=request_budget, failed=0
- coverage: manifest=targeted, lockfile=targeted, sbom=targeted, ci=targeted, build_config=targeted, source=sampled, documentation=partial, release_metadata=complete
- recovered: 24 manifests (multi_module), 10 workflows, 21 build projects, 12 execution hooks, 197 dependencies; source scan 32% / 74 files
- identity v2 primary: library (0.53)
- first unread: flink-metrics/flink-metrics-dropwizard, flink-metrics/flink-metrics-graphite, flink-metrics/flink-metrics-influxdb, flink-metrics/flink-metrics-jmx, flink-metrics/flink-metrics-otel, flink-metrics/flink-metrics-prometheus, flink-metrics/flink-metrics-slf4j, flink-metrics/flink-metrics-statsd, flink-models/flink-model-openai, flink-models/flink-model-triton

## torvalds/linux @ 24a19b953e2a3d0ea5a8c4951a0ab8f32720c907

- time 143934 ms, 224 HTTP requests
- tree: targeted, complete=false, reason=response_too_large, github_truncated=false, tree requests=165, nodes=16730, directories listed=129, unread=740, stopped_by=time_budget, failed=0
- coverage: manifest=targeted, lockfile=targeted, sbom=targeted, ci=targeted, build_config=targeted, source=sampled, documentation=partial, release_metadata=complete
- recovered: 0 manifests (unknown), 0 workflows, 0 build projects, 21 execution hooks, 5 dependencies; source scan 0% / 42 files
- identity v2 primary: unknown (0.15)
- first unread: drivers/rapidio, drivers/ras, drivers/regulator, drivers/remoteproc, drivers/resctrl, drivers/reset, drivers/rpmsg, drivers/rtc, drivers/s390, drivers/sbus

## NixOS/nixpkgs @ 4f95d613a03654375c3d2dfed4923a17c6dde0a1

- time 100867 ms, 215 HTTP requests
- tree: targeted, complete=false, reason=response_too_large, github_truncated=false, tree requests=114, nodes=2306, directories listed=114, unread=1273, stopped_by=request_budget, failed=0
- coverage: manifest=targeted, lockfile=targeted, sbom=targeted, ci=targeted, build_config=targeted, source=sampled, documentation=partial, release_metadata=complete
- recovered: 2 manifests (workspace), 17 workflows, 0 build projects, 0 execution hooks, 19 dependencies; source scan 55% / 61 files
- identity v2 primary: library (0.38)
- first unread: pkgs/build-support/fetchbzr, pkgs/build-support/fetchcodeberg, pkgs/build-support/fetchcvs, pkgs/build-support/fetchdarcs, pkgs/build-support/fetchdebianpatch, pkgs/build-support/fetchdocker, pkgs/build-support/fetchfirefoxaddon, pkgs/build-support/fetchfossil, pkgs/build-support/fetchgit, pkgs/build-support/fetchgitea

